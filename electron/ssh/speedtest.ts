import type { ConfigStore } from "../config";
import type { SpeedTestResult } from "../../shared/types";
import { runRemote } from "./probe";
import { sshRunner } from "./collect";

/**
 * Throughput probe.
 *
 * Two things made the old probe lie. It measured a single HTTPS stream, so one
 * stalled socket decided the whole result; and it pointed that stream at
 * Cloudflare's speed endpoint, which answers large requests from the same IP
 * with `403` and a one-byte body once it decides you have had enough. A host
 * with a 10 GbE link then displayed "1 Mbps".
 *
 * So: several mirrors, several streams in parallel, and only the streams that
 * actually delivered are counted. A mirror that refuses or stalls is dropped
 * instead of dragging the average down, and the aggregate is the sum of the
 * healthy streams over the longest of their durations. Anything left after that
 * is a real measurement of the path, not an artefact of one bad socket.
 *
 * Only curl is needed on the remote side. Nothing is installed and nothing is
 * written beyond a temp file that the script removes.
 */
/** Mirrors are inlined in the remote script: 3 × CacheFly (anycast), 1 × Hetzner
 *  US-East and 1 × OVH EU, so a single provider's rate limit cannot decide the
 *  result. Cloudflare's speed endpoint is deliberately absent — it answers large
 *  requests with 403 from an IP that has tested recently. */
const DOWN_SECONDS = 5;
const UP_SECONDS = 8;
const UP_BYTES = 16 * 1024 * 1024;

const SPEED_SCRIPT = `
export LC_ALL=C
if ! command -v curl >/dev/null 2>&1; then
  echo "error=curl-missing"
  exit 0
fi

TMP=$(mktemp -d 2>/dev/null) || TMP="/tmp/nexus-speed.$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "@@nic"
DEV=$(ip route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i <= NF; i++) if ($i == "dev") { print $(i + 1); exit }}')
echo "dev=$DEV"
echo "mtu=$(cat "/sys/class/net/$DEV/mtu" 2>/dev/null)"
if [ -n "$DEV" ] && command -v ethtool >/dev/null 2>&1; then
  echo "link=$(ethtool "$DEV" 2>/dev/null | awk -F': *' '/Speed:/ {print $2; exit}')"
fi

echo "@@latency"
i=0
while [ "$i" -lt 4 ]; do
  curl -4 -sS -o /dev/null -r 0-1023 --max-time 6 -w "t=%{time_connect} ttfb=%{time_starttransfer}\\n" "https://cachefly.cachefly.net/100mb.test" 2>/dev/null
  i=$((i + 1))
done

echo "@@down"
i=0
while [ "$i" -lt 5 ]; do
  case "$i" in
    0|1|2) NAME=cachefly; URL="https://cachefly.cachefly.net/100mb.test" ;;
    3) NAME=hetzner-us; URL="https://ash-speed.hetzner.com/100MB.bin" ;;
    *) NAME=ovh-eu; URL="https://proof.ovh.net/files/100Mb.dat" ;;
  esac
  (
    OUT=$(curl -4 -sS -o /dev/null --max-time ${DOWN_SECONDS} -w "%{size_download} %{time_total} %{http_code}" "$URL" 2>/dev/null)
    RC=$?
    echo "ok $NAME $OUT $RC"
  ) >"$TMP/d$i" 2>&1 &
  i=$((i + 1))
done
wait
cat "$TMP"/d* 2>/dev/null

echo "@@up"
head -c ${UP_BYTES} /dev/zero > "$TMP/up.bin" 2>/dev/null
i=0
while [ "$i" -lt 4 ]; do
  (
    OUT=$(curl -4 -sS -o /dev/null --max-time ${UP_SECONDS} -X POST --data-binary @"$TMP/up.bin" -w "%{size_upload} %{time_total} %{http_code}" "https://speed.cloudflare.com/__up" 2>/dev/null)
    RC=$?
    echo "ok cloudflare $OUT $RC"
  ) >"$TMP/u$i" 2>&1 &
  i=$((i + 1))
done
wait
cat "$TMP"/u* 2>/dev/null

echo "@@end"
`;

interface SpeedStream {
  mirror: string;
  bytes: number;
  seconds: number;
  code: number;
  aborted: boolean;
}

interface Aggregate {
  mbps: number;
  bytes: number;
  windowMs: number;
  dropped: number;
  total: number;
  endpoint?: string;
  refused: number;
}

function splitSections(text: string): Map<string, string[]> {
  const sections = new Map<string, string[]>();
  let current = "";
  for (const line of text.split(/\r?\n/)) {
    const marker = /^@@(\w+)$/.exec(line.trim());
    if (marker) {
      current = marker[1];
      sections.set(current, []);
    } else if (current) {
      sections.get(current)!.push(line);
    }
  }
  return sections;
}

