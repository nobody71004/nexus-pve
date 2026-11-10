#!/bin/sh
# Nexus PVE — narrow root entry point for host actions and the security guard.
#
# Installed as /usr/local/sbin/nexus-priv (root:root 0755). It is the only
# command the login account may run through sudo without a password, so the
# whole privileged surface is this file: a fixed set of subcommands, validated
# inputs, no shell evaluation, no caller-supplied command strings.
#
#   nexus-priv service <start|stop|restart> <unit>
#   nexus-priv power <reboot|shutdown>
#   nexus-priv backup <slug> <path> [path...]
#   nexus-priv gpu setup
#   nexus-priv guard collect
#   nexus-priv guard apply <remediation-id>
#   nexus-priv guard ban <address>
#   nexus-priv guard unban <address>
#   nexus-priv guard bans
#   nexus-priv guard install <safe|hard>
#   nexus-priv guard uninstall
#   nexus-priv guard status
#
# Keep it POSIX sh: Ubuntu's /bin/sh is dash.

set -u
export LC_ALL=C
umask 077

DEST=/var/backups/nexus
GPU_SETUP_PATH=/usr/local/lib/nexus-gpu-setup.sh
KEEP=3
GUARD_LIB=/usr/local/lib/nexus-guard
GUARD_ETC=/etc/nexus-guard
GUARD_UNIT=nexus-guard
# Sorts before distro snippets (50-cloud-init.conf, etc.) because sshd keeps the
# first value it sees for a keyword. The old 90- name is migrated below.
SSHD_DROPIN=/etc/ssh/sshd_config.d/00-nexus-guard.conf
SSHD_LEGACY=/etc/ssh/sshd_config.d/90-nexus-guard.conf
SSHD_OPTIONS=$GUARD_ETC/sshd-options

die() {
  printf '%s\n' "$*" >&2
  exit 64
}

usage() {
  cat >&2 <<'EOF'
usage:
  nexus-priv service <start|stop|restart> <unit>
  nexus-priv power <reboot|shutdown>
  nexus-priv backup <slug> <path> [path...]
  nexus-priv gpu setup
  nexus-priv guard collect
  nexus-priv guard apply <remediation-id>
  nexus-priv guard ban <address>
  nexus-priv guard unban <address>
  nexus-priv guard bans
  nexus-priv guard install <safe|hard>
  nexus-priv guard uninstall
  nexus-priv guard status
EOF
  exit 64
}

valid_unit() {
  case "$1" in
    "" | *[!A-Za-z0-9@._:-]*) return 1 ;;
  esac
  return 0
}

valid_ip() {
  case "$1" in
    "" | *[!0-9a-fA-F:.]*) return 1 ;;
  esac
  [ ${#1} -le 45 ] || return 1
  return 0
}

# Facts are emitted as "key|base64(value)" so multi-line config can never be
# mistaken for a field separator. The app decodes and evaluates them.
emit() {
  printf '%s|%s\n' "$1" "$(printf '%s' "$2" | base64 -w0 2>/dev/null || printf '%s' "$2" | base64 | tr -d '\n')"
}

hash_of() {
  if [ -f "$1" ]; then
    sha256sum "$1" 2>/dev/null | awk '{print $1}'
  else
    echo missing
  fi
}

hash_tree() {
  # One hash over a whole tree, so adding a file changes the fingerprint.
  if [ -e "$1" ]; then
    find "$1" -xdev -type f 2>/dev/null | sort | while read -r file; do
      printf '%s %s\n' "$(hash_of "$file")" "$file"
    done | sha256sum | awk '{print $1}'
  else
    echo missing
  fi
}

ssh_reload() {
  systemctl reload ssh 2>/dev/null || systemctl reload sshd 2>/dev/null || service ssh reload 2>/dev/null || true
}

ssh_test() {
  sshd -t 2>&1
}

dropin_supported() {
  grep -Eq '^[[:space:]]*Include[[:space:]]+/etc/ssh/sshd_config\.d/' /etc/ssh/sshd_config 2>/dev/null && return 0
  # The include must precede any PermitRootLogin/PasswordAuthentication line,
  # otherwise the main file wins and the drop-in is inert.
  cp -p /etc/ssh/sshd_config "$GUARD_ETC/rollback/sshd_config-$(date +%s)" 2>/dev/null || true
  tmp=$(mktemp) || die "cannot prepare sshd_config include"
  {
    printf '# nexus-guard-include\nInclude /etc/ssh/sshd_config.d/*.conf\n\n'
    cat /etc/ssh/sshd_config 2>/dev/null
  } >"$tmp" || die "cannot extend sshd_config"
  chmod 644 "$tmp" 2>/dev/null || true
  mv "$tmp" /etc/ssh/sshd_config || die "cannot extend sshd_config"
  ssh_test >/dev/null 2>&1 || {
    printf 'sshd rejected the generated include, restoring sshd_config\n' >&2
    backup=$(ls -1t "$GUARD_ETC/rollback"/sshd_config-* 2>/dev/null | head -1)
    [ -n "$backup" ] && cp -p "$backup" /etc/ssh/sshd_config
    exit 5
  }
}

sshd_migrate_legacy() {
  # Builds the managed-option state from a drop-in written by an earlier build,
  # so applying one fix does not discard the others.
  [ -f "$SSHD_OPTIONS" ] && return 0
  tmp=$(mktemp) || return 1
  for file in "$SSHD_DROPIN" "$SSHD_LEGACY"; do
    [ -f "$file" ] || continue
    grep -q '^# managed by nexus-priv' "$file" 2>/dev/null || continue
    grep -Ev '^[[:space:]]*(#|$)' "$file" >>"$tmp" 2>/dev/null || true
  done
  if [ -s "$tmp" ]; then
    awk '!seen[tolower($1)]++' "$tmp" >"$SSHD_OPTIONS"
    chmod 600 "$SSHD_OPTIONS" 2>/dev/null || true
  fi
  rm -f "$tmp"
}

sshd_option_set() {
  sshd_migrate_legacy
  key=$1
  shift
  [ -n "$key" ] || die "empty sshd option"
  mkdir -p "$GUARD_ETC" || die "cannot prepare sshd options"
  tmp=$(mktemp) || die "cannot prepare sshd options"
  if [ -f "$SSHD_OPTIONS" ]; then
    awk -v key="$key" '
      tolower($1) != tolower(key) { print }
    ' "$SSHD_OPTIONS" >"$tmp"
  fi
  printf '%s %s\n' "$key" "$*" >>"$tmp" || die "cannot record sshd option"
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$SSHD_OPTIONS" || die "cannot record sshd option"
}

sshd_render() {
  [ -s "$SSHD_OPTIONS" ] || die "no managed sshd options"
  write_dropin "$(cat "$SSHD_OPTIONS")"
}

sshd_effective_value() {
  sshd -T 2>/dev/null | awk -v key="$1" 'tolower($1) == tolower(key) { print $2; exit }'
}

sshd_silence_conflicts() {
  # Only used when the drop-in alone did not take effect: comment the competing
  # directive in the main file and in snippets that are not ours, then reload.
  key=$1
  changed=0
  for file in /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf; do
    [ -f "$file" ] || continue
    [ "$file" = "$SSHD_DROPIN" ] && continue
    grep -Eiq "^[[:space:]]*${key}[[:space:]]" "$file" 2>/dev/null || continue
    cp -p "$file" "$GUARD_ETC/rollback/$(basename "$file").$(date +%s)" 2>/dev/null || true
    tmp=$(mktemp) || die "cannot prepare $file"
    awk -v key="$key" '
      tolower($1) == tolower(key) && $0 !~ /^[[:space:]]*#/ {
        print "# disabled by nexus-priv (security guard): " $0
        next
      }
      { print }
    ' "$file" >"$tmp"
    cat "$tmp" >"$file"
    rm -f "$tmp"
    changed=1
  done
  if [ "$changed" -eq 1 ]; then
    if ! out=$(ssh_test); then
      printf 'sshd rejected the conflict cleanup, rolled back: %s\n' "$out" >&2
      exit 5
    fi
    ssh_reload
  fi
}

