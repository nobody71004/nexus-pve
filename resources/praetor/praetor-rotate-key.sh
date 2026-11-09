#!/bin/sh
# Rotate the PRAETOR egress X-Wing keypair and update every profile in the
# host's client-pin bundle. The old keypair and profiles are restored if the
# egress does not come back with the new key.
set -u

ROOT=${1:-/opt/praetor-egress}
PUBLIC_HOST=${2:-}
HOST_ID=${3:-}
LABEL=${4:-}
PORT=${5:-9443}

fail() {
  echo "praetor-rotate: $*" >&2
  exit 1
}

[ -n "$PUBLIC_HOST" ] || fail "public host is required"
[ -n "$HOST_ID" ] || fail "host id is required"
[ -n "$LABEL" ] || fail "host label is required"
[ -d "$ROOT" ] || fail "egress root is missing: $ROOT"
[ -s "$ROOT/server.key" ] || fail "current server key is missing"
[ -s "$ROOT/server.pub" ] || fail "current server public key is missing"
[ -s "$ROOT/profiles.json" ] || fail "current client profiles are missing"
[ -s "$ROOT/praetor-keygen.mjs" ] || fail "keygen bundle is missing"
[ -s "$ROOT/praetor-profiles.mjs" ] || fail "profile bundle is missing"
case "$PORT" in
  ''|*[!0-9]*) fail "port must be numeric" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || fail "port must be 1-65535"

NODE="$ROOT/node/bin/node"
if [ ! -x "$NODE" ]; then
  NODE=$(command -v node 2>/dev/null || true)
fi
[ -n "$NODE" ] && [ -x "$NODE" ] || fail "no Node runtime found"

OLD_PUB=$(tr -d '\r\n' < "$ROOT/server.pub")
[ -n "$OLD_PUB" ] || fail "current server public key is empty"

TMP=$(mktemp -d "${TMPDIR:-/tmp}/praetor-rotate.XXXXXX") || fail "could not create a rotation staging directory"
cleanup() {
  rm -rf "$TMP"
}
trap cleanup EXIT HUP INT TERM

cp "$ROOT/server.key" "$TMP/server.key.old" || fail "could not back up the current server key"
cp "$ROOT/server.pub" "$TMP/server.pub.old" || fail "could not back up the current server public key"
cp "$ROOT/profiles.json" "$TMP/profiles.old" || fail "could not back up the current client profiles"

NEW_KEY="$TMP/server.key"
NEW_PUB="$TMP/server.pub"
NEW_PROFILES="$TMP/profiles.json"

"$NODE" "$ROOT/praetor-keygen.mjs" "$NEW_KEY" "$NEW_PUB" >/dev/null || fail "could not generate a new keypair"
[ -s "$NEW_KEY" ] && [ -s "$NEW_PUB" ] || fail "the new keypair is empty"
"$NODE" -e '
  const fs = require("node:fs");
  const key = fs.readFileSync(process.argv[1], "utf8").replace(/\s+/g, "");
  if (Buffer.from(key, "base64").length !== 1216) process.exit(1);
' "$NEW_PUB" || fail "the new server public key is invalid"

"$NODE" "$ROOT/praetor-profiles.mjs" \
  --key-file "$NEW_PUB" \
  --host "$PUBLIC_HOST" \
  --label "$LABEL" \
  --id "$HOST_ID" \
  --port "$PORT" \
  --out "$NEW_PROFILES" >/dev/null || fail "could not write the new client profiles"
"$NODE" -e '
  const fs = require("node:fs");
  const profiles = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(profiles) || profiles.length !== 4) process.exit(1);
' "$NEW_PROFILES" || fail "the new client pin bundle is incomplete"

restore() {
  install -m 0600 "$TMP/server.key.old" "$ROOT/server.key" >/dev/null 2>&1 || true
  install -m 0644 "$TMP/server.pub.old" "$ROOT/server.pub" >/dev/null 2>&1 || true
  install -m 0644 "$TMP/profiles.old" "$ROOT/profiles.json" >/dev/null 2>&1 || true
  systemctl restart praetor-egress.service >/dev/null 2>&1 || true
}

install -m 0600 "$NEW_KEY" "$ROOT/server.key" || { restore; fail "could not install the new server key"; }
install -m 0644 "$NEW_PUB" "$ROOT/server.pub" || { restore; fail "could not install the new server public key"; }
install -m 0644 "$NEW_PROFILES" "$ROOT/profiles.json" || { restore; fail "could not install the new client profiles"; }

if ! systemctl restart praetor-egress.service >/dev/null 2>&1; then
  restore
  fail "could not restart praetor-egress with the new key"
fi

i=0
while [ "$i" -lt 15 ]; do
  if systemctl is-active --quiet praetor-egress.service 2>/dev/null; then
    break
  fi
  sleep 1
  i=$((i + 1))
done
if ! systemctl is-active --quiet praetor-egress.service 2>/dev/null; then
  restore
  fail "praetor-egress did not stay active with the new key"
fi

NEW_PUB_KEY=$(tr -d '\r\n' < "$ROOT/server.pub")
[ -n "$NEW_PUB_KEY" ] || { restore; fail "the installed server public key is empty"; }

printf '@@oldpubkey=%s\n' "$OLD_PUB"
printf '@@pubkey=%s\n' "$NEW_PUB_KEY"
printf '@@profiles=4\n'
printf '@@done\n'