function keyValue(lines: string[], key: string): string | undefined {
  for (const line of lines) {
    const match = new RegExp(`(?:^|\\s)${key}=([^\\s]+)`).exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

function parseStreams(lines: string[], capSeconds: number): SpeedStream[] {
  const streams: SpeedStream[] = [];
  for (const line of lines) {
    // ok <mirror> <bytes> <seconds> <httpCode> <curlExit>
    const match = /^ok\s+(\S+)\s+([0-9.]+)\s+([0-9.]+)\s+(\d+)\s+(-?\d+)/.exec(line.trim());
    if (!match) continue;
    const seconds = Number(match[3]);
    const code = Number(match[4]);
    streams.push({
      mirror: match[1],
      bytes: Number(match[2]),
      seconds,
      code,
      aborted: Number(match[5]) === 28 || seconds >= capSeconds * 0.95,
    });
  }
  return streams;
}

/**
 * Sum the streams that delivered, over the longest duration among them. Streams
 * that returned no real body (a blocked mirror answers with a few hundred bytes)
 * or that ran at a fraction of the median rate (a throttled or stalled socket)
 * are dropped from both the numerator and the window.
 */
function aggregate(streams: SpeedStream[], minBytes: number): Aggregate {
  const refused = streams.filter((stream) => stream.code === 403 || stream.code === 429).length;
  const delivered = streams.filter((stream) => stream.bytes >= minBytes && stream.seconds > 0);
  if (delivered.length === 0) {
    return { mbps: 0, bytes: 0, windowMs: 0, dropped: streams.length, total: streams.length, refused };
  }
  const rates = delivered.map((stream) => stream.bytes / Math.max(stream.seconds, 0.001));
  const sorted = [...rates].sort((a, b) => a - b);
  const median = sorted.length % 2 === 0 ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2 : sorted[Math.floor(sorted.length / 2)];
  const kept = delivered.filter((_stream, index) => rates[index] >= median * 0.25);
  // Parallel aggregate is the sum of each stream's own rate: streams that
  // started together and finish at different times then still add up honestly,
  // where bytes / longest-duration would penalise the fast ones.
  const bytes = kept.reduce((sum, stream) => sum + stream.bytes, 0);
  const seconds = kept.reduce((max, stream) => Math.max(max, stream.seconds), 0);
  const mbps = kept.reduce((sum, stream) => sum + (stream.bytes * 8) / Math.max(stream.seconds, 0.001) / 1_000_000, 0);
  let endpoint: string | undefined;
  let bestRate = 0;
  for (const [index, stream] of delivered.entries()) {
    if (rates[index] > bestRate) {
      bestRate = rates[index];
      endpoint = stream.mirror;
    }
  }
  return {
    mbps: Math.round(mbps * 10) / 10,
    bytes,
    windowMs: Math.round(seconds * 1000),
    dropped: streams.length - kept.length,
    total: streams.length,
    endpoint,
    refused,
  };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function linkMbps(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([MGTP])?b\/s$/i.exec(raw.trim());
  if (!match) return undefined;
  const scale = { M: 1, G: 1_000, T: 1_000_000, P: 1_000_000_000 }[match[2]?.toUpperCase() as "M" | "G" | "T" | "P"] ?? 1_000_000;
  return Math.round(Number(match[1]) * scale);
}

export async function runSpeedTest(store: ConfigStore, id: string): Promise<SpeedTestResult> {
  const host = store.sshHost(id);
  if (!host) throw new Error(`Unknown Linux host: ${id}`);
  const started = Date.now();
  const base = { hostId: host.id, label: host.label, at: started, downMbps: 0, upMbps: 0, latencyMs: 0, bytes: 0 };

  try {
    const result = await runRemote(sshRunner(store, id, 90_000), SPEED_SCRIPT, "bash");
    if (/error=curl-missing/.test(result.stdout)) {
      return { ...base, error: "curl is not installed on this host" };
    }
    if (!result.ok) {
      return { ...base, error: (result.stderr || "speed test failed").trim().split(/\r?\n/).slice(-1)[0] };
    }

    const sections = splitSections(result.stdout);
    const nic = sections.get("nic") ?? [];
    const downStreams = parseStreams(sections.get("down") ?? [], DOWN_SECONDS);
    const upStreams = parseStreams(sections.get("up") ?? [], UP_SECONDS);
    const down = aggregate(downStreams, 1024 * 1024);
    const up = aggregate(upStreams, 256 * 1024);
    const latencySamples = (sections.get("latency") ?? [])
      .map((line) => Number(/t=([0-9.]+)/.exec(line)?.[1] ?? 0))
      .filter((value) => value > 0)
      .map((value) => value * 1000);

    const probe: SpeedTestResult = {
      ...base,
      downMbps: down.mbps,
      upMbps: up.mbps,
      latencyMs: Math.round(median(latencySamples)),
      bytes: down.bytes,
      linkMbps: linkMbps(keyValue(nic, "link")),
      device: keyValue(nic, "dev") ?? undefined,
      endpoint: down.endpoint,
      streams: downStreams.length || undefined,
      jitterMs: latencySamples.length > 1 ? Math.round((Math.max(...latencySamples) - Math.min(...latencySamples)) * 10) / 10 : 0,
      cutStreams: down.dropped,
      windowMs: down.windowMs,
    };

    if (down.bytes === 0) {
      probe.error = down.refused === down.total && down.total > 0
        ? "every mirror refused the transfer — the host may be rate limited or blocked"
        : "no mirror returned data";
    }
    return probe;
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function runSpeedTestAll(store: ConfigStore, hostIds?: string[]): Promise<SpeedTestResult[]> {
  const allowed = hostIds ? new Set(hostIds) : null;
  const hosts = store.sshHosts().filter((host) => !allowed || allowed.has(host.id));
  return Promise.all(hosts.map((host) => runSpeedTest(store, host.id)));
}