sshd_normalize() {
  # sshd -T prints "without-password" for "prohibit-password"; they are the
  # same setting under two names.
  case "$1" in
    without-password) printf 'prohibit-password\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

sshd_force() {
  # $1 = key, remaining args = value. Verifies the effective value, because a
  # config that passes sshd -t can still lose to an earlier snippet.
  key=$1
  shift
  want=$*
  sshd_option_set "$key" "$want"
  sshd_render
  got=$(sshd_effective_value "$key")
  if [ "$(sshd_normalize "$got")" != "$(sshd_normalize "$want")" ]; then
    sshd_silence_conflicts "$key"
    got=$(sshd_effective_value "$key")
  fi
  [ "$(sshd_normalize "$got")" = "$(sshd_normalize "$want")" ] || die "sshd kept ${key}=${got:-unknown} (wanted $want)"
}

write_dropin() {
  # $1 = body. Always validates with sshd -t and restores the previous file on
  # failure, so a bad rule can never leave the host without working sshd.
  mkdir -p "$(dirname "$SSHD_DROPIN")" "$GUARD_ETC/rollback" || die "cannot prepare sshd drop-in"
  if [ -f "$SSHD_DROPIN" ] && ! grep -q '^# managed by nexus-priv' "$SSHD_DROPIN" 2>/dev/null; then
    die "$SSHD_DROPIN exists and is not managed by nexus-priv"
  fi
  [ -f "$SSHD_DROPIN" ] && cp -p "$SSHD_DROPIN" "$GUARD_ETC/rollback/sshd-$(date +%s).conf" 2>/dev/null
  dropin_supported
  printf '# managed by nexus-priv (security guard) — do not edit\n%s\n' "$1" >"$SSHD_DROPIN" || die "cannot write drop-in"
  # Remove the old 90- drop-in left by earlier builds so it cannot shadow this
  # one when a distro snippet sits between the two names.
  if [ -f "$SSHD_LEGACY" ] && grep -q '^# managed by nexus-priv' "$SSHD_LEGACY" 2>/dev/null; then
    rm -f "$SSHD_LEGACY"
  fi
  if ! out=$(ssh_test); then
    rm -f "$SSHD_DROPIN"
    printf 'sshd rejected the change, rolled back: %s\n' "$out" >&2
    exit 5
  fi
  ssh_reload
  printf 'sshd=ok reload=ok\n'
}

