#!/bin/bash
# shellcheck disable=SC2034
# teslacam-sync.sh - get dashcam footage and Pi metrics from the car to the home PC.
#
# Runs every 2 minutes (teslacam-sync.timer). Designed to survive Wi-Fi drops and power cuts at
# ANY point without getting stuck:
#   - The PC share is never mounted. Uploads use smbclient (teslacam-upload.py): an ordinary
#     program with time limits that can always be stopped. Wi-Fi drops just end the run early.
#   - Nothing is deleted from the Pi or the car drive until the PC copy is confirmed (same size).
#     Files appear on the PC only when complete (uploaded as .name.part, then renamed).
#   - Saved/Sentry clips are first copied to the Pi's SD card (fast, local), then the drive is
#     handed straight back to the car. The car is never without its drive while uploading.
#   - Every run starts by healing leftovers from a killed or power-cut run (teslacam-heal.sh).
#   - Every step has a time limit; the next run picks up where this one stopped.
#
# Steps each run:
#   1. heal
#   2. (at home, car idle) copy new Saved/Sentry clips from the car drive to the Pi  [event-outbox]
#   3. (PC reachable) upload: Saved/Sentry clips, recent footage, metrics; daily PC clean-up

set -u

# ---------------- settings (edit these) ----------------
# (PC_HOST, SHARE_NAME and CREDS are also read from this file by teslacam-upload.py)
# shellcheck disable=SC2034  # these three are read by teslacam-upload.py
PC_HOST="192.168.68.71"            # your PC's IP address (reserve it in your router)
SHARE_NAME="TeslaCam"              # Windows share name
CREDS="/root/.teslacam-smb"        # file holding the share's username/password
FOLDERS="SavedClips SentryClips"   # event folders taken from the car drive
IDLE_SECONDS=60                    # car must be quiet this long before we take the drive
RECENT_RETENTION_DAYS=30           # delete RecentClips on the PC older than this (0 = keep forever)
MAX_UPLOAD_MIN=45                  # upload at most this long per folder per run (next run continues)
MAX_STAGE_MIN=10                   # car drive is detached for at most this long per run
MIN_FREE_GB=6                      # never fill the Pi's SD card below this when copying events
# --------------------------------------------------------

CAM_IMG="/piusb/cam.bin"
CAM_MNT="/mnt/cam"
STATE_DIR="/var/lib/teslacam"
LOCAL_RECENT="$STATE_DIR/recent-archive"
EVENT_OUTBOX="$STATE_DIR/event-outbox"
STAMP="$STATE_DIR/last-sync"
LAST_PI_WRITE="$STATE_DIR/last-pi-write"
METRICS_DIR="$STATE_DIR/metrics"
METRICS_STAMP="$STATE_DIR/last-metrics-copy"
RETENTION_STAMP="$STATE_DIR/last-retention"
METRICS_TOOL="/usr/local/bin/teslacam-metrics.py"
MANIFEST_TOOL="/usr/local/bin/teslacam-manifest.py"
UPLOAD_TOOL="/usr/local/bin/teslacam-upload.py"
HEAL_TOOL="/usr/local/bin/teslacam-heal.sh"
RUN_DIR="/run/teslacam"
GADGET_SERVICE="teslacam-usb.service"
DRIVE_LOCK="/run/teslacam-drive.lock"

log() { echo "$*"; logger -t teslacam-sync "$*"; }

# Only one copy of this script at a time
exec 9>/run/teslacam-sync.lock
flock -n 9 || exit 0

mkdir -p "$STATE_DIR" "$METRICS_DIR" "$LOCAL_RECENT" "$EVENT_OUTBOX" "$CAM_MNT" "$RUN_DIR"

# ---------------------------------------------------------------- 1. heal leftovers
[ -x "$HEAL_TOOL" ] && "$HEAL_TOOL" --have-sync-lock

