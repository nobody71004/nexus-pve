#!/usr/bin/env python3
"""Nexus Shield — edge DDoS mitigator for the demo relay.

The box this runs on is the public ingress for the home demo/Demo Game stack.
It keeps the existing WireGuard DNAT path intact, but puts a stateful filter in
front of it: malformed traffic is dropped before it reaches conntrack, every
forwarded port gets a packet/connection ceiling, and a sampled top-talker list
can ban a source automatically. The nftables rules and the blocklist live here,
not in the desktop app, so protection continues while the app is closed.

Control surface is loopback-only and bearer-token protected:
    GET  /health              liveness (no token)
    GET  /status              telemetry + effective policy
    GET  /rules               the exact nftables ruleset in force
    POST /mode                {"mode":"observe|defend|lockdown"}
    POST /ban                 {"ip":"...","seconds":3600,"reason":"..."}
    POST /unban               {"ip":"..."}
    POST /allow               {"ip":"...","add":true}
    POST /config              {"config":{...}}
    POST /reload
"""
from __future__ import annotations

import argparse
import hmac
import ipaddress
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

CONFIG_PATH = Path("/etc/nexus-shield/config.json")
STATE_PATH = Path("/var/lib/nexus-shield/state.json")
BLOCKED_PATH = Path("/var/lib/nexus-shield/blocked.json")
INCIDENT_PATH = Path("/var/lib/nexus-shield/incidents.json")
NFT = shutil.which("nft") or "/usr/sbin/nft"
MODES = ("observe", "defend", "lockdown")
TABLE = "nexus_edge"
NAT = "nexus_nat"

DEFAULT_CONFIG: dict[str, Any] = {
    "version": 1,
    "mode": "defend",
    "wan": "eth0",
    "wireguardInterface": "wg0",
    "wireguardPort": 51820,
    "adminPort": 22,
    "apiPort": 8791,
    "apiToken": "",
    "publicIp": "",
    "autoBan": True,
    "pollSeconds": 2,
    "allowlist": ["192.0.2.14"],
    "limits": {
        "udpPps": 4000,
        "tcpNewPerSec": 80,
        "autoBanPps": 1200,
        "blockSeconds": 3600,
        "autoBanSamples": 3,
    },
    "forwards": [],
}


def log(message: str) -> None:
    print(f"[nexus-shield] {message}", flush=True)


def now() -> float:
    return time.time()


def run(cmd: list[str], timeout: int = 20) -> subprocess.CompletedProcess[str]:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def fail(message: str) -> None:
    raise RuntimeError(message)


def validate_ip(raw: Any, *, allow_private: bool = True) -> str:
    try:
        ip = ipaddress.ip_address(str(raw).strip())
    except ValueError as exc:
        raise ValueError(f"not an IP address: {raw}") from exc
    if ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified:
        raise ValueError(f"refusing loopback/link-local/multicast address: {ip}")
    if not allow_private and ip.is_private:
        raise ValueError(f"refusing private address: {ip}")
    return str(ip)


def expand_ports(ports: Any) -> list[int]:
    out: list[int] = []
    if not isinstance(ports, list) or not ports:
        raise ValueError("ports must be a non-empty list")
    for item in ports:
        if not isinstance(item, dict):
            raise ValueError("each port range must be an object")
        start = int(item.get("from", 0))
        end = int(item.get("to", start))
        if start < 1 or end > 65535 or start > end:
            raise ValueError(f"invalid port range {start}-{end}")
        out.extend(range(start, end + 1))
    return out


def port_expr(ports: Any) -> str:
    values = expand_ports(ports)
    return "{ " + ", ".join(str(port) for port in values) + " }"


def merged_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if not raw:
        return cfg
    for key, value in raw.items():
        if key == "limits" and isinstance(value, dict):
            cfg["limits"].update(value)
        else:
            cfg[key] = value
    return cfg