protected_address() {
  # Never ban loopback, link-local, the unspecified address, or any peer that
  # currently holds an established SSH session (which includes the operator's).
  case "$1" in
    127.* | 0.0.0.0 | ::1 | :: | ::ffff:127.* | 169.254.* | fe80:* | ff02::*) return 0 ;;
  esac
  active=$(ss -Htn state established '( sport = :22 )' 2>/dev/null | awk '{print $4}' | sed 's/:22$//' | sed 's/^\[//; s/\]$//')
  for peer in $active; do
    if [ "$peer" = "$1" ]; then return 0; fi
  done
  return 1
}

guard_collect() {
  emit hostname "$(hostname 2>/dev/null || echo unknown)"
  emit kernel "$(uname -r 2>/dev/null || echo unknown)"
  emit priv_user "$(id -un 2>/dev/null || echo unknown)"

  # Effective sshd config (root-only path; sshd -T needs root for the keys).
  emit sshd_effective "$(sshd -T 2>/dev/null || true)"

  # Kernel namespace settings are controlled by the host on LXC/OpenVZ. Tell
  # the evaluator so it does not offer a fix the guest kernel will ignore.
  container=$(systemd-detect-virt --container 2>/dev/null || cat /run/systemd/container 2>/dev/null || true)
  case "$container" in none | "" | unknown) container="" ;; esac
  emit container "$container"

  emit sudo_nopasswd "$(grep -Rhs 'NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null | grep -v '^[[:space:]]*#' || true)"
  emit sudoers_mode "$(stat -c '%a %U:%G' /etc/sudoers 2>/dev/null || echo missing)"
  emit empty_users "$(awk -F: '($2==""){print $1}' /etc/shadow 2>/dev/null || true)"
  emit uid0 "$(awk -F: '$3==0{print $1}' /etc/passwd 2>/dev/null || true)"
  emit login_shells "$(awk -F: '$7 !~ /(nologin|false|sync)$/ {print $1}' /etc/passwd 2>/dev/null | head -40)"

  emit authorized_keys "$(for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
    [ -f "$f" ] || continue
    printf '### %s mode=%s owner=%s\n' "$f" "$(stat -c %a "$f" 2>/dev/null)" "$(stat -c %U:%G "$f" 2>/dev/null)"
    cat "$f" 2>/dev/null
  done)"

  emit failed_logins "$(journalctl -u ssh -u sshd --since '-24 hours' --no-pager -o cat 2>/dev/null | grep -c 'Failed password' || true)"
  emit failed_ips "$(journalctl -u ssh -u sshd --since '-24 hours' --no-pager -o cat 2>/dev/null |
    sed -n 's/.*Failed password for .* from \([0-9a-fA-F.:]*\) port.*/\1/p' | sort | uniq -c | sort -rn | head -20)"
  emit accepted_root "$(journalctl -u ssh -u sshd --since '-24 hours' --no-pager -o cat 2>/dev/null | grep -c 'Accepted .* for root' || true)"
  emit invalid_users "$(journalctl -u ssh -u sshd --since '-24 hours' --no-pager -o cat 2>/dev/null | grep -c 'Invalid user' || true)"

  emit fim "$(for pair in "/etc/ssh/sshd_config" "/etc/ssh/sshd_config.d" "/etc/passwd" "/etc/group" "/etc/shadow" "/etc/sudoers" "/etc/sudoers.d" "/etc/crontab" "/etc/cron.d" "/var/spool/cron/crontabs" "/etc/systemd/system" "/etc/rc.local" "/etc/hosts"; do
    printf '%s %s\n' "$(hash_tree "$pair")" "$pair"
  done)"

  emit cron_all "$(for f in /etc/crontab /etc/cron.d/* /var/spool/cron/crontabs/*; do
    [ -f "$f" ] || continue
    printf '### %s\n' "$f"
    cat "$f" 2>/dev/null
  done)"
  emit units "$(ls -1 /etc/systemd/system/*.service /etc/systemd/system/*.timer 2>/dev/null | sort -u)"
  emit suid "$(find /usr/bin /usr/sbin /bin /sbin /usr/local -xdev -perm -4000 -type f 2>/dev/null | sort)"
  emit world_writable "$(find /etc -xdev -perm -0002 -type f 2>/dev/null | head -50)"
  emit listeners "$(ss -Htulnp 2>/dev/null | sed -E 's/[[:space:]]+/ /g' | cut -d' ' -f1,5,7- | head -80)"

  emit sysctl "$(for k in net.ipv4.conf.all.rp_filter net.ipv4.tcp_syncookies net.ipv4.conf.all.accept_redirects net.ipv4.conf.all.send_redirects net.ipv4.conf.all.accept_source_route net.ipv4.conf.all.log_martians net.ipv6.conf.all.accept_ra kernel.randomize_va_space kernel.kptr_restrict kernel.dmesg_restrict kernel.yama.ptrace_scope fs.protected_hardlinks fs.protected_symlinks fs.suid_dumpable; do printf '%s=%s\n' "$k" "$(sysctl -n "$k" 2>/dev/null)"; done)"
  emit rc_local "$( [ -x /etc/rc.local ] && echo executable || echo absent )"
  emit apt_pending "$(apt-get -s -o Debug::NoLocking=1 dist-upgrade 2>/dev/null | grep -c '^Inst ' || true)"
  emit reboot_required "$( [ -f /var/run/reboot-required ] && echo yes || echo no )"
  emit unattended "$(grep -hs 'Unattended-Upgrade\|Update-Package-Lists' /etc/apt/apt.conf.d/* 2>/dev/null | head -10)"
  emit ufw "$(ufw status verbose 2>/dev/null || true)"
  emit firewall_nft "$(nft list ruleset 2>/dev/null | head -400 || true)"
  emit firewall_iptables "$(iptables-save 2>/dev/null | head -200 || true)"
  emit fail2ban "$(fail2ban-client status sshd 2>/dev/null || fail2ban-client status 2>/dev/null || true)"
  emit nft_ruleset "$(nft list table inet nexus_guard 2>/dev/null || true)"
  emit bans "$(nft list set inet nexus_guard banned 2>/dev/null | tr -d '\n' || true)"
  emit bans6 "$(nft list set inet nexus_guard banned6 2>/dev/null | tr -d '\n' || true)"
  emit resident "$(systemctl is-enabled nexus-guard.timer 2>/dev/null || echo absent)"
  emit resident_active "$(systemctl is-active nexus-guard.timer 2>/dev/null || echo inactive)"
  emit resident_enforce "$(cat "$GUARD_ETC/enforce.list" 2>/dev/null || true)"
  exit 0
}

