#!/bin/sh
# Nexus PVE — GPU sensor detection and repair.
#
# This script is installed as root-only /usr/local/lib/nexus-gpu-setup.sh and is
# also sent directly by the app when the SSH account is root or can sudo. It
# never modifies a GPU that is bound to vfio-pci: that card belongs to a guest,
# and trying to claim it from the host would break passthrough.
#
# It installs the small user-space sensor tools when possible, loads amdgpu for
# an unbound AMD card, and installs the matching AMD firmware package only when
# the driver is not already active. NVIDIA proprietary drivers are deliberately
# not installed automatically; the script reports that vendor-driver step.

set -u
export LC_ALL=C
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
LOG=${TMPDIR:-/tmp}/nexus-gpu-setup.$$.log
: >"$LOG" 2>/dev/null || true

say() {
  printf '%s\n' "$*"
}

have() {
  command -v "$1" >/dev/null 2>&1
}

pkg_install() {
  [ $# -gt 0 ] || return 0
  say "package=$*"
  case "$PM" in
    apt)
      DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$@" >>"$LOG" 2>&1
      ;;
    dnf)
      dnf install -y "$@" >>"$LOG" 2>&1
      ;;
    yum)
      yum install -y "$@" >>"$LOG" 2>&1
      ;;
    zypper)
      zypper --non-interactive install -y "$@" >>"$LOG" 2>&1
      ;;
    pacman)
      pacman -Sy --noconfirm --needed "$@" >>"$LOG" 2>&1
      ;;
    apk)
      apk add --no-cache "$@" >>"$LOG" 2>&1
      ;;
    *)
      return 1
      ;;
  esac
}

find_hwmon() {
  dev=$1
  for h in "$dev"/hwmon/hwmon*; do
    [ -d "$h" ] && { printf '%s\n' "$h"; return 0; }
  done
  target=$(readlink -f "$dev" 2>/dev/null || true)
  [ -n "$target" ] || return 1
  for h in /sys/class/hwmon/hwmon*; do
    [ "$(readlink -f "$h/device" 2>/dev/null)" = "$target" ] && { printf '%s\n' "$h"; return 0; }
  done
  return 1
}

amd_firmware() {
  case "$PM" in
    apt)
      if apt-cache show firmware-amd-graphics >/dev/null 2>&1; then
        printf '%s\n' firmware-amd-graphics
      elif apt-cache show linux-firmware >/dev/null 2>&1; then
        printf '%s\n' linux-firmware
      fi
      ;;
    dnf | yum | zypper | pacman | apk)
      printf '%s\n' linux-firmware
      ;;
  esac
}

PM=
if have apt-get; then
  PM=apt
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >>"$LOG" 2>&1 || true
elif have dnf; then PM=dnf
elif have yum; then PM=yum
elif have zypper; then PM=zypper
elif have pacman; then PM=pacman
elif have apk; then PM=apk
fi

say "@@gpu-setup"
say "os_package_manager=${PM:-none}"

# These are harmless if already present, and make the read-only probe possible
# on a minimal image. lm-sensors is for the rest of the host; amdgpu telemetry
# itself comes from sysfs and does not require the binary.
if ! have lspci || ! have sensors; then
  if pkg_install pciutils lm-sensors; then
    say "sensor_tools=installed"
  else
    say "sensor_tools=unavailable"
  fi
else
  say "sensor_tools=present"
fi

amd_seen=0
nvidia_seen=0
intel_seen=0
failures=0
skipped=0
loaded=0

for dev in /sys/bus/pci/devices/*; do
  [ -r "$dev/vendor" ] || continue
  class=$(cat "$dev/class" 2>/dev/null || true)
  case "$class" in
    0x0300* | 0x0302* | 0x0380*) ;;
    *) continue ;;
  esac
  pci=$(basename "$dev")
  vendor=$(cat "$dev/vendor" 2>/dev/null || true)
  device=$(cat "$dev/device" 2>/dev/null || true)
  driver=$(basename "$(readlink -f "$dev/driver" 2>/dev/null)" 2>/dev/null || true)

  case "$vendor" in
    0x1002)
      amd_seen=1
      if [ "$driver" = "vfio-pci" ]; then
        say "gpu=$pci vendor=amd driver=vfio-pci action=skipped reason=assigned-to-guest"
        skipped=$((skipped + 1))
        continue
      fi
      if [ "$driver" != "amdgpu" ]; then
        if ! modinfo amdgpu >/dev/null 2>&1; then
          say "gpu=$pci vendor=amd driver=${driver:-none} action=failed reason=amdgpu-module-missing"
          failures=$((failures + 1))
          continue
        fi
        fw=$(amd_firmware)
        if [ -n "$fw" ]; then
          pkg_install "$fw" || say "firmware=$fw action=unavailable"
        fi
        if modprobe amdgpu >>"$LOG" 2>&1; then
          loaded=$((loaded + 1))
        fi
        # Udev normally binds the card; give it a moment before trying bind.
        attempts=0
        while [ "$attempts" -lt 8 ]; do
          driver=$(basename "$(readlink -f "$dev/driver" 2>/dev/null)" 2>/dev/null || true)
          [ "$driver" = "amdgpu" ] && break
          sleep 1
          attempts=$((attempts + 1))
        done
        if [ "$driver" != "amdgpu" ] && [ -e /sys/bus/pci/drivers/amdgpu ]; then
          printf '%s\n' "$pci" >/sys/bus/pci/drivers/amdgpu/bind 2>>"$LOG" || true
          sleep 1
          driver=$(basename "$(readlink -f "$dev/driver" 2>/dev/null)" 2>/dev/null || true)
        fi
      fi
      hwmon=$(find_hwmon "$dev" || true)
      if [ -n "$hwmon" ]; then
        say "gpu=$pci vendor=amd driver=${driver:-none} action=ready hwmon=$hwmon"
      else
        say "gpu=$pci vendor=amd driver=${driver:-none} action=failed reason=no-hwmon"
        failures=$((failures + 1))
      fi
      ;;
    0x10de)
      nvidia_seen=1
      if have nvidia-smi && nvidia-smi -L >/dev/null 2>&1; then
        say "gpu=$pci vendor=nvidia driver=${driver:-none} action=ready"
      elif [ -e /proc/driver/nvidia/version ]; then
        say "gpu=$pci vendor=nvidia driver=${driver:-none} action=partial reason=nvidia-smi-missing"
        failures=$((failures + 1))
      else
        say "gpu=$pci vendor=nvidia driver=${driver:-none} action=blocked reason=vendor-driver-required"
        failures=$((failures + 1))
      fi
      ;;
    0x8086)
      intel_seen=1
      say "gpu=$pci vendor=intel driver=${driver:-none} action=unsupported"
      ;;
  esac
done

if [ "$amd_seen" -eq 0 ] && [ "$nvidia_seen" -eq 0 ] && [ "$intel_seen" -eq 0 ]; then
  say "result=no-gpu"
  say "@@result=no-gpu"
elif [ "$failures" -gt 0 ] && [ "$skipped" -gt 0 ]; then
  say "result=partial"
  say "@@result=partial"
elif [ "$failures" -gt 0 ]; then
  say "result=partial"
  say "@@result=partial"
elif [ "$skipped" -gt 0 ]; then
  say "result=blocked"
  say "@@result=blocked"
else
  say "result=ok"
  say "@@result=ok"
fi
say "loaded_amdgpu=$loaded"
say "@@end"
