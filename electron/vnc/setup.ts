import type { ConfigStore } from "../config";
import type { VncSetupResult } from "../../shared/fabric-types";
import { runElevated } from "../ssh/helper";

const SERVICE = "nexus-vnc-console.service";
const LIB = "/usr/local/lib/nexus-vnc";
const UNIT_FILE = `/etc/systemd/system/${SERVICE}`;

function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function renderFailureHint(failure: string | undefined): string {
  switch (failure) {
    case "no-root-route":
      return "This host did not allow root. Enter its sudo password once, then retry.";
    case "systemd-required":
      return "The host is not running systemd, so a boot-persistent console cannot be installed.";
    case "unsupported-package-manager":
      return "No supported package manager was found. This installer supports apt, dnf, yum, pacman, zypper and apk.";
    case "service-conflict":
      return "An unrelated nexus-vnc-console.service already exists on the host; refusing to overwrite it.";
    case "unknown-user":
      return "The SSH login account does not exist on the host.";
    case "no-port":
      return "No free loopback VNC port is available in 5901-5999.";
    case "packages-unavailable":
      return "Neither the sway/wayvnc/foot stack nor the TigerVNC fallback could be installed.";
    case "vnc-not-starting":
      return "The packages installed, but the host console did not start. Check the service log shown below.";
    default:
      return failure ? `The host installer refused: ${failure}` : "The host console could not be installed.";
  }
}

/**
 * Shell payload executed as root through runElevated. It writes a system-level
 * unit rather than a user unit so the console survives reboots without needing
 * lingering user-manager sessions. The RFB listener is hard-coded to loopback;
 * the app reaches it only through its SSH tunnel.
 */
