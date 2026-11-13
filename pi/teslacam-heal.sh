#!/bin/bash
# teslacam-heal.sh - undo anything a killed, crashed or power-cut run left behind.
#
# Safe to run at any time: it only acts when no upload and no drive job is running (it checks
# their locks). Run by teslacam-sync.sh at the start of every run, and every minute by the
# diagnostics recorder. Everything it fixes is logged as "HEALED" in the diagnostics events log.
#
#   - stale mounts of the car drive or an old PC-share mount   -> unmounted (lazily if needed)
#   - loop devices still holding the car drive image           -> released
#   - car's USB drive not offered to the car                   -> offered again (the car must
#                                                                 never be left without its drive)
#   - half-written temp files older than an hour               -> removed
set -u
DIAG_DIR=/var/lib/teslacam/metrics/diag
CAM_IMG=/piusb/cam.bin

if [ "${1:-}" != "--have-sync-lock" ]; then
    exec 7>/run/teslacam-sync.lock
    flock -n 7 || exit 0                       # an upload is running - leave everything alone
fi
exec 6>/run/teslacam-drive.lock
flock -n 6 || exit 0                           # the save job or a drive peek is running

fixed=()
for m in /mnt/cam /mnt/campeek /mnt/camarchive /mnt/archive; do
    if mountpoint -q "$m"; then
        timeout 20 umount "$m" 2>/dev/null || umount -l "$m" 2>/dev/null
        fixed+=("unmounted stale $m")
    fi
done
for dev in $(losetup -j "$CAM_IMG" -n -O NAME 2>/dev/null); do
    losetup -d "$dev" 2>/dev/null && fixed+=("released $dev")
done
if ! systemctl is-active --quiet teslacam-usb.service; then
    systemctl start teslacam-usb.service && fixed+=("offered the USB drive to the car again")
fi
stale=$(find /var/lib/teslacam/recent-archive /var/lib/teslacam/event-outbox -name '*.part' -mmin +60 -print -delete 2>/dev/null | wc -l)
[ "$stale" -gt 0 ] && fixed+=("removed $stale half-written temp file(s)")

if [ ${#fixed[@]} -gt 0 ]; then
    msg="HEALED: $(printf '%s; ' "${fixed[@]}")"
    msg="${msg%; }"
    logger -t teslacam-heal "$msg"
    mkdir -p "$DIAG_DIR"
    printf '\n===== %s  %s\n' "$(date -Iseconds)" "$msg" >> "$DIAG_DIR/events-$(date +%Y-%m).log"
    echo "$msg"
fi
exit 0