# ---------------------------------------------------------------- always hand the drive back
GADGET_STOPPED=0
CAM_RW=0
cleanup() {
    sync
    if mountpoint -q "$CAM_MNT"; then
        timeout 30 umount "$CAM_MNT" 2>/dev/null || umount -l "$CAM_MNT"
    fi
    [ "$CAM_RW" = 1 ] && touch "$LAST_PI_WRITE"     # tells the metrics script this change was ours
    if [ "$GADGET_STOPPED" = 1 ]; then
        for _ in 1 2 3; do
            systemctl start "$GADGET_SERVICE" && break
            sleep 3
        done
        log "Drive handed back to the car"
    fi
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP                           # run cleanup on stop/kill signals too

# ---------------------------------------------------------------- helpers
pc_up() { timeout 3 bash -c "</dev/tcp/${PC_HOST}/445" 2>/dev/null; }

json_bool() { [ "$1" = 1 ] && echo true || echo false; }

history() {   # kind files bytes duration ok
    local mbps synced
    mbps=$(awk -v b="$3" -v d="$4" 'BEGIN { printf "%.1f", (d > 0 ? b / d / 1e6 : 0) }')
    synced=$(timedatectl show -p NTPSynchronized --value 2>/dev/null)
    printf '{"time_pi":"%s","kind":"%s","clock_synced":%s,"boot_id":"%s","duration_s":%d,"files":%d,"mb":%d,"mb_per_s":%s,"success":%s}\n' \
        "$(date -Iseconds)" "$1" "$([ "$synced" = yes ] && echo true || echo false)" \
        "$(cat /proc/sys/kernel/random/boot_id)" "$4" "$2" "$(( $3 / 1000000 ))" "$mbps" \
        "$(json_bool "$5")" >> "$METRICS_DIR/sync-history.jsonl"
    echo "$mbps"
}

# upload_outbox DIR KIND: upload every finished file in DIR (paths kept), confirm, then delete locally
upload_outbox() {
    local dir="$1" kind="$2" list="$RUN_DIR/upload.list" ok_list="$RUN_DIR/upload.ok"
    local n sz start rc done_n done_b mbps
    find "$dir" -type f ! -name '*.part' ! -name '.*' -printf '%P\t%s\n' | sort > "$list"
    n=$(wc -l < "$list")
    [ "$n" -gt 0 ] || return 0
    sz=$(awk -F'\t' '{s+=$2} END {print s+0}' "$list")
    : > "$ok_list"
    start=$(date +%s)
    log "Uploading $n $kind files ($(( sz / 1000000 )) MB) saved on the Pi"
    timeout -k 30 $(( MAX_UPLOAD_MIN * 60 + 300 )) \
        python3 "$UPLOAD_TOOL" --list "$list" --src "$dir" --verified "$ok_list" --max-minutes "$MAX_UPLOAD_MIN" --label "$kind"
    rc=$?
    # record and then remove ONLY the files confirmed on the PC
    if [ -s "$ok_list" ]; then
        "$MANIFEST_TOOL" --kind auto --list "$ok_list" --src "$dir" >/dev/null 2>&1
        while IFS=$'\t' read -r rel _; do
            rm -f -- "$dir/$rel"
        done < "$ok_list"
        find "$dir" -mindepth 1 -type d -empty -delete 2>/dev/null
    fi
    done_n=$(wc -l < "$ok_list")
    done_b=$(awk -F'\t' '{s+=$2} END {print s+0}' "$ok_list")
    mbps=$(history "$kind" "$done_n" "$done_b" $(( $(date +%s) - start )) "$([ "$rc" = 0 ] && echo 1 || echo 0)")
    if [ "$rc" = 0 ]; then
        log "Uploaded $done_n $kind files, $(( done_b / 1000000 )) MB (${mbps} MB/s)"
    else
        log "ERROR: $kind upload stopped early (code $rc) - $done_n of $n files done, the rest continues next run"
    fi
    return 0
}

status() {   # state [note]: live status for the dashboard's Status page (informational only)
    timeout -k 5 45 python3 "$UPLOAD_TOOL" --heartbeat --state "$1" --note "${2:-}" >/dev/null 2>&1 || true
}

copy_metrics() {
    [ -x "$METRICS_TOOL" ] && timeout 120 "$METRICS_TOOL" --fixup
    local list="$RUN_DIR/metrics.list" ok_list="$RUN_DIR/metrics.ok" mark="$RUN_DIR/metrics.mark"
    touch "$mark"                                   # files changed after this point go next time
    if [ -e "$METRICS_STAMP" ]; then
        find "$METRICS_DIR" -type f -newer "$METRICS_STAMP" -printf '%P\t%s\n' > "$list"
    else
        find "$METRICS_DIR" -type f -printf '%P\t%s\n' > "$list"
    fi
    [ -s "$list" ] || return 0
    : > "$ok_list"
    timeout -k 15 600 python3 "$UPLOAD_TOOL" --list "$list" --src "$METRICS_DIR" --dest-prefix PiMetrics \
        --verified "$ok_list" --max-minutes 8 >/dev/null && mv "$mark" "$METRICS_STAMP"
}

apply_retention() {   # once a day: remove old RecentClips from the PC
    (( RECENT_RETENTION_DAYS > 0 )) || return 0
    [ -e "$RETENTION_STAMP" ] && [ -z "$(find "$RETENTION_STAMP" -mmin +1440)" ] && return 0
    timeout -k 15 900 python3 "$UPLOAD_TOOL" --retention "$RECENT_RETENTION_DAYS" | while read -r l; do log "$l"; done
    touch "$RETENTION_STAMP"
}

count_clips() {   # number of event files under mount point $1
    local total=0 base f
    for base in "$1/TeslaCam" "$1/TeslaCam/EncryptedClips"; do
        for f in $FOLDERS; do
            [ -d "$base/$f" ] && total=$(( total + $(find "$base/$f" -type f | wc -l) ))
        done
    done
    echo "$total"
}

# stage_events: copy new Saved/Sentry clips from the car drive to the Pi's SD card, quickly,
# then give the drive straight back. Clips are removed from the car drive only after each file
# is safely on the SD card.
stage_events() {
    exec 8>"$DRIVE_LOCK"
    flock -w 300 8 || return 0
    # anything new since last time, and has the car stopped recording?
    if [ -e "$STAMP" ] && ! [ "$CAM_IMG" -nt "$STAMP" ]; then return 0; fi
    local quiet=$(( $(date +%s) - $(stat -c %Y "$CAM_IMG") ))
    (( quiet >= IDLE_SECONDS )) || return 0
    # peek read-only (car keeps the drive) - anything to copy?
    local pending=0
    if timeout 60 mount -o loop,ro "$CAM_IMG" "$CAM_MNT" 2>/dev/null; then
        pending=$(count_clips "$CAM_MNT")
        timeout 30 umount "$CAM_MNT" || umount -l "$CAM_MNT"
    fi
    if [ "$pending" -eq 0 ]; then touch "$STAMP"; return 0; fi

    log "Copying $pending Saved/Sentry files from the car drive to the Pi (drive detached for at most $MAX_STAGE_MIN min)"
    status staging "Copying $pending Saved/Sentry files from the car drive to the Pi"
    local deadline=$(( $(date +%s) + MAX_STAGE_MIN * 60 )) all_done=1 moved=0 base f ev src dst size free
    systemctl stop "$GADGET_SERVICE"
    GADGET_STOPPED=1
    sleep 2
    timeout 120 fsck.vfat -a "$CAM_IMG" >/dev/null 2>&1    # repair if the car lost power mid-write
    if ! timeout 60 mount -o loop "$CAM_IMG" "$CAM_MNT"; then
        log "ERROR: could not open the car drive"
        return 0
    fi
    CAM_RW=1
    for base in "TeslaCam" "TeslaCam/EncryptedClips"; do
        for f in $FOLDERS; do
            [ -d "$CAM_MNT/$base/$f" ] || continue
            for ev in "$CAM_MNT/$base/$f"/*/; do
                [ -d "$ev" ] || continue
                src="${ev%/}"
                dst="$EVENT_OUTBOX/${base#TeslaCam}/$f/$(basename "$src")"
                dst="${dst/\/\//\/}"
                size=$(du -sb "$src" | cut -f1)
                free=$(df --output=avail -B1 / | tail -n 1)
                if (( $(date +%s) > deadline )) || (( free - size < MIN_FREE_GB * 1000000000 )); then
                    all_done=0
                    break 3
                fi
                mkdir -p "$dst"
                # local copy; each source file is removed only after it is fully copied
                if timeout 600 rsync -rt --no-perms --no-owner --no-group --remove-source-files \
                        "$src/" "$dst/"; then
                    rmdir "$src" 2>/dev/null
                    moved=$(( moved + 1 ))
                else
                    all_done=0
                fi
            done
        done
    done
    sync
    timeout 30 umount "$CAM_MNT" || umount -l "$CAM_MNT"
    systemctl start "$GADGET_SERVICE" && GADGET_STOPPED=0
    log "Copied $moved event folder(s) to the Pi and handed the drive back to the car"
    [ "$all_done" = 1 ] && touch "$STAMP"
    flock -u 8
    return 0
}

# ---------------------------------------------------------------- 2. + 3.
pc_up || exit 0                         # not home (or PC off) - nothing to do

status idle
stage_events
pc_up || exit 0
copy_metrics
upload_outbox "$EVENT_OUTBOX" events
pc_up && upload_outbox "$LOCAL_RECENT" recent
pc_up && apply_retention
pc_up && copy_metrics
pc_up && status idle
exit 0