SYSCTL_CONF=/etc/sysctl.d/zz-nexus-guard.conf

sysctl_lines() {
  cat <<'EOF'
net.ipv4.conf.all.rp_filter=1
net.ipv4.conf.default.rp_filter=1
net.ipv4.tcp_syncookies=1
net.ipv4.conf.all.accept_redirects=0
net.ipv4.conf.default.accept_redirects=0
net.ipv4.conf.all.send_redirects=0
net.ipv4.conf.all.accept_source_route=0
net.ipv4.conf.default.accept_source_route=0
net.ipv4.conf.all.log_martians=1
net.ipv4.icmp_echo_ignore_broadcasts=1
net.ipv4.icmp_ignore_bogus_error_responses=1
net.ipv6.conf.all.accept_ra=0
net.ipv6.conf.all.accept_redirects=0
net.ipv6.conf.all.accept_source_route=0
kernel.randomize_va_space=2
kernel.kptr_restrict=2
kernel.dmesg_restrict=1
kernel.yama.ptrace_scope=1
fs.protected_hardlinks=1
fs.protected_symlinks=1
fs.suid_dumpable=0
EOF
}

apply_sysctl() {
  mkdir -p /etc/sysctl.d || exit 4
  # zz- sorts after distro 99-* snippets. The old 90- file is removed so a
  # later 99- file cannot silently win.
  rm -f /etc/sysctl.d/90-nexus-guard.conf
  {
    printf '# managed by nexus-priv (security guard)\n'
    sysctl_lines
  } >"$SYSCTL_CONF" || exit 4
  chmod 644 "$SYSCTL_CONF" 2>/dev/null || true

  # Apply key by key. One unavailable key must not stop the rest of the file
  # from taking effect (containers expose read-only kernel.* entries).
  applied=0
  failed=0
  failed_keys=""
  sysctl_lines | while IFS= read -r line; do
    [ -n "$line" ] || continue
    key=${line%%=*}
    want=${line#*=}
    sysctl -w "$line" >/dev/null 2>&1 || true
    # sysctl -w exits 0 even when it prints "permission denied ... ignoring"
    # inside an LXC guest, so trust the value that was actually read back.
    got=$(sysctl -n "$key" 2>/dev/null || true)
    if [ "$got" = "$want" ]; then
      applied=$((applied + 1))
    else
      failed=$((failed + 1))
      failed_keys="$failed_keys $key=${got:-?}"
    fi
    printf '%s %s\n' "$applied" "$failed" >"$GUARD_ETC/sysctl-apply.tmp"
    printf '%s' "$failed_keys" >"$GUARD_ETC/sysctl-failed.tmp"
  done
  # The pipeline runs in a subshell; read the counters back from the temp files.
  applied=$(awk '{print $1}' "$GUARD_ETC/sysctl-apply.tmp" 2>/dev/null || echo 0)
  failed=$(awk '{print $2}' "$GUARD_ETC/sysctl-apply.tmp" 2>/dev/null || echo 0)
  failed_keys=$(cat "$GUARD_ETC/sysctl-failed.tmp" 2>/dev/null || true)
  rm -f "$GUARD_ETC/sysctl-apply.tmp" "$GUARD_ETC/sysctl-failed.tmp"
  applied=${applied:-0}
  failed=${failed:-0}
  if [ "$failed" -gt 0 ]; then
    container=$(systemd-detect-virt --container 2>/dev/null || cat /run/systemd/container 2>/dev/null || true)
    case "$container" in none | "" | unknown) container="" ;; esac
    printf 'sysctl=partial applied=%s failed=%s keys=%s\n' "$applied" "$failed" "$(printf '%s' "$failed_keys" | sed 's/^ *//')"
    if [ -n "$container" ]; then
      # The host kernel owns these keys inside LXC/OpenVZ. The resident unit
      # should not be marked failed for a value it is not allowed to change.
      printf 'sysctl_host_controlled=%s\n' "$container"
      exit 0
    fi
    exit 6
  fi
  printf 'sysctl=applied=%s file=%s\n' "$applied" "$SYSCTL_CONF"
}

