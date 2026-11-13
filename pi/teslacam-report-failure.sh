#!/bin/sh
# teslacam-report-failure.sh NAME - called by systemd each time the job "teslacam-NAME" ends.
# If the job failed, this writes an entry to the diagnostics log (the dashboard's System page shows it),
# at most once an hour, so a broken job can never fail silently. The first good run afterwards is logged too.
name="${1:-job}"
flag="${TESLACAM_RUN_DIR:-/run}/teslacam-failed-$name"
dir="${TESLACAM_DIAG_DIR:-/var/lib/teslacam/metrics/diag}"
log="$dir/events-$(date +%Y-%m).log"
mkdir -p "$dir"
if [ "$SERVICE_RESULT" = "success" ]; then
    if [ -e "$flag" ]; then
        rm -f "$flag"
        printf '\n===== %s  JOB RECOVERED: %s is working again\n' "$(date -Iseconds)" "$name" >> "$log"
    fi
    exit 0
fi
if [ -e "$flag" ] && [ $(( $(date +%s) - $(stat -c %Y "$flag") )) -lt 3600 ]; then exit 0; fi
touch "$flag"
{
    printf '\n===== %s  JOB FAILED: %s is not working (%s, exit code %s)\n' "$(date -Iseconds)" "$name" "${SERVICE_RESULT:-unknown}" "${EXIT_STATUS:-?}"
    journalctl -u "teslacam-$name.service" -n 8 --no-pager -o cat 2>/dev/null
} >> "$log"
exit 0
