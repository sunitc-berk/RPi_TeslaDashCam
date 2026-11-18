#!/bin/bash
# install.sh - run on the Pi from the folder containing these files:  sudo bash ~/pi/install.sh
# Safe to run again after updating any of the files.
set -e
cd "$(dirname "$0")"

apt-get install -y smbclient cifs-utils rsync dosfstools iw python3 rfkill || echo "(package install skipped - no internet? continuing)"

install -m 755 teslacam-sync.sh         /usr/local/bin/teslacam-sync.sh
install -m 755 teslacam-metrics.py      /usr/local/bin/teslacam-metrics.py
install -m 755 teslacam-archive.py      /usr/local/bin/teslacam-archive.py
install -m 644 teslacam_sei.py          /usr/local/bin/teslacam_sei.py       # driving or parked? (used by archive)
install -m 755 teslacam-manifest.py     /usr/local/bin/teslacam-manifest.py
install -m 755 teslacam-diag.py         /usr/local/bin/teslacam-diag.py
install -m 755 teslacam-upload.py       /usr/local/bin/teslacam-upload.py
install -m 755 teslacam-heal.sh         /usr/local/bin/teslacam-heal.sh
install -m 755 teslacam-report-failure.sh /usr/local/bin/teslacam-report-failure.sh   # a failing job is logged, never silent
install -m 644 teslacam-usb.service     /etc/systemd/system/teslacam-usb.service   # checks the drive at power-up
for unit in teslacam-sync teslacam-metrics teslacam-archive teslacam-diag; do
    install -m 644 "$unit.service" "/etc/systemd/system/$unit.service"
    install -m 644 "$unit.timer"   "/etc/systemd/system/$unit.timer"
done
install -m 644 teslacam-diag-boot.service /etc/systemd/system/teslacam-diag-boot.service
mkdir -p /mnt/cam /mnt/campeek /mnt/camarchive /var/lib/teslacam/metrics/diag /var/lib/teslacam/recent-archive /var/lib/teslacam/event-outbox

if [ ! -f /root/.teslacam-smb ]; then
    read -rp  "Windows share username [teslapi]: " u; u=${u:-teslapi}
    read -rsp "Windows share password: " p; echo
    printf 'username=%s\npassword=%s\n' "$u" "$p" > /root/.teslacam-smb
    chmod 600 /root/.teslacam-smb
fi

# Wi-Fi reliability: no power saving (a common cause of Pi Wi-Fi drop-outs), and never give up reconnecting
mkdir -p /etc/NetworkManager/conf.d
printf '[connection]\nwifi.powersave = 2\n' > /etc/NetworkManager/conf.d/teslacam-wifi.conf
nmcli -t -f NAME,TYPE connection show | while IFS= read -r line; do
    [ "${line##*:}" = "802-11-wireless" ] || continue
    nmcli connection modify "${line%:*}" connection.autoconnect yes connection.autoconnect-retries 0 || true
done
nmcli general reload conf 2>/dev/null || true
for w in /sys/class/net/wl*; do iw dev "$(basename "$w")" set power_save off 2>/dev/null || true; done

# Logs survive power cuts (Raspberry Pi OS keeps them in memory only by default)
mkdir -p /var/log/journal /etc/systemd/journald.conf.d
printf '[Journal]\nStorage=persistent\nSystemMaxUse=200M\n' > /etc/systemd/journald.conf.d/99-teslacam-persistent.conf
systemctl restart systemd-journald
journalctl --flush 2>/dev/null || true

# Back up the Wi-Fi settings now (the diagnostics restore them if a power cut ever loses them)
python3 /usr/local/bin/teslacam-diag.py --backup-wifi || true

systemctl daemon-reload
systemctl enable --now teslacam-metrics.timer teslacam-sync.timer teslacam-archive.timer teslacam-diag.timer
systemctl enable --now teslacam-diag-boot.service
systemctl enable teslacam-usb.service
command -v smbclient >/dev/null || echo "WARNING: smbclient is missing - uploads need it (sudo apt-get install smbclient)"

# Self-check: every script must load, with everything it imports, before we call this installed
ok=1
for f in teslacam-metrics.py teslacam-archive.py teslacam-manifest.py teslacam-diag.py teslacam-upload.py; do
    python3 - "/usr/local/bin/$f" <<'PY' || ok=0
import ast, importlib, sys
path = sys.argv[1]
sys.path.insert(0, "/usr/local/bin")
try:
    tree = ast.parse(open(path).read(), path)
    for node in ast.walk(tree):
        names = [a.name for a in node.names] if isinstance(node, ast.Import) else [node.module] if isinstance(node, ast.ImportFrom) and node.module else []
        for n in names:
            importlib.import_module(n)
except Exception as e:
    print(f"SELF-CHECK FAILED: {path}: {e!r}")
    sys.exit(1)
PY
done
if [ "$ok" = 1 ]; then
    echo "Self-check passed: all scripts load."
    # Remember when this software was installed and a short fingerprint of it; the dashboard's Pi page shows both
    mkdir -p /etc/teslacam
    ver=$(cat /usr/local/bin/teslacam-*.py /usr/local/bin/teslacam-*.sh /usr/local/bin/teslacam_sei.py 2>/dev/null | sha256sum | cut -c1-7)
    printf '{"installed_at": "%s", "version": "%s"}\n' "$(date -Iseconds)" "$ver" > /etc/teslacam/installed.json
    echo "Software version $ver, installed $(date '+%b %-d %H:%M')."
else
    echo; echo "*** INSTALL PROBLEM: see SELF-CHECK FAILED above. Footage may not be saved until this is fixed. ***"; fi
/usr/local/bin/teslacam-heal.sh || true

echo
echo "Installed. Recent footage is saved every 5 min, metrics every 5 min, sync checks every 2 min."
echo "Save recent footage now:     sudo /usr/local/bin/teslacam-archive.py"
echo "Upload now:                  sudo /usr/local/bin/teslacam-sync.sh"
echo "Watch activity:              journalctl -t teslacam-archive -t teslacam-sync -t teslacam-diag -f"
echo "Diagnostics summary:         sudo teslacam-diag.py --report"