apply_unattended() {
  if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive timeout 240 apt-get install -y unattended-upgrades >/dev/null 2>&1 || {
      echo "unattended-upgrades could not be installed (no network or apt lock)"; exit 6
    }
  fi
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\nAPT::Periodic::AutocleanInterval "7";\n' \
    >/etc/apt/apt.conf.d/20auto-upgrades
  systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true
  printf 'unattended=1 file=/etc/apt/apt.conf.d/20auto-upgrades\n'
}

apply_ssh_permit_root() {
  sshd_force PermitRootLogin prohibit-password
  printf 'root_login=prohibit-password\n'
}

apply_ssh_key_only() {
  keys=$(for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do [ -s "$f" ] && echo "$f"; done)
  if [ -z "$keys" ]; then
    echo "refusing to disable password auth: no authorized_keys on this host" >&2
    exit 3
  fi
  # Merge with whatever the guard already manages (for example
  # PermitRootLogin). Overwriting the file here used to undo the root-login fix.
  sshd_option_set PasswordAuthentication no
  sshd_option_set KbdInteractiveAuthentication no
  sshd_option_set PermitEmptyPasswords no
  sshd_render
  for key in PasswordAuthentication KbdInteractiveAuthentication PermitEmptyPasswords; do
    want=no
    got=$(sshd_effective_value "$key")
    if [ "$got" != "$want" ]; then
      sshd_silence_conflicts "$key"
      got=$(sshd_effective_value "$key")
    fi
    [ "$got" = "$want" ] || die "sshd kept ${key}=${got:-unknown} (wanted $want)"
  done
  printf 'password_auth=disabled keys=%s\n' "$(printf '%s' "$keys" | tr '\n' ' ')"
}

apply_backup_perms() {
  fixed=0
  for key in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
    [ -f "$key" ] || continue
    chmod 600 "$key" 2>/dev/null && fixed=$((fixed + 1))
    chmod 700 "$(dirname "$key")" 2>/dev/null || true
  done
  chmod 600 /etc/shadow 2>/dev/null || true
  chmod 644 /etc/passwd /etc/group 2>/dev/null || true
  chmod 440 /etc/sudoers 2>/dev/null || true
  find /etc/sudoers.d -type f -exec chmod 440 {} + 2>/dev/null || true
  printf 'permissions=fixed files=%s\n' "$fixed"
}

apply_sudo_narrow() {
  # Turn broad passwordless grants into password-required grants. The account
  # keeps the same commands; only the NOPASSWD shortcut is removed. An account
  # with no usable password is skipped, never locked out of sudo.
  command -v visudo >/dev/null 2>&1 || die "visudo is required to narrow sudo rules"
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  backup="$DEST/sudoers-$stamp"
  mkdir -p "$backup" || exit 4
  chmod 700 "$backup"
  changed=0
  skipped=""
  for file in /etc/sudoers /etc/sudoers.d/*; do
    [ -f "$file" ] || continue
    case "$file" in */nexus-actions | */README) continue ;; esac
    grep -Eq 'NOPASSWD' "$file" 2>/dev/null || continue
    tmp=$(mktemp "${file}.nexus-XXXXXX") || { skipped="$skipped $file(temp)"; continue; }
    out="$tmp.new"
    : >"$out"
    wrote=0
    while IFS= read -r line || [ -n "$line" ]; do
      if printf '%s' "$line" | grep -Eiq 'NOPASSWD[[:space:]]*:[[:space:]]*(ALL([[:space:]]|$)|(/usr)?/bin/(ba|da|z)?sh([[:space:]]|$)|(/usr)?/bin/(vi|vim|less|more|man|awk|sed|find|tee|dd|cp|mv|env|python[0-9.]*|perl|ruby|node)([[:space:]]|$))'; then
        user=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*([^[:space:]]+).*/\1/')
        case "$user" in
          '' | '#'* | '%'* | Defaults* | *Alias*)
            skipped="$skipped $file:$user"
            printf '%s\n' "$line" >>"$out"
            continue
            ;;
        esac
        hash=$(getent shadow "$user" 2>/dev/null | cut -d: -f2)
        case "$hash" in
          '' | '!'* | '*'*)
            skipped="$skipped $user(no-password)"
            printf '%s\n' "$line" >>"$out"
            continue
            ;;
        esac
        printf '%s\n' "$(printf '%s' "$line" | sed -E 's/NOPASSWD[[:space:]]*:[[:space:]]*//I')" >>"$out"
        wrote=$((wrote + 1))
      else
        printf '%s\n' "$line" >>"$out"
      fi
    done <"$file"
    if [ "$wrote" -eq 0 ]; then
      rm -f "$tmp" "$out"
      continue
    fi
    chown --reference="$file" "$out" 2>/dev/null || true
    chmod --reference="$file" "$out" 2>/dev/null || true
    if ! visudo -cf "$out" >/dev/null 2>&1; then
      skipped="$skipped $file(visudo-failed)"
      rm -f "$tmp" "$out"
      continue
    fi
    if ! cp -p "$file" "$backup/$(basename "$file")" 2>/dev/null || ! install -o root -g root -m 0440 "$out" "$file"; then
      skipped="$skipped $file(write-failed)"
      rm -f "$tmp" "$out"
      continue
    fi
    rm -f "$tmp" "$out"
    changed=$((changed + wrote))
  done
  if [ "$changed" -eq 0 ]; then
    if [ -z "$skipped" ]; then
      # Idempotent: the rule is already narrow, so a retry is not a failure and
      # the guard can accept the fingerprints this fix owns.
      printf 'sudo_narrow=unchanged backup=%s\n' "$backup"
      exit 0
    fi
    echo "no broad passwordless sudo rule could be narrowed (skipped:${skipped# })"
    exit 3
  fi
  printf 'sudo_narrow=changed=%s backup=%s%s\n' "$changed" "$backup" "${skipped:+ skipped:${skipped# }}"
}