def validate_config(raw: dict[str, Any] | None) -> dict[str, Any]:
    cfg = merged_config(raw)
    if cfg.get("mode") not in MODES:
        fail("mode must be observe, defend or lockdown")
    for key, pattern in (("wan", r"^[A-Za-z0-9_.:-]{1,32}$"), ("wireguardInterface", r"^[A-Za-z0-9_.:-]{1,32}$")):
        if not re.fullmatch(pattern, str(cfg.get(key, ""))):
            fail(f"{key} is not a valid interface name")
    for key, low, high in (("wireguardPort", 1, 65535), ("adminPort", 1, 65535), ("apiPort", 1024, 65535)):
        value = int(cfg.get(key, 0))
        if value < low or value > high:
            fail(f"{key} must be {low}-{high}")
        cfg[key] = value
    if not isinstance(cfg.get("forwards"), list):
        fail("forwards must be a list")
    seen: set[str] = set()
    for entry in cfg["forwards"]:
        if not isinstance(entry, dict):
            fail("each forward must be an object")
        fid = str(entry.get("id", "")).strip()
        if not fid or not re.fullmatch(r"[A-Za-z0-9_.-]{1,64}", fid):
            fail("forward id must be 1-64 safe characters")
        if fid in seen:
            fail(f"duplicate forward id: {fid}")
        seen.add(fid)
        if entry.get("proto") not in ("tcp", "udp"):
            fail(f"{fid}: proto must be tcp or udp")
        expand_ports(entry.get("ports"))
        if entry.get("pps") is not None:
            value = int(entry["pps"])
            if value < 50 or value > 200000:
                fail(f"{fid}: pps must be 50-200000")
            entry["pps"] = value
        target = str(entry.get("target", "")).strip()
        try:
            ipaddress.IPv4Address(target)
        except ValueError as exc:
            raise ValueError(f"{fid}: target must be an IPv4 address") from exc
        entry["id"] = fid
        entry["target"] = target
        entry["enabled"] = bool(entry.get("enabled", True))
        entry["label"] = str(entry.get("label", fid))[:80]
    if not isinstance(cfg.get("allowlist"), list):
        fail("allowlist must be a list")
    cfg["allowlist"] = [validate_ip(item) for item in cfg["allowlist"]]
    limits = cfg["limits"]
    checks = {
        "udpPps": (50, 200000),
        "tcpNewPerSec": (5, 20000),
        "autoBanPps": (100, 200000),
        "blockSeconds": (60, 604800),
        "autoBanSamples": (2, 60),
    }
    for key, (low, high) in checks.items():
        value = int(limits.get(key, 0))
        if value < low or value > high:
            fail(f"limits.{key} must be {low}-{high}")
        limits[key] = value
    cfg["pollSeconds"] = max(1, min(10, int(cfg.get("pollSeconds", 2))))
    cfg["autoBan"] = bool(cfg.get("autoBan", True))
    cfg["version"] = 1
    return cfg


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return fallback


def write_json(path: Path, value: Any, mode: int = 0o600) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, indent=2) + "\n")
    os.chmod(tmp, mode)
    tmp.replace(path)


def public_ip(wan: str) -> str:
    result = run(["ip", "-4", "route", "get", "8.8.8.8"], timeout=5)
    match = re.search(r"\bsrc\s+(\d+\.\d+\.\d+\.\d+)", result.stdout or "")
    if match:
        return match.group(1)
    result = run(["ip", "-4", "-o", "addr", "show", "dev", wan], timeout=5)
    match = re.search(r"\binet\s+(\d+\.\d+\.\d+\.\d+)", result.stdout or "")
    return match.group(1) if match else ""