export function renderVncSetupScript(username: string): string {
  return [
    "set -eu",
    "export LC_ALL=C",
    "umask 022",
    `NX_USER=${shQuote(username)}`,
    `SERVICE=${SERVICE}`,
    `LIB=${LIB}`,
    `UNIT_FILE=${UNIT_FILE}`,
    "RUNDIR=/run/nexus-vnc",
    "LOG=/tmp/nexus-vnc-install.log",
    "say() { printf '%s\n' \"$*\"; }",
    "fail() { printf '@@fail=%s\n' \"$1\"; exit 32; }",
    "port_busy() {",
    "  if command -v ss >/dev/null 2>&1; then",
    "    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE \"[:.]$1$\"",
    "  elif command -v netstat >/dev/null 2>&1; then",
    "    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE \"[:.]$1$\"",
    "  else",
    "    return 1",
    "  fi",
    "}",
    "port_ready() {",
    "  if command -v ss >/dev/null 2>&1; then",
    "    ss -ltnH 2>/dev/null | awk '{print $4}' | grep -qE \"127\\\\.0\\\\.0\\\\.1:$1$\"",
    "  elif command -v netstat >/dev/null 2>&1; then",
    "    netstat -ltn 2>/dev/null | awk '{print $4}' | grep -qE \"127\\\\.0\\\\.0\\\\.1:$1$\"",
    "  else",
    "    return 1",
    "  fi",
    "}",
    "have_wayland() {",
    "  command -v sway >/dev/null 2>&1 && command -v wayvnc >/dev/null 2>&1 && command -v foot >/dev/null 2>&1",
    "}",
    "have_x11() {",
    "  if ! command -v Xtigervnc >/dev/null 2>&1 && ! command -v Xvnc >/dev/null 2>&1; then return 1; fi",
    "  command -v xterm >/dev/null 2>&1",
    "}",
    "install_wayland() {",
    "  : >\"$LOG\"",
    "  case \"$PM\" in",
    "    apt) DEBIAN_FRONTEND=noninteractive apt-get update -qq >>\"$LOG\" 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends sway wayvnc foot >>\"$LOG\" 2>&1 ;;",
    "    dnf) dnf install -y sway wayvnc foot >>\"$LOG\" 2>&1 ;;",
    "    yum) yum install -y sway wayvnc foot >>\"$LOG\" 2>&1 ;;",
    "    pacman) pacman -Sy --noconfirm --needed sway wayvnc foot >>\"$LOG\" 2>&1 ;;",
    "    zypper) zypper --non-interactive install -y sway wayvnc foot >>\"$LOG\" 2>&1 ;;",
    "    apk) apk add --no-cache sway wayvnc foot >>\"$LOG\" 2>&1 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "install_x11() {",
    "  : >\"$LOG\"",
    "  case \"$PM\" in",
    "    apt) DEBIAN_FRONTEND=noninteractive apt-get update -qq >>\"$LOG\" 2>&1 || true; DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends tigervnc-standalone-server xterm openbox >>\"$LOG\" 2>&1 ;;",
    "    dnf) dnf install -y tigervnc-server xterm openbox >>\"$LOG\" 2>&1 ;;",
    "    yum) yum install -y tigervnc-server xterm openbox >>\"$LOG\" 2>&1 ;;",
    "    pacman) pacman -Sy --noconfirm --needed tigervnc xterm openbox >>\"$LOG\" 2>&1 ;;",
    "    zypper) zypper --non-interactive install -y tigervnc xterm openbox >>\"$LOG\" 2>&1 ;;",
    "    apk) apk add --no-cache tigervnc xterm openbox >>\"$LOG\" 2>&1 ;;",
    "    *) return 1 ;;",
    "  esac",
    "}",
    "start_service() {",
    "  systemctl restart \"$SERVICE\" >/dev/null 2>&1 || true",
    "  i=0",
    "  while [ \"$i\" -lt 40 ]; do",
    "    if systemctl is-active --quiet \"$SERVICE\" && port_ready \"$PORT\"; then return 0; fi",
    "    i=$((i + 1))",
    "    sleep 0.5",
    "  done",
    "  return 1",
    "}",
    "report_failure() {",
    "  systemctl --no-pager --full status \"$SERVICE\" 2>&1 | tail -n 12 || true",
    "  for file in \"$RUNDIR\"/sway.log \"$RUNDIR\"/wayvnc.log \"$RUNDIR\"/x11.log; do",
    "    [ -f \"$file\" ] || continue",
    "    say \"--- $file\"",
    "    tail -n 8 \"$file\" 2>/dev/null || true",
    "  done",
    "}",
    "if ! command -v systemctl >/dev/null 2>&1 || [ ! -d /run/systemd/system ]; then fail systemd-required; fi",
    "id \"$NX_USER\" >/dev/null 2>&1 || fail unknown-user",
    "HOME_DIR=$(awk -F: -v u=\"$NX_USER\" '$1 == u { print $6; exit }' /etc/passwd 2>/dev/null || true)",
    "[ -n \"$HOME_DIR\" ] || HOME_DIR=\"/home/$NX_USER\"",
    "if command -v apt-get >/dev/null 2>&1; then PM=apt",
    "elif command -v dnf >/dev/null 2>&1; then PM=dnf",
    "elif command -v yum >/dev/null 2>&1; then PM=yum",
    "elif command -v pacman >/dev/null 2>&1; then PM=pacman",
    "elif command -v zypper >/dev/null 2>&1; then PM=zypper",
    "elif command -v apk >/dev/null 2>&1; then PM=apk",
    "else fail unsupported-package-manager; fi",
    "if [ -f \"$UNIT_FILE\" ] && ! grep -q '^# managed by NexusPVE' \"$UNIT_FILE\" 2>/dev/null; then fail service-conflict; fi",
    "OLD_PORT=\"\"",
    "if [ -f \"$LIB/port\" ]; then OLD_PORT=$(tr -cd '0-9' <\"$LIB/port\" 2>/dev/null || true); fi",
    "systemctl stop \"$SERVICE\" >/dev/null 2>&1 || true",
    "sleep 0.3",
    "INSTALLED=\"\"",
    "MODE=\"\"",
    "if have_wayland; then MODE=wayland; fi",
    "if [ -z \"$MODE\" ]; then",
    "  say 'Installing sway, wayvnc and foot (Wayland terminal stack)...'",
    "  if install_wayland && have_wayland; then",
    "    MODE=wayland",
    "    INSTALLED='sway wayvnc foot'",
    "  else",
    "    say 'Wayland stack unavailable; trying the TigerVNC fallback...'",
    "    tail -n 6 \"$LOG\" 2>/dev/null || true",
    "  fi",
    "fi",
    "if [ -z \"$MODE\" ]; then",
    "  if install_x11 && have_x11; then",
    "    MODE=x11",
    "    INSTALLED=\"$INSTALLED tigervnc-server xterm openbox\"",
    "  else",
    "    tail -n 6 \"$LOG\" 2>/dev/null || true",
    "    fail packages-unavailable",
    "  fi",
    "fi",
    "PORT=\"\"",
    "if [ -n \"$OLD_PORT\" ] && [ \"$OLD_PORT\" -ge 5901 ] && [ \"$OLD_PORT\" -le 5999 ] && ! port_busy \"$OLD_PORT\"; then PORT=\"$OLD_PORT\"; fi",
    "if [ -z \"$PORT\" ]; then",
    "  P=5901",
    "  while [ \"$P\" -le 5999 ]; do",
    "    if ! port_busy \"$P\"; then PORT=\"$P\"; break; fi",
    "    P=$((P + 1))",
    "  done",
    "fi",
    "[ -n \"$PORT\" ] || fail no-port",
    "mkdir -p \"$LIB\"",
    "chmod 0755 \"$LIB\"",
    "printf '%s\n' \"$PORT\" >\"$LIB/port\"",
    "printf '%s\n' \"$MODE\" >\"$LIB/mode\"",
    "chmod 0644 \"$LIB/port\" \"$LIB/mode\"",
    "cat >\"$LIB/start.sh\" <<'EOF'",
    "#!/bin/sh",
    "set -eu",
    "case \"$(cat /usr/local/lib/nexus-vnc/mode 2>/dev/null || echo wayland)\" in",
    "  x11) exec /usr/local/lib/nexus-vnc/start-x11.sh ;;",
    "  *) exec /usr/local/lib/nexus-vnc/start-wayland.sh ;;",
    "esac",
    "EOF",
    "chmod 0755 \"$LIB/start.sh\"",
    "cat >\"$LIB/sway.conf\" <<'EOF'",
    "output HEADLESS-1 resolution 1280x800",
    "output * bg #03060c solid_color",
    "exec foot --app-id=nexus-terminal",
    "EOF",
    "printf 'address=127.0.0.1\nport=%s\nenable_auth=false\n' \"$PORT\" >\"$LIB/wayvnc.conf\"",
    "chmod 0644 \"$LIB/sway.conf\" \"$LIB/wayvnc.conf\"",
    "cat >\"$LIB/start-wayland.sh\" <<'EOF'",
    "#!/bin/sh",
    "set -eu",
    "RUNDIR=${XDG_RUNTIME_DIR:-/run/nexus-vnc}",
    "mkdir -p \"$RUNDIR\"",
    "chmod 700 \"$RUNDIR\" 2>/dev/null || true",
    "export WLR_BACKENDS=headless",
    "export WLR_HEADLESS_OUTPUTS=1",
    "export WLR_RENDERER=pixman",
    "export WLR_LIBINPUT_NO_DEVICES=1",
    "export WLR_NO_HARDWARE_CURSORS=1",
    "export XDG_RUNTIME_DIR=\"$RUNDIR\"",
    "rm -f \"$RUNDIR\"/wayland-nexus \"$RUNDIR\"/wayland-nexus.lock",
    "sway --config /usr/local/lib/nexus-vnc/sway.conf >\"$RUNDIR/sway.log\" 2>&1 &",
    "SWAY_PID=$!",
    "VNC_PID=''",
    "cleanup() {",
    "  if [ -n \"$VNC_PID\" ]; then kill \"$VNC_PID\" 2>/dev/null || true; fi",
    "  kill \"$SWAY_PID\" 2>/dev/null || true",
    "  wait \"$SWAY_PID\" 2>/dev/null || true",
    "}",
    "trap cleanup EXIT INT TERM",
    "SOCKET=''",
    "i=0",
    "while [ \"$i\" -lt 100 ]; do",
    "  if ! kill -0 \"$SWAY_PID\" 2>/dev/null; then",
    "    cat \"$RUNDIR/sway.log\" >&2 || true",
    "    exit 1",
    "  fi",
    "  SOCKET=$(find \"$RUNDIR\" -maxdepth 1 -type s -name 'wayland-*' ! -name '*.lock' 2>/dev/null | head -n 1 || true)",
    "  [ -n \"$SOCKET\" ] && break",
    "  i=$((i + 1))",
    "  sleep 0.1",
    "done",
    "if [ -z \"$SOCKET\" ]; then",
    "  cat \"$RUNDIR/sway.log\" >&2 || true",
    "  exit 1",
    "fi",
    "export WAYLAND_DISPLAY=\"${SOCKET##*/}\"",
    "wayvnc --config=/usr/local/lib/nexus-vnc/wayvnc.conf >\"$RUNDIR/wayvnc.log\" 2>&1 &",
    "VNC_PID=$!",
    "if ! wait \"$VNC_PID\"; then",
    "  cat \"$RUNDIR/wayvnc.log\" >&2 || true",
    "  exit 1",
    "fi",
    "EOF",
    "chmod 0755 \"$LIB/start-wayland.sh\"",
    "cat >\"$LIB/start-x11.sh\" <<'EOF'",
    "#!/bin/sh",
    "set -eu",
    "RUNDIR=${XDG_RUNTIME_DIR:-/run/nexus-vnc}",
    "mkdir -p \"$RUNDIR\"",
    "chmod 700 \"$RUNDIR\" 2>/dev/null || true",
    "export DISPLAY=:99",
    "rm -f /tmp/.X99-lock",
    "xserver=$(command -v Xtigervnc || command -v Xvnc || true)",
    "if [ -z \"$xserver\" ]; then echo 'no TigerVNC X server found' >&2; exit 1; fi",
    "\"$xserver\" :99 -localhost=1 -rfbport @PORT@ -geometry 1280x800 -depth 24 -SecurityTypes None -AlwaysShared -nolisten tcp >\"$RUNDIR/x11.log\" 2>&1 &",
    "XVNC_PID=$!",
    "cleanup() { kill \"$XVNC_PID\" 2>/dev/null || true; wait \"$XVNC_PID\" 2>/dev/null || true; }",
    "trap cleanup EXIT INT TERM",
    "i=0",
    "while [ \"$i\" -lt 60 ]; do",
    "  if ! kill -0 \"$XVNC_PID\" 2>/dev/null; then cat \"$RUNDIR/x11.log\" >&2 || true; exit 1; fi",
    "  if command -v xdpyinfo >/dev/null 2>&1; then",
    "    xdpyinfo -display :99 >/dev/null 2>&1 && break",
    "  elif [ -S /tmp/.X11-unix/X99 ]; then",
    "    break",
    "  fi",
    "  i=$((i + 1))",
    "  sleep 0.25",
    "done",
    "if command -v openbox-session >/dev/null 2>&1; then openbox-session >/dev/null 2>&1 & fi",
    "xterm -fa 'DejaVu Sans Mono' -fs 14 -bg black -fg white -geometry 120x40 >/dev/null 2>&1 &",
    "wait \"$XVNC_PID\"",
    "EOF",
    "sed -i \"s/@PORT@/$PORT/\" \"$LIB/start-x11.sh\"",
    "chmod 0755 \"$LIB/start-x11.sh\"",
    "{",
    "  echo '# managed by NexusPVE — do not edit'",
    "  echo '[Unit]'",
    "  echo 'Description=NexusPVE loopback terminal VNC console'",
    "  echo 'After=network-online.target'",
    "  echo 'Wants=network-online.target'",
    "  echo '[Service]'",
    "  echo 'Type=simple'",
    "  echo \"User=$NX_USER\"",
    "  echo \"Environment=HOME=$HOME_DIR\"",
    "  echo 'Environment=XDG_RUNTIME_DIR=/run/nexus-vnc'",
    "  echo 'Environment=WLR_BACKENDS=headless'",
    "  echo 'Environment=WLR_HEADLESS_OUTPUTS=1'",
    "  echo 'Environment=WLR_RENDERER=pixman'",
    "  echo 'Environment=WLR_LIBINPUT_NO_DEVICES=1'",
    "  echo 'RuntimeDirectory=nexus-vnc'",
    "  echo 'RuntimeDirectoryMode=0700'",
    "  echo \"ExecStart=$LIB/start.sh\"",
    "  echo 'Restart=always'",
    "  echo 'RestartSec=3'",
    "  echo 'KillMode=control-group'",
    "  echo 'TimeoutStopSec=5'",
    "  echo '[Install]'",
    "  echo 'WantedBy=multi-user.target'",
    "} >\"$UNIT_FILE\"",
    "chmod 0644 \"$UNIT_FILE\"",
    "systemctl daemon-reload",
    "systemctl enable \"$SERVICE\" >/dev/null 2>&1 || true",
    "if ! start_service; then",
    "  say 'Wayland console did not start; retrying with the TigerVNC fallback.'",
    "  if [ \"$MODE\" = \"wayland\" ] && { have_x11 || { install_x11 && have_x11; }; }; then",
    "    MODE=x11",
    "    INSTALLED=\"$INSTALLED tigervnc-server xterm openbox\"",
    "    printf '%s\n' \"$MODE\" >\"$LIB/mode\"",
    "    chmod 0644 \"$LIB/mode\"",
    "    if ! start_service; then report_failure; fail vnc-not-starting; fi",
    "  else",
    "    report_failure",
    "    fail vnc-not-starting",
    "  fi",
    "fi",
    "INSTALLED=$(printf '%s' \"$INSTALLED\" | sed 's/^ *//; s/  */ /g')",
    "printf '@@mode=%s\n' \"$MODE\"",
    "printf '@@port=%s\n' \"$PORT\"",
    "printf '@@packages=%s\n' \"$INSTALLED\"",
    "printf '@@service=%s\n' \"$SERVICE\"",
    "say \"VNC console ready on 127.0.0.1:$PORT ($MODE).\"",
    "echo '@@done'",
  ].join("\n");
}

export async function ensureTerminalVnc(
  store: ConfigStore,
  hostId: string,
  sudoPassword?: string,
): Promise<VncSetupResult> {
  const host = store.sshHost(hostId);
  if (!host) throw new Error(`Unknown Linux host: ${hostId}`);
  const started = Date.now();
  const result = await runElevated(store, host, renderVncSetupScript(host.username), sudoPassword, { timeoutMs: 240_000 });
  const failure = /@@fail=([a-z-]+)/.exec(result.output)?.[1];
  const route = (result.route ?? "none") as VncSetupResult["route"];
  const rawPort = /@@port=(\d+)/.exec(result.output)?.[1];
  const port = rawPort ? Number(rawPort) : 0;
  const mode = /@@mode=(wayland|x11)/.exec(result.output)?.[1] as VncSetupResult["mode"] | undefined;
  const packages = (/@@packages=([^\r\n]*)/.exec(result.output)?.[1] ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const ok = result.ok && /@@done/.test(result.output) && Number.isInteger(port) && port >= 1 && port <= 65535;
  const cleanOutput = result.output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("@@"))
    .join("\n")
    .trim()
    .slice(0, 4000);
  const diagnostic = cleanOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1);
  // sudo's own diagnostics are the only honest signal that the one-time secret
  // was wrong, or that this host refuses password-fed sudo without a terminal.
  const ttyBlocked = !ok && /a terminal is required|must have a tty|no tty present/i.test(cleanOutput);
  const sudoRejected = !ok && /incorrect password|sorry, try again|not in the sudoers|is not allowed to run sudo/i.test(cleanOutput);
  const error = ok
    ? undefined
    : failure
      ? renderFailureHint(failure)
      : ttyBlocked
        ? "This host's sudo policy requires a terminal. Run the install from an interactive root shell, or grant the account passwordless sudo."
        : sudoRejected
          ? "sudo rejected that password. Check that this account is in the sudo group, then retry."
          : !result.ok && diagnostic
            ? diagnostic.slice(0, 300)
            : "The host console was not ready after installation.";
  const setup: VncSetupResult = {
    hostId: host.id,
    ok,
    state: ok ? (packages.length > 0 ? "installed" : "ready") : route === "none" ? "blocked" : "error",
    route,
    port: ok ? port : port || 0,
    mode: mode ?? "none",
    service: SERVICE,
    packages: ok ? packages : [],
    output: cleanOutput || result.output.trim() || "no output",
    error,
    needsSudoPassword: !ok && route !== "root" && !ttyBlocked && !/sudo: (not found|command not found)/i.test(cleanOutput),
    latencyMs: Date.now() - started,
  };
  if (ok) store.setSshHostVncPort(host.id, port);
  return setup;
}