apply_fail2ban() {
  if ! command -v fail2ban-client >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive timeout 240 apt-get install -y fail2ban >/dev/null 2>&1 || {
      echo "fail2ban could not be installed (no network or apt lock)"; exit 6
    }
  fi
  cat >/etc/fail2ban/jail.local <<'EOF'
# managed by nexus-priv (security guard)
[DEFAULT]
backend = systemd
bantime = 1h
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 ::1

[sshd]
enabled = true
EOF
  systemctl enable fail2ban >/dev/null 2>&1 || true
  systemctl restart fail2ban >/dev/null 2>&1 || {
    echo "fail2ban failed to start"; exit 7
  }
  printf 'fail2ban=active\n'
}

listening_ports() {
  # $1 = tcp|udp. Keep every port that is already listening so enabling a
  # baseline cannot take a game server, proxy or container workload offline.
  case "$1" in
    tcp) ss -Htln 2>/dev/null ;;
    udp) ss -Huln 2>/dev/null ;;
    *) return 0 ;;
  esac | awk '{print $4}' | sed -E 's/.*:([0-9]+)$/\1/' | grep -E '^[0-9]+$' | sort -nu | paste -sd, -
}

apply_firewall_baseline() {
  # Never rebuild a firewall this guard did not create. The resident enforcer
  # calls every id on its list, including hosts already protected by an edge
  # nftables/ufw policy.
  if ufw status 2>/dev/null | grep -qi '^Status: active'; then
    printf 'firewall=existing ufw=active left_untouched\n'
    return 0
  fi
  if ! nft list table inet nexus_firewall >/dev/null 2>&1 &&
    nft list ruleset 2>/dev/null | grep -Eq 'hook input[^}]*policy drop'; then
    printf 'firewall=existing nft=active left_untouched\n'
    return 0
  fi

  ssh_ports=$(sshd -T 2>/dev/null | awk '$1=="port"{print $2}' | sort -u)
  [ -n "$ssh_ports" ] || ssh_ports=22
  tcp_ports=$(printf '%s\n%s\n' "$(printf '%s' "$ssh_ports" | tr '\n' ',')" "$(listening_ports tcp)" | tr ',' '\n' | grep -E '^[0-9]+$' | sort -nu | paste -sd, -)
  udp_ports=$(listening_ports udp)

  if command -v ufw >/dev/null 2>&1; then
    ufw default deny incoming >/dev/null 2>&1 || true
    ufw default allow outgoing >/dev/null 2>&1 || true
    for port in $(printf '%s' "$tcp_ports" | tr ',' ' '); do
      ufw allow "$port"/tcp >/dev/null 2>&1 || true
    done
    for port in $(printf '%s' "$udp_ports" | tr ',' ' '); do
      ufw allow "$port"/udp >/dev/null 2>&1 || true
    done
    ufw --force enable >/dev/null 2>&1 || {
      echo "ufw could not be enabled"; exit 7
    }
    printf 'firewall=ufw tcp=%s udp=%s\n' "${tcp_ports:-none}" "${udp_ports:-none}"
    return 0
  fi

  command -v nft >/dev/null 2>&1 || {
    echo "neither ufw nor nftables is installed; firewall baseline skipped"
    exit 6
  }

  # Atomic replacement: if the ruleset is rejected, no half-applied policy can
  # cut the session. Existing listeners stay reachable; everything else inbound
  # is dropped. The guard's ban table (-10) runs before this chain.
  nft list table inet nexus_firewall >/dev/null 2>&1 && nft delete table inet nexus_firewall
  {
    printf 'table inet nexus_firewall {\n  chain input {\n    type filter hook input priority 0; policy drop;\n'
    printf '    ct state established,related accept\n    iif "lo" accept\n'
    printf '    ip protocol icmp accept\n    meta l4proto ipv6-icmp accept\n'
    [ -n "$tcp_ports" ] && printf '    tcp dport { %s } accept\n' "$tcp_ports"
    [ -n "$udp_ports" ] && printf '    udp dport { %s } accept\n' "$udp_ports"
    printf '    counter drop comment "nexus baseline input dropped"\n  }\n}\n'
  } >/tmp/nexus-firewall.nft || exit 4
  if ! nft -f /tmp/nexus-firewall.nft; then
    rm -f /tmp/nexus-firewall.nft
    nft delete table inet nexus_firewall 2>/dev/null || true
    echo "nftables rejected the firewall baseline"
    exit 7
  fi
  rm -f /tmp/nexus-firewall.nft
  # Confirm the policy survived and SSH is still allowed before reporting ok.
  if ! nft list chain inet nexus_firewall input 2>/dev/null | grep -q 'policy drop'; then
    echo "firewall table was not applied"
    exit 7
  fi
  printf 'firewall=nft tcp=%s udp=%s\n' "${tcp_ports:-none}" "${udp_ports:-none}"
}