class Shield:
    def __init__(self, path: Path, apply: bool = True):
        self.path = path
        self.lock = threading.RLock()
        self.started = now()
        self.cfg = validate_config(read_json(path, {}))
        self.mode: str = self.cfg["mode"]
        self.tight = False
        self.tight_until = 0.0
        self.blocked: dict[str, float] = {}
        self.incidents: list[dict[str, Any]] = read_json(INCIDENT_PATH, [])
        self.state: dict[str, Any] = {}
        self.prev_net: tuple[float, int, int, int, int] | None = None
        self.prev_cpu: tuple[int, int] | None = None
        self.prev_sources: dict[str, tuple[float, int, int]] = {}
        self.streaks: dict[str, int] = {}
        self.samples: list[dict[str, Any]] = []
        self.last_rate_drops = 0
        self._load_blocked()
        if apply:
            self.apply_rules()
            self.sample()

    # ------------------------------------------------------------- persistence

    def _load_blocked(self) -> None:
        raw = read_json(BLOCKED_PATH, {})
        stamp = now()
        for address, expiry in raw.items():
            try:
                if float(expiry) > stamp:
                    self.blocked[validate_ip(address)] = float(expiry)
            except (ValueError, TypeError):
                continue

    def _save_blocked(self) -> None:
        write_json(BLOCKED_PATH, self.blocked)

    def event(self, kind: str, message: str) -> None:
        self.incidents.append({"at": int(now() * 1000), "kind": kind, "message": message})
        self.incidents = self.incidents[-200:]
        write_json(INCIDENT_PATH, self.incidents)

    def save_config(self) -> None:
        write_json(self.path, self.cfg)

    # --------------------------------------------------------------- nftables

    def _rate_rules(self) -> list[str]:
        limits = self.cfg["limits"]
        udp = max(50, int(limits["udpPps"] * (0.5 if self.tight else 1)))
        tcp = max(5, int(limits["tcpNewPerSec"] * (0.5 if self.tight else 1)))
        rules: list[str] = []
        for entry in self.cfg["forwards"]:
            if not entry.get("enabled", True):
                continue
            ports = port_expr(entry["ports"])
            fid = entry["id"]
            if entry["proto"] == "udp":
                ceiling = max(50, int(entry.get("pps") or limits["udpPps"]))
                ceiling = max(50, int(ceiling * (0.5 if self.tight else 1)))
                rules.append(
                    f'udp dport {ports} limit rate over {ceiling}/second burst {ceiling * 2} packets '
                    f'counter drop comment "nexus:rate:{fid}"'
                )
            else:
                rules.append(
                    f'ct state new tcp dport {ports} limit rate over {tcp}/second burst {tcp * 2} packets '
                    f'counter drop comment "nexus:rate:{fid}"'
                )
        return rules

    def ruleset(self) -> str:
        cfg = self.cfg
        wan = cfg["wan"]
        wg = cfg["wireguardInterface"]
        allow = " ".join(cfg["allowlist"])
        rate_rules = "\n        ".join(self._rate_rules()) if self.cfg["mode"] != "observe" else ""
        nat_rules: list[str] = []
        for entry in cfg["forwards"]:
            if not entry.get("enabled", True):
                continue
            nat_rules.append(
                f'iifname "{wan}" {entry["proto"]} dport {port_expr(entry["ports"])} dnat to {entry["target"]}'
            )
        nat_block = "\n        ".join(nat_rules)
        return f"""#!/usr/sbin/nft -f
# Generated by nexus-shieldd — do not edit by hand. The daemon rewrites this.
table inet {TABLE}
delete table inet {TABLE}
table inet {TABLE} {{
    set blocked4 {{ type ipv4_addr; flags timeout; }}
    set allowed4 {{ type ipv4_addr; }}

    chain prerouting {{
        type filter hook prerouting priority -150; policy accept;
        iifname != "{wan}" return
        ip saddr @allowed4 return
        ip saddr @blocked4 counter drop comment "nexus:blocked"
        ct state invalid counter drop comment "nexus:invalid"
        ip frag-off & 0x1fff != 0 counter drop comment "nexus:fragments"
        tcp flags & (fin|syn|rst|psh|ack|urg) == 0x0 counter drop comment "nexus:malformed"
        tcp flags & (fin|syn) == (fin|syn) counter drop comment "nexus:malformed"
        tcp flags & (syn|rst) == (syn|rst) counter drop comment "nexus:malformed"
        tcp flags & (fin|rst) == (fin|rst) counter drop comment "nexus:malformed"
        {rate_rules}
        counter comment "nexus:pass"
    }}

    chain input {{
        type filter hook input priority filter; policy drop;
        ct state established,related accept
        iif lo accept
        ct state invalid counter drop comment "nexus:input-invalid"
        ip protocol icmp icmp type {{ destination-unreachable, time-exceeded, parameter-problem }} accept
        ip protocol icmp icmp type echo-request limit rate 10/second burst 20 packets accept
        ip protocol icmp counter drop comment "nexus:input-icmp"
        tcp dport {cfg["adminPort"]} limit rate 30/minute burst 10 packets accept
        tcp dport {cfg["adminPort"]} counter drop comment "nexus:input-admin"
        udp dport {cfg["wireguardPort"]} accept
        counter drop comment "nexus:input-drop"
    }}

    chain forward {{
        type filter hook forward priority filter; policy drop;
        ct state established,related accept
        iifname "{wan}" oifname "{wg}" accept
        iifname "{wg}" oifname "{wan}" accept
        counter drop comment "nexus:forward-drop"
    }}
}}

table ip {NAT}
delete table ip {NAT}
table ip {NAT} {{
    chain prerouting {{
        type nat hook prerouting priority dstnat; policy accept;
        {nat_block}
    }}

    chain postrouting {{
        type nat hook postrouting priority srcnat; policy accept;
        oifname "{wg}" masquerade
        oifname "{wg}" tcp flags syn tcp option maxseg size set 1240
    }}
}}
"""

    def apply_rules(self) -> None:
        with self.lock:
            script = self.ruleset()
            path = Path("/run/nexus-shield.nft")
            path.write_text(script)
            check = run([NFT, "-c", "-f", str(path)], timeout=25)
            if check.returncode != 0:
                fail(f"nft check failed: {check.stderr.strip() or check.stdout.strip()}")
            applied = run([NFT, "-f", str(path)], timeout=25)
            if applied.returncode != 0:
                fail(f"nft apply failed: {applied.stderr.strip() or applied.stdout.strip()}")
            self._restore_sets()
            self.event("config", f"{self.mode} rules applied{' (tightened)' if self.tight else ''}")

    def _set_add(self, name: str, address: str, timeout: int | None = None) -> None:
        command = [NFT, "add", "element", "inet", TABLE, name, "{", address]
        if timeout:
            command.extend(["timeout", f"{timeout}s"])
        command.append("}")
        result = run(command, timeout=8)
        if result.returncode != 0 and "File exists" not in (result.stderr or ""):
            fail(result.stderr.strip() or f"could not add {address} to {name}")

    def _set_delete(self, name: str, address: str) -> None:
        result = run([NFT, "delete", "element", "inet", TABLE, name, "{", address, "}"], timeout=8)
        error = result.stderr or ""
        if result.returncode != 0 and not any(
            marker in error for marker in ("No such file", "does not exist", "No such file or directory")
        ):
            fail(error.strip() or f"could not remove {address} from {name}")

    def _restore_sets(self) -> None:
        for address in self.cfg["allowlist"]:
            self._set_add("allowed4", address)
        stamp = now()
        for address, expiry in list(self.blocked.items()):
            if expiry <= stamp:
                self.blocked.pop(address, None)
                continue
            seconds = max(30, int(expiry - stamp))
            self._set_add("blocked4", address, seconds)
        self._save_blocked()

    # ------------------------------------------------------------- operations

    def set_mode(self, mode: str) -> None:
        if mode not in MODES:
            fail("mode must be observe, defend or lockdown")
        with self.lock:
            self.mode = mode
            self.cfg["mode"] = mode
            self.save_config()
            self.apply_rules()
            self.event("mode", f"mode set to {mode}")
            self.sample()

    def ban(self, address: str, seconds: int | None = None, reason: str = "manual") -> None:
        ip = validate_ip(address)
        with self.lock:
            if ip in self.cfg["allowlist"]:
                fail(f"{ip} is allowlisted; remove it from the allowlist first")
            duration = int(seconds or self.cfg["limits"]["blockSeconds"])
            duration = max(30, min(604800, duration))
            expiry = now() + duration
            self._set_add("blocked4", ip, duration)
            self.blocked[ip] = expiry
            self._save_blocked()
            self.event("ban", f"banned {ip} for {duration}s ({reason})")

    def unban(self, address: str) -> None:
        ip = validate_ip(address)
        with self.lock:
            self._set_delete("blocked4", ip)
            self.blocked.pop(ip, None)
            self._save_blocked()
            self.event("unban", f"unbanned {ip}")

    def allow(self, address: str, add: bool = True) -> None:
        ip = validate_ip(address)
        with self.lock:
            if add:
                if ip not in self.cfg["allowlist"]:
                    self.cfg["allowlist"].append(ip)
                self._set_add("allowed4", ip)
                self.event("allow", f"allowlisted {ip}")
            else:
                self.cfg["allowlist"] = [item for item in self.cfg["allowlist"] if item != ip]
                self._set_delete("allowed4", ip)
                self.event("allow", f"removed {ip} from the allowlist")
            self.save_config()

    def replace_config(self, raw: dict[str, Any]) -> None:
        with self.lock:
            token = str(self.cfg.get("apiToken", ""))
            cfg = validate_config(raw)
            cfg["apiToken"] = token
            self.cfg = cfg
            self.mode = cfg["mode"]
            self.tight = False
            self.tight_until = 0.0
            self.save_config()
            self.apply_rules()
            self.event("config", "configuration replaced")
            self.sample()

    def reload(self) -> None:
        with self.lock:
            self.cfg = validate_config(read_json(self.path, {}))
            self.mode = self.cfg["mode"]
            self.apply_rules()
            self.event("config", "configuration reloaded from disk")
            self.sample()

    # -------------------------------------------------------------- telemetry

    def _netdev(self) -> tuple[int, int, int, int]:
        try:
            with open("/proc/net/dev", "r", encoding="utf-8") as handle:
                for line in handle:
                    name, _, values = line.partition(":")
                    if name.strip() != self.cfg["wan"]:
                        continue
                    fields = values.split()
                    return int(fields[0]), int(fields[1]), int(fields[8]), int(fields[9])
        except (OSError, IndexError, ValueError):
            pass
        return 0, 0, 0, 0

    def _cpu(self) -> tuple[int, int]:
        try:
            with open("/proc/stat", "r", encoding="utf-8") as handle:
                values = [int(value) for value in handle.readline().split()[1:9]]
            idle = values[3] + values[4]
            return sum(values), idle
        except (OSError, ValueError, IndexError):
            return 0, 0

    def _memory_pct(self) -> float:
        try:
            data = Path("/proc/meminfo").read_text()
            total = int(re.search(r"MemTotal:\s+(\d+)", data).group(1))  # type: ignore[union-attr]
            available = int(re.search(r"MemAvailable:\s+(\d+)", data).group(1))  # type: ignore[union-attr]
            return round((1 - available / total) * 100, 1) if total else 0.0
        except (OSError, ValueError, AttributeError):
            return 0.0

    def _conntrack(self) -> tuple[int, int]:
        try:
            count = int(Path("/proc/sys/net/netfilter/nf_conntrack_count").read_text().strip())
            maximum = int(Path("/proc/sys/net/netfilter/nf_conntrack_max").read_text().strip())
            return count, maximum
        except (OSError, ValueError):
            return 0, 0

    def _conntrack_lines(self):
        # Extended output carries packets= and bytes= when conntrack accounting
        # is on. The procfs table is a fallback for hosts without the tool.
        try:
            result = run(["conntrack", "-L", "-o", "extended"], timeout=8)
        except (OSError, subprocess.SubprocessError):
            result = None
        if result is not None and result.returncode == 0:
            for index, line in enumerate((result.stdout or "").splitlines()):
                if index > 200_000:
                    break
                yield line
            return
        proc = Path("/proc/net/nf_conntrack")
        if not proc.exists():
            return
        try:
            with proc.open("r", encoding="utf-8", errors="replace") as handle:
                for index, line in enumerate(handle):
                    if index > 200_000:
                        break
                    yield line
        except OSError:
            return

    def _top_sources(self) -> list[dict[str, Any]]:
        stamp = now()
        rows: dict[str, tuple[int, int, int]] = {}
        for line in self._conntrack_lines():
            src = re.search(r"\bsrc=(\d+\.\d+\.\d+\.\d+)", line)
            if not src:
                continue
            packets = re.search(r"\bpackets=(\d+)", line)
            octets = re.search(r"\bbytes=(\d+)", line)
            address = src.group(1)
            previous = rows.get(address, (0, 0, 0))
            rows[address] = (
                previous[0] + (int(packets.group(1)) if packets else 0),
                previous[1] + (int(octets.group(1)) if octets else 0),
                previous[2] + 1,
            )

        sources: list[dict[str, Any]] = []
        for address, (packets, octets, connections) in rows.items():
            before = self.prev_sources.get(address)
            delta_packets = packets - before[1] if before else 0
            delta_bytes = octets - before[2] if before else 0
            elapsed = max(0.5, stamp - before[0]) if before else self.cfg["pollSeconds"]
            pps = max(0.0, delta_packets / elapsed)
            bps = max(0.0, (delta_bytes * 8) / elapsed)
            sources.append(
                {
                    "ip": address,
                    "pps": round(pps, 1),
                    "bps": round(bps, 1),
                    "connections": connections,
                    "blocked": address in self.blocked,
                    "allowlisted": address in self.cfg["allowlist"],
                }
            )
        self.prev_sources = {address: (stamp, values[0], values[1]) for address, values in rows.items()}
        sources.sort(key=lambda item: item["pps"], reverse=True)
        return sources[:12]

    def _drops(self) -> dict[str, int]:
        totals = {"invalid": 0, "blocked": 0, "rate": 0, "total": 0, "malformed": 0, "fragments": 0}
        result = run([NFT, "-j", "list", "table", "inet", TABLE], timeout=10)
        if result.returncode != 0:
            return totals
        try:
            payload = json.loads(result.stdout or "{}")
        except ValueError:
            return totals
        for item in payload.get("nftables", []):
            rule = item.get("rule")
            if not isinstance(rule, dict):
                continue
            comment = str(rule.get("comment", ""))
            if not comment.startswith("nexus:"):
                continue
            packets = 0
            for expr in rule.get("expr", []):
                if isinstance(expr, dict) and isinstance(expr.get("counter"), dict):
                    packets = int(expr["counter"].get("packets", 0))
                    break
            kind = comment.split(":", 2)[1]
            if kind in totals:
                totals[kind] += packets
            totals["total"] += packets
        return totals

    def _blocked_list(self) -> list[str]:
        result = run([NFT, "-j", "list", "set", "inet", TABLE, "blocked4"], timeout=10)
        if result.returncode != 0:
            return sorted(self.blocked)
        try:
            payload = json.loads(result.stdout or "{}")
        except ValueError:
            return sorted(self.blocked)
        out: list[str] = []
        for item in payload.get("nftables", []):
            entry = item.get("set")
            if not isinstance(entry, dict):
                continue
            for element in entry.get("elem", []) or []:
                value = element.get("elem", element) if isinstance(element, dict) else element
                if isinstance(value, dict):
                    value = value.get("val")
                if value:
                    out.append(str(value))
        return sorted(set(out))

    def sample(self) -> dict[str, Any]:
        with self.lock:
            stamp = now()
            rx_bytes, rx_packets, tx_bytes, tx_packets = self._netdev()
            if self.prev_net:
                seconds = max(0.5, stamp - self.prev_net[0])
                ingress_bps = max(0.0, (rx_bytes - self.prev_net[1]) * 8 / seconds)
                ingress_pps = max(0.0, (rx_packets - self.prev_net[2]) / seconds)
                egress_bps = max(0.0, (tx_bytes - self.prev_net[3]) * 8 / seconds)
                egress_pps = max(0.0, (tx_packets - self.prev_net[4]) / seconds)
            else:
                ingress_bps = ingress_pps = egress_bps = egress_pps = 0.0
            self.prev_net = (stamp, rx_bytes, rx_packets, tx_bytes, tx_packets)

            cpu_total, cpu_idle = self._cpu()
            if self.prev_cpu and cpu_total > self.prev_cpu[0]:
                delta_total = cpu_total - self.prev_cpu[0]
                delta_idle = cpu_idle - self.prev_cpu[1]
                cpu_pct = round(max(0.0, min(100.0, (1 - delta_idle / delta_total) * 100)), 1)
            else:
                cpu_pct = 0.0
            self.prev_cpu = (cpu_total, cpu_idle)

            sources = self._top_sources()
            drops = self._drops()
            conntrack_count, conntrack_max = self._conntrack()
            try:
                load1 = float(Path("/proc/loadavg").read_text().split()[0])
            except (OSError, ValueError, IndexError):
                load1 = 0.0
            try:
                uptime = float(Path("/proc/uptime").read_text().split()[0])
            except (OSError, ValueError, IndexError):
                uptime = stamp - self.started

            if self.cfg["mode"] != "observe" and self.cfg["autoBan"]:
                self._auto_ban(sources, stamp)

            if self.tight and stamp > self.tight_until:
                self.tight = False
                self.apply_rules()
                self.event("attack", "attack window elapsed; rate limits restored")

            self.samples.append({"t": int(stamp * 1000), "ingressBps": round(ingress_bps), "ingressPps": round(ingress_pps), "drops": drops["total"]})
            self.samples = self.samples[-120:]

            self.state = {
                "ok": True,
                "installed": True,
                "running": True,
                "mode": self.cfg["mode"],
                "tight": self.tight,
                "since": int(self.started * 1000),
                "sampledAt": int(stamp * 1000),
                "uptimeSec": int(uptime),
                "publicIp": self.cfg.get("publicIp") or public_ip(self.cfg["wan"]),
                "wan": self.cfg["wan"],
                "ingressBps": round(ingress_bps),
                "egressBps": round(egress_bps),
                "ingressPps": round(ingress_pps),
                "egressPps": round(egress_pps),
                "conntrack": {"count": conntrack_count, "max": conntrack_max},
                "cpuPct": cpu_pct,
                "memPct": self._memory_pct(),
                "load1": load1,
                "drops": drops,
                "blocked": self._blocked_list(),
                "allowlist": list(self.cfg["allowlist"]),
                "sources": sources,
                "forwards": self.cfg["forwards"],
                "limits": self.cfg["limits"],
                "autoBan": self.cfg["autoBan"],
                "recent": self.incidents[-25:],
                "health": "online",
            }
            write_json(STATE_PATH, self.state, mode=0o644)
            return self.state

    def _auto_ban(self, sources: list[dict[str, Any]], stamp: float) -> None:
        threshold = max(100, int(self.cfg["limits"]["autoBanPps"] * (0.5 if self.tight else 1)))
        for entry in sources:
            address = entry["ip"]
            if entry.get("allowlisted") or entry.get("blocked"):
                continue
            pps = float(entry.get("pps", 0))
            if pps >= threshold:
                self.streaks[address] = self.streaks.get(address, 0) + 1
            else:
                self.streaks.pop(address, None)
                continue
            if self.streaks[address] < int(self.cfg["limits"]["autoBanSamples"]):
                continue
            if len([value for value in self.blocked.values() if value > stamp]) >= 200:
                continue
            try:
                self.ban(address, self.cfg["limits"]["blockSeconds"], f"auto: {pps:.0f} pps")
            except (ValueError, RuntimeError) as exc:
                log(f"auto-ban {address} failed: {exc}")
                continue
            self.streaks.pop(address, None)
            if not self.tight:
                self.tight = True
                self.tight_until = stamp + 300
                self.apply_rules()
                self.event("attack", f"ingress spike from {address} ({pps:.0f} pps); limits tightened for 5 minutes")

    # ------------------------------------------------------------------- API

    def dispatch(self, method: str, path: str, body: dict[str, Any]) -> Any:
        if method == "GET" and path == "/health":
            return {"ok": True, "service": "nexus-shield", "mode": self.mode}
        if method == "GET" and path == "/status":
            return self.sample()
        if method == "GET" and path == "/rules":
            return self.ruleset()
        if method == "POST" and path == "/mode":
            self.set_mode(str(body.get("mode", "")))
            return self.state
        if method == "POST" and path == "/ban":
            self.ban(str(body.get("ip", "")), body.get("seconds"), str(body.get("reason", "manual")))
            return self.state
        if method == "POST" and path == "/unban":
            self.unban(str(body.get("ip", "")))
            return self.state
        if method == "POST" and path == "/allow":
            self.allow(str(body.get("ip", "")), body.get("add", True) is not False)
            return self.state
        if method == "POST" and path == "/config":
            config = body.get("config")
            if not isinstance(config, dict):
                fail("config must be an object")
            self.replace_config(config)
            return self.state
        if method == "POST" and path == "/reload":
            self.reload()
            return self.state
        fail(f"unknown route {method} {path}")