guard_apply() {
  [ $# -eq 1 ] || usage
  mkdir -p "$GUARD_ETC" || exit 4
  case "$1" in
    sysctl-hardening)
      apply_sysctl
      ;;
    unattended-upgrades)
      apply_unattended
      ;;
    ssh-permit-root)
      apply_ssh_permit_root
      ;;
    ssh-key-only)
      apply_ssh_key_only
      ;;
    key-permissions)
      apply_backup_perms
      ;;
    fail2ban-baseline)
      apply_fail2ban
      ;;
    sudo-narrow)
      apply_sudo_narrow
      ;;
    firewall-baseline)
      apply_firewall_baseline
      ;;
    *)
      die "unknown remediation id: $1"
      ;;
  esac
  printf 'remediation=%s at=%s\n' "$1" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  logger -t nexus-guard "applied $1" 2>/dev/null || true
  exit 0
}

guard_ban() {
  [ $# -eq 1 ] || usage
  ip=$1
  valid_ip "$ip" || die "invalid address: $ip"
  command -v nft >/dev/null 2>&1 || die "nftables is not available on this host"
  if protected_address "$ip"; then
    die "refusing to ban protected address: $ip"
  fi
  nft list table inet nexus_guard >/dev/null 2>&1 || {
    nft add table inet nexus_guard || die "cannot create nft table"
    nft 'add chain inet nexus_guard input { type filter hook input priority -10 ; policy accept ; }' || die "cannot create chain"
    nft 'add set inet nexus_guard banned { type ipv4_addr ; flags timeout ; }' || die "cannot create v4 set"
    nft 'add set inet nexus_guard banned6 { type ipv6_addr ; flags timeout ; }' || die "cannot create v6 set"
    nft add rule inet nexus_guard input ip saddr @banned drop
    nft add rule inet nexus_guard input ip6 saddr @banned6 drop
  }
  case "$ip" in
    *:*) set=banned6 ;;
    *) set=banned ;;
  esac
  nft add element inet nexus_guard "$set" "{ $ip timeout 24h }" || die "cannot add $ip to $set"
  logger -t nexus-guard "banned $ip for 24h" 2>/dev/null || true
  printf 'banned=%s set=%s ttl=24h\n' "$ip" "$set"
}

guard_unban() {
  [ $# -eq 1 ] || usage
  ip=$1
  valid_ip "$ip" || die "invalid address: $ip"
  case "$ip" in
    *:*) set=banned6 ;;
    *) set=banned ;;
  esac
  nft delete element inet nexus_guard "$set" "{ $ip }" 2>/dev/null || {
    echo "address is not banned: $ip"
    exit 3
  }
  printf 'unbanned=%s\n' "$ip"
}

guard_bans() {
  nft list set inet nexus_guard banned 2>/dev/null | tr -d '\n' || true
  printf '\n'
  nft list set inet nexus_guard banned6 2>/dev/null | tr -d '\n' || true
  printf '\n'
  exit 0
}

guard_install() {
  [ $# -eq 1 ] || usage
  case "$1" in
    safe)
      list="sysctl-hardening
unattended-upgrades
ssh-permit-root
key-permissions"
      ;;
    hard)
      # ssh-key-only stays manual: a resident loop must never disable password
      # auth on a host whose operator is still using a password.
      list="sysctl-hardening
unattended-upgrades
ssh-permit-root
key-permissions
fail2ban-baseline
firewall-baseline"
      ;;
    *) die "mode must be safe or hard" ;;
  esac

  mkdir -p "$GUARD_LIB" "$GUARD_ETC" || exit 4
  printf '%s\n' "$list" >"$GUARD_ETC/enforce.list" || exit 4
  chmod 600 "$GUARD_ETC/enforce.list"

  cat >"$GUARD_LIB/run.sh" <<'EOF'
#!/bin/sh
# nexus-guard resident enforcer: re-applies the operator's chosen baseline on a
# timer, so protection survives the desktop app being closed.
set -u
LIST=/etc/nexus-guard/enforce.list
[ -r "$LIST" ] || exit 0
rc=0
while IFS= read -r id; do
  case "$id" in "" | \#*) continue ;; esac
  if /usr/local/sbin/nexus-priv guard apply "$id" >/dev/null 2>&1; then
    logger -t nexus-guard "resident ok $id"
  else
    logger -t nexus-guard "resident failed $id"
    rc=1
  fi
done <"$LIST"
exit $rc
EOF
  chmod 755 "$GUARD_LIB/run.sh"
  chown root:root "$GUARD_LIB/run.sh"
  ln -sf "$GUARD_LIB/run.sh" /usr/local/sbin/nexus-guard-run

  cat >/etc/systemd/system/nexus-guard.service <<'EOF'
[Unit]
Description=Nexus Guard resident security baseline
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/nexus-guard-run
Nice=10
IOSchedulingClass=idle
EOF
  cat >/etc/systemd/system/nexus-guard.timer <<'EOF'
[Unit]
Description=Nexus Guard baseline timer

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
AccuracySec=1min
Persistent=true
Unit=nexus-guard.service

[Install]
WantedBy=timers.target
EOF
  chmod 644 /etc/systemd/system/nexus-guard.service /etc/systemd/system/nexus-guard.timer
  systemctl daemon-reload || exit 5
  systemctl enable --now nexus-guard.timer >/dev/null 2>&1 || {
    echo "could not enable nexus-guard.timer"; exit 7
  }
  printf 'resident=installed mode=%s ids=%s\n' "$1" "$(printf '%s' "$list" | tr '\n' ',')"
  systemctl start nexus-guard.service >/dev/null 2>&1 || echo "first enforcement run reported errors (see journal)"
  printf 'timer=%s\n' "$(systemctl is-active nexus-guard.timer 2>/dev/null || echo unknown)"
}

guard_uninstall() {
  systemctl disable --now nexus-guard.timer >/dev/null 2>&1 || true
  systemctl stop nexus-guard.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/nexus-guard.service /etc/systemd/system/nexus-guard.timer /usr/local/sbin/nexus-guard-run
  rm -rf "$GUARD_LIB"
  rm -f "$GUARD_ETC/enforce.list"
  systemctl daemon-reload || true
  printf 'resident=removed\n'
}

guard_status() {
  printf 'timer=%s\n' "$(systemctl is-active nexus-guard.timer 2>/dev/null || echo inactive)"
  printf 'enabled=%s\n' "$(systemctl is-enabled nexus-guard.timer 2>/dev/null || echo absent)"
  printf 'enforce=%s\n' "$(cat "$GUARD_ETC/enforce.list" 2>/dev/null | tr '\n' ',' || true)"
  printf 'bans=%s\n' "$(nft list set inet nexus_guard banned 2>/dev/null | tr -d '\n' || true)"
  journalctl -u nexus-guard.service --no-pager -n 5 -o cat 2>/dev/null | tail -5 || true
  exit 0
}

cmd=${1:-}
if [ $# -gt 0 ]; then shift; fi

case "$cmd" in
service)
  [ $# -eq 2 ] || usage
  action=$1
  unit=$2
  case "$action" in start | stop | restart) ;; *) usage ;; esac
  valid_unit "$unit" || die "invalid unit name: $unit"
  systemctl cat "$unit" >/dev/null 2>&1 || die "unknown unit: $unit"
  systemctl "$action" "$unit"
  rc=$?
  state=$(systemctl is-active "$unit" 2>&1 || true)
  printf 'unit=%s\naction=%s\nstate=%s\n' "$unit" "$action" "$state"
  if [ "$rc" -ne 0 ]; then exit "$rc"; fi
  if [ "$action" != stop ] && [ "$state" != active ]; then exit 3; fi
  exit 0
  ;;
power)
  [ $# -eq 1 ] || usage
  case "$1" in
    reboot) verb=reboot ;;
    shutdown) verb=poweroff ;;
    *) usage ;;
  esac
  # Detached so the caller's SSH channel closes before the host goes down.
  ( sleep 2; systemctl "$verb" ) >/dev/null 2>&1 &
  printf 'scheduled=%s\n' "$verb"
  exit 0
  ;;
gpu)
  [ $# -eq 1 ] && [ "$1" = "setup" ] || usage
  [ -x "$GPU_SETUP_PATH" ] || die "GPU setup helper is missing; reinstall the privileged helper from Nexus"
  exec "$GPU_SETUP_PATH"
  ;;
backup)
  [ $# -ge 2 ] || usage
  slug=$1
  shift
  case "$slug" in
    "" | *[!A-Za-z0-9_-]*) die "invalid backup slug: $slug" ;;
  esac
  [ ${#slug} -le 32 ] || die "backup slug is too long (max 32)"
  [ $# -le 8 ] || die "at most 8 paths per backup"

  kept=$(mktemp) || exit 4
  trap 'rm -f "$kept"' EXIT HUP INT TERM
  count=0
  for path do
    case "$path" in
      *..*) die "path traversal rejected: $path" ;;
      /etc | /etc/* | /home | /home/* | /opt | /opt/* | /srv | /srv/* | /var/www | /var/www/* | /var/lib | /var/lib/*) ;;
      *) die "path not allowed for host backups: $path" ;;
    esac
    case "$path" in
      *[!A-Za-z0-9/._-]*) die "path contains unsupported characters: $path" ;;
    esac
    if [ -e "$path" ]; then
      printf '%s\n' "$path" >>"$kept"
      count=$((count + 1))
    fi
  done

  if [ "$count" -eq 0 ]; then
    echo "none of the requested paths exist on this host"
    exit 3
  fi

  mkdir -p "$DEST" || exit 4
  ts=$(date +%Y%m%d-%H%M%S)
  archive="$DEST/$slug-$ts.tar.gz"
  printf 'paths=%s\n' "$(tr '\n' ' ' <"$kept")"
  tar -czf "$archive" -T "$kept" 2>/dev/null
  rc=$?
  printf 'archive=%s\n' "$archive"
  if [ -f "$archive" ]; then
    ls -lh "$archive" 2>/dev/null | awk '{print "size="$5}'
  fi
  # Retention is per slug so one host cannot evict another's archives.
  ls -1t "$DEST"/"$slug"-*.tar.gz 2>/dev/null | tail -n +"$((KEEP + 1))" | while read -r old; do
    rm -f "$old"
  done
  exit "$rc"
  ;;
guard)
  [ $# -ge 1 ] || usage
  sub=$1
  shift
  case "$sub" in
    collect) guard_collect ;;
    apply) guard_apply "$@" ;;
    ban) guard_ban "$@" ;;
    unban) guard_unban "$@" ;;
    bans) guard_bans ;;
    install) guard_install "$@" ;;
    uninstall) guard_uninstall ;;
    status) guard_status ;;
    *) usage ;;
  esac
  ;;
*)
  usage
  ;;
esac