class Handler(BaseHTTPRequestHandler):
    server_version = "nexus-shield/1.0"
    shield: Shield

    def log_message(self, fmt: str, *args: Any) -> None:
        log(f"{self.address_string()} {fmt % args}")

    def _send(self, status: int, payload: Any, content_type: str = "application/json") -> None:
        if isinstance(payload, (dict, list)):
            data = json.dumps(payload).encode()
        else:
            data = str(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _authorized(self) -> bool:
        header = self.headers.get("Authorization", "")
        token = self.shield.cfg.get("apiToken", "")
        return bool(token) and hmac.compare_digest(header, f"Bearer {token}")

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/health":
            self._send(200, self.shield.dispatch("GET", "/health", {}))
            return
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        try:
            payload = self.shield.dispatch("GET", self.path.split("?", 1)[0], {})
            self._send(200, payload, "text/plain" if self.path.startswith("/rules") else "application/json")
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        if not self._authorized():
            self._send(401, {"error": "unauthorized"})
            return
        length = min(1_000_000, int(self.headers.get("Content-Length", "0") or 0))
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
            if not isinstance(body, dict):
                fail("body must be an object")
            payload = self.shield.dispatch("POST", self.path.split("?", 1)[0], body)
            self._send(200, payload)
        except Exception as exc:  # noqa: BLE001
            self._send(400, {"error": str(exc)})


def main() -> int:
    parser = argparse.ArgumentParser(description="Nexus Shield edge mitigator")
    parser.add_argument("--config", default=str(CONFIG_PATH))
    parser.add_argument("--once", action="store_true", help="apply the ruleset and print status, then exit")
    parser.add_argument("--print-rules", action="store_true", help="print the generated ruleset without applying it")
    args = parser.parse_args()

    # Per-flow byte/packet counters are what make top-talker rates and auto-ban
    # meaningful. The installer sets this too; this covers a stale sysctl drop-in
    # after a package upgrade or a manual restart.
    try:
        Path("/proc/sys/net/netfilter/nf_conntrack_acct").write_text("1\n")
    except OSError as exc:
        log(f"conntrack accounting unavailable: {exc}")

    try:
        shield = Shield(Path(args.config), apply=not args.print_rules)
    except Exception as exc:  # noqa: BLE001
        log(f"startup failed: {exc}")
        return 1

    if args.print_rules:
        print(shield.ruleset())
        return 0

    if args.once:
        print(json.dumps(shield.sample(), indent=2))
        return 0

    # The legacy relay tables are only removed after the new ruleset is live and
    # the daemon has answered its own health check. If anything above failed,
    # those tables are still in place and traffic keeps flowing.
    def adopt() -> None:
        time.sleep(1.5)
        legacy = run([NFT, "list", "tables"], timeout=10).stdout or ""
        for family, name in (("inet", "edge"), ("ip", "edge_nat")):
            if re.search(rf"table {family} {name}\b", legacy):
                result = run([NFT, "delete", "table", family, name], timeout=10)
                if result.returncode == 0:
                    shield.event("install", f"removed legacy relay table {family} {name}")
                else:
                    log(f"could not remove legacy table {family} {name}: {result.stderr.strip()}")

    threading.Thread(target=adopt, daemon=True).start()

    def loop() -> None:
        while True:
            try:
                shield.sample()
            except Exception as exc:  # noqa: BLE001
                log(f"sample failed: {exc}")
            time.sleep(max(1, int(shield.cfg.get("pollSeconds", 2))))

    threading.Thread(target=loop, daemon=True).start()

    handler = type("BoundHandler", (Handler,), {"shield": shield})
    server = ThreadingHTTPServer(("127.0.0.1", int(shield.cfg["apiPort"])), handler)
    server.daemon_threads = True

    def stop(_signum: int, _frame: Any) -> None:
        log("shutting down")
        # shutdown() blocks until serve_forever() returns, so it cannot run in
        # the signal handler's thread (which is the one inside serve_forever).
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log(f"online on 127.0.0.1:{shield.cfg['apiPort']} · mode {shield.mode} · {len(shield.cfg['forwards'])} forwards")
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
