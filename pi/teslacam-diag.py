#!/usr/bin/env python3
"""teslacam-diag.py - diagnostics recorder and Wi-Fi watchdog for the TeslaCam Pi.

  teslacam-diag.py              take one sample (run every minute by teslacam-diag.timer)
  teslacam-diag.py --boot       record a power-up (teslacam-diag-boot.service, at boot)
  teslacam-diag.py --shutdown   mark a clean shutdown (same service, at shutdown)
  teslacam-diag.py --report [H] human-readable summary of the last H hours (default 24)
  teslacam-diag.py --backup-wifi  save a copy of the Wi-Fi settings (restored automatically if lost)
  teslacam-diag.py --bundle     collect everything useful for troubleshooting into one file

Writes to /var/lib/teslacam/metrics/diag/  (copied to \\\\PC\\TeslaCam\\PiMetrics\\diag by the sync):
  net-YYYY-MM-DD.jsonl   one line per minute: Wi-Fi, gateway ping, PC reachable, power, heat, disk
  events-YYYY-MM.log     readable log of power-ups, Wi-Fi drops (with a detailed snapshot),
                         reconnects, recovery actions, car connect/disconnect, power or heat
                         problems, low SD space, PC/upload problems and lost footage
  bundle-*.tar.gz        support bundle made by --bundle (logs + config, no passwords)

Wi-Fi watchdog: if the Pi has been disconnected for 3+ minutes while your home network is
visible (so it is at home and SHOULD be connected), it tries, one step per attempt:
  1. reconnect   2. turn Wi-Fi off/on   3. reload the Wi-Fi driver   4. restart NetworkManager
It never reboots the Pi. Away from home (home network not visible) it does nothing.
"""
import fcntl
import glob
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta

DIAG_DIR = "/var/lib/teslacam/metrics/diag"
STATE = "/var/lib/teslacam/diag-state.json"
CLEAN_MARK = "/var/lib/teslacam/clean-shutdown"
LOCK = "/run/teslacam-diag.lock"
SYNC_SCRIPT = "/usr/local/bin/teslacam-sync.sh"
IFACE = "wlan0"
RECOVER_AFTER_S = 180          # disconnected this long (with home Wi-Fi visible) before acting
RECOVER_EVERY_S = 180          # wait between recovery steps
RECOVER_BACKOFF_S = 900        # after all steps were tried, wait this long before starting over
KEEP_DAYS = 60
LOCAL_RECENT = "/var/lib/teslacam/recent-archive"
SYNC_HISTORY = "/var/lib/teslacam/metrics/sync-history.jsonl"
PC_DOWN_ALERT_MIN = 10       # online but PC share unreachable this long -> event
HOT_C, COOL_C = 75, 68       # heat event above HOT_C, cleared below COOL_C
LOW_SD_GB = 3                # low space event below this
THROTTLE_BITS = {0: "under-voltage now", 1: "speed capped now", 2: "throttled now", 3: "soft temperature limit now",
                 16: "under-voltage has occurred", 17: "speed capping has occurred",
                 18: "throttling has occurred", 19: "soft temperature limit has occurred"}
NM_DIR = "/etc/NetworkManager/system-connections"
WIFI_BACKUP = "/var/lib/teslacam/wifi-backup"     # copy of the Wi-Fi settings, restored if they vanish


# ------------------------------------------------------------------ helpers
def run(cmd, timeout=15):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return (r.stdout or "") + (r.stderr if r.returncode and r.stderr else "")
    except Exception as e:
        return f"<{cmd[0]} failed: {e}>"


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return None


def now_iso(t=None):
    return datetime.fromtimestamp(t or time.time()).astimezone().isoformat(timespec="seconds")


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(st):
    tmp = STATE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(st, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, STATE)


def event(title, details=""):
    os.makedirs(DIAG_DIR, exist_ok=True)
    path = f"{DIAG_DIR}/events-{datetime.now().strftime('%Y-%m')}.log"
    with open(path, "a") as f:
        f.write(f"\n===== {now_iso()}  {title}\n")
        if details:
            f.write(details.rstrip() + "\n")
    subprocess.run(["logger", "-t", "teslacam-diag", title])


# ------------------------------------------------------------------ measurements
def wifi_status():
    w = {"connected": False}
    link = run(["iw", "dev", IFACE, "link"])
    if link.startswith("Connected"):
        w["connected"] = True
        for key, pat in [("bssid", r"Connected to ([0-9a-f:]{17})"), ("ssid", r"SSID: (.+)"),
                         ("signal_dbm", r"signal: (-?\d+)"), ("freq_mhz", r"freq: ([\d.]+)"),
                         ("tx_mbps", r"tx bitrate: ([\d.]+)"), ("rx_mbps", r"rx bitrate: ([\d.]+)")]:
            m = re.search(pat, link)
            if m:
                w[key] = m.group(1) if key in ("bssid", "ssid") else float(m.group(1))
    nm = run(["nmcli", "-t", "-f", "DEVICE,STATE,CONNECTION", "device"])
    for line in nm.splitlines():
        parts = line.split(":")
        if parts and parts[0] == IFACE and len(parts) >= 3:
            w["nm_state"], w["nm_connection"] = parts[1], parts[2] or None
    m = re.search(r"inet (\d+\.\d+\.\d+\.\d+)", run(["ip", "-4", "addr", "show", IFACE]))
    w["ip"] = m.group(1) if m else None
    w["radio"] = run(["nmcli", "radio", "wifi"]).strip() or None
    return w


def gateway():
    m = re.search(r"default via (\d+\.\d+\.\d+\.\d+)", run(["ip", "route"]))
    return m.group(1) if m else None


def ping(host):
    if not host:
        return None, None
    out = run(["ping", "-c", "3", "-W", "1", "-q", host], timeout=10)
    loss = re.search(r"(\d+)% packet loss", out)
    avg = re.search(r"= [\d.]+/([\d.]+)/", out)
    return (float(avg.group(1)) if avg else None), (int(loss.group(1)) if loss else None)


def pc_reachable():
    m = re.search(r'^PC_HOST="([^"]+)"', read(SYNC_SCRIPT) or "", re.M)
    if not m:
        return None
    try:
        with socket.create_connection((m.group(1), 445), timeout=2):
            return True
    except OSError:
        return False


def visible_networks(rescan=False):
    """SSIDs the Pi can currently see (strongest signal per SSID)."""
    out = run(["nmcli", "-t", "-f", "SSID,SIGNAL,CHAN", "device", "wifi", "list",
               "--rescan", "yes" if rescan else "auto"], timeout=30)
    nets = {}
    for line in out.splitlines():
        parts = line.rsplit(":", 2)
        if len(parts) == 3 and parts[0]:
            ssid, sig = parts[0].replace("\\:", ":"), parts[1]
            if sig.isdigit():
                nets[ssid] = max(nets.get(ssid, 0), int(sig))
    return nets


def health():
    th = run(["vcgencmd", "get_throttled"]).strip()
    temp = read("/sys/class/thermal/thermal_zone0/temp")
    mem = {}
    for line in (read("/proc/meminfo") or "").splitlines():
        k, v = line.split(":", 1)
        mem[k] = int(v.split()[0]) // 1024
    du = shutil.disk_usage("/")
    states = glob.glob("/sys/class/udc/*/state")
    return {
        "cpu_temp_c": round(int(temp) / 1000, 1) if temp else None,
        "throttled": th.split("=")[1] if "=" in th else None,
        "mem_available_mb": mem.get("MemAvailable"),
        "sd_free_gb": round(du.free / 1e9, 2),
        "load1": round(os.getloadavg()[0], 2),
        "usb_state": read(states[0]) if states else None,
    }


def snapshot():
    """Detailed text snapshot for the events log when something goes wrong."""
    sections = [
        ("NetworkManager devices", ["nmcli", "device", "status"]),
        ("Wi-Fi link", ["iw", "dev", IFACE, "link"]),
        ("Wi-Fi power saving", ["iw", "dev", IFACE, "get", "power_save"]),
        ("Radio switches", ["rfkill", "list"]),
        ("Visible networks", ["nmcli", "-f", "SSID,BSSID,CHAN,SIGNAL,SECURITY", "device", "wifi", "list"]),
        ("IP addresses", ["ip", "-4", "addr", "show", IFACE]),
        ("Routes", ["ip", "route"]),
        ("NetworkManager log (last 15 min)", ["journalctl", "-u", "NetworkManager", "-u", "wpa_supplicant",
                                              "--since", "-15min", "--no-pager", "-n", "60", "-o", "short-iso"]),
        ("Kernel Wi-Fi / SD / power messages (last 15 min)",
         ["bash", "-c", "journalctl -k --since -15min --no-pager -o short-iso | "
                        "grep -iE 'brcm|wlan|mmc|voltage|ieee80211|cfg80211' | tail -40"]),
        ("Power / heat", ["bash", "-c", "vcgencmd get_throttled; vcgencmd measure_temp; vcgencmd measure_volts core"]),
        ("Disk", ["df", "-h", "/"]),
        ("Memory", ["free", "-m"]),
        ("Busiest processes", ["bash", "-c", "ps -eo pid,pcpu,pmem,etime,comm --sort=-pcpu | head -8"]),
    ]
    out = []
    for title, cmd in sections:
        out.append(f"--- {title}\n{run(cmd, timeout=40).rstrip()}")
    return "\n".join(out)


# ------------------------------------------------------------------ Wi-Fi recovery
def wifi_connections():
    out = run(["nmcli", "-t", "-f", "NAME,TYPE", "connection", "show"])
    return [l.rsplit(":", 1)[0] for l in out.splitlines() if l.endswith(":802-11-wireless")]


def recover(step, home_conn):
    steps = [
        ("reconnect", [["nmcli", "connection", "up", "id", home_conn]] if home_conn
                      else [["nmcli", "device", "connect", IFACE]]),
        ("Wi-Fi off/on", [["nmcli", "radio", "wifi", "off"], ["sleep", "3"], ["nmcli", "radio", "wifi", "on"]]),
        ("reload Wi-Fi driver", [["bash", "-c", "modprobe -r brcmfmac_wcc brcmfmac_cyw brcmfmac 2>/dev/null; "
                                                "sleep 3; modprobe brcmfmac"]]),
        ("restart NetworkManager", [["systemctl", "restart", "NetworkManager"]]),
    ]
    name, cmds = steps[step % len(steps)]
    output = "\n".join(f"$ {' '.join(c)}\n{run(c, timeout=60).rstrip()}" for c in cmds)
    return name, output


def is_wifi_profile(text):
    """A complete Wi-Fi profile: right type and an SSID (a file cut short by a power cut has neither)."""
    return bool(re.search(r"^type=(wifi|802-11-wireless)", text, re.M) and re.search(r"^ssid=.+", text, re.M))


def wifi_profile_files(folder=NM_DIR):
    out = []
    for p in glob.glob(f"{folder}/*.nmconnection"):
        try:
            with open(p, errors="replace") as f:
                if is_wifi_profile(f.read()):
                    out.append(p)
        except OSError:
            pass
    return out


def write_durably(path, data, mode=0o600):
    """Write a file so that it survives a power cut right afterwards: temp file, fsync, rename, fsync folder."""
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.chmod(tmp, mode)
    os.replace(tmp, path)
    fd = os.open(os.path.dirname(path), os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def backup_wifi():
    """Keep a copy of the Wi-Fi settings (they can be lost when the car cuts power mid-write)."""
    files = wifi_profile_files()
    if not files:
        return
    os.makedirs(WIFI_BACKUP, mode=0o700, exist_ok=True)
    for p in files:
        dst = os.path.join(WIFI_BACKUP, os.path.basename(p))
        try:
            with open(p, "rb") as a:
                new = a.read()
            old = open(dst, "rb").read() if os.path.exists(dst) else None
            if new != old and is_wifi_profile(new.decode(errors="replace")):   # never back up a damaged file
                write_durably(dst, new)
        except OSError:
            pass


def restore_wifi_if_missing():
    """If the Wi-Fi settings file is gone or damaged on disk, put the backup back.

    Judged by the files on disk, NOT by asking NetworkManager: right after power-up NetworkManager may
    not be running yet, and asking it then wrongly looked like "no Wi-Fi saved" (a false alarm that
    also rewrote a good file - risky if the power is cut again moments later)."""
    backups = wifi_profile_files(WIFI_BACKUP)
    if not backups:
        return False
    restored = []
    for p in backups:
        dst = os.path.join(NM_DIR, os.path.basename(p))
        try:
            cur = open(dst, errors="replace").read() if os.path.exists(dst) else ""
        except OSError:
            cur = ""
        if is_wifi_profile(cur):
            continue                                  # this network's settings are fine
        if not os.path.exists(dst) and wifi_profile_files():
            continue                                  # saved under another file name (e.g. re-added by hand)
        with open(p, "rb") as f:
            write_durably(dst, f.read())
        restored.append(os.path.basename(p) + (" (file was damaged)" if cur else " (file was missing)"))
    if not restored:
        return False
    out = ""
    if run(["systemctl", "is-active", "NetworkManager"]).strip() == "active":
        out = run(["nmcli", "connection", "reload"]) + run(["nmcli", "device", "connect", IFACE], timeout=45)
    else:
        out = "NetworkManager not running yet - it will load the restored settings when it starts"
    event("WI-FI SETTINGS WERE MISSING - restored from backup", f"Restored: {', '.join(restored)}\n{out}")
    return True


def pipeline():
    """How much footage is waiting on the Pi, and the last upload."""
    files = size = 0
    for root, _, names in os.walk(LOCAL_RECENT):
        for n in names:
            if not n.endswith(".part"):
                try:
                    size += os.path.getsize(os.path.join(root, n))
                    files += 1
                except OSError:
                    pass
    last = None
    try:
        with open(SYNC_HISTORY, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 2000))
            last = json.loads(f.read().decode(errors="ignore").strip().splitlines()[-1])
    except Exception:
        pass
    return {"waiting_files": files, "waiting_gb": round(size / 1e9, 2),
            "last_upload": {k: last.get(k) for k in ("time_pi", "kind", "files", "mb", "success")} if last else None}


def decode_throttled(raw):
    try:
        v = int(raw, 16)
    except (TypeError, ValueError):
        return "unknown"
    return ", ".join(t for b, t in THROTTLE_BITS.items() if v & (1 << b)) or "none"


def pc_snapshot():
    m = re.search(r'^PC_HOST="([^"]+)"', read(SYNC_SCRIPT) or "", re.M)
    host = m.group(1) if m else "?"
    return "\n".join([
        f"--- PC address in teslacam-sync.sh: {host}",
        "--- ping PC\n" + run(["ping", "-c", "3", "-W", "1", host], timeout=10).rstrip(),
        "--- ARP entry (is the PC on the network at all?)\n" + run(["ip", "neigh", "show", host]).rstrip(),
        "--- recent upload log\n" + run(["journalctl", "-t", "teslacam-sync", "-n", "25", "--no-pager",
                                          "-o", "short-iso"]).rstrip(),
    ])


def change_events(st, rec, t):
    """Log state changes that help explain problems later."""
    # car connection (USB drive in use = car awake)
    usb, prev = rec.get("usb_state"), st.get("usb_state")
    if usb != prev and prev is not None:
        meaning = {"configured": "car is using the drive (awake)",
                   "not attached": "car not connected / asleep / USB power only",
                   "suspended": "car put the USB port to sleep"}.get(usb, usb)
        event(f"CAR USB: {prev} -> {usb} ({meaning})")
    st["usb_state"] = usb
    # power / heat flags
    th, prev = rec.get("throttled"), st.get("throttled")
    if th != prev and th not in (None, "0x0"):
        event(f"POWER/HEAT FLAGS: {th} - {decode_throttled(th)}",
              run(["bash", "-c", "vcgencmd measure_temp; vcgencmd measure_volts core; "
                                 "vcgencmd get_throttled"]).rstrip())
    st["throttled"] = th
    # temperature
    temp = rec.get("cpu_temp_c") or 0
    if temp >= HOT_C and not st.get("hot"):
        st["hot"] = True
        event(f"HOT: CPU at {temp} C (throttling starts at 80 C)",
              run(["bash", "-c", "ps -eo pid,pcpu,comm --sort=-pcpu | head -6"]).rstrip())
    elif temp and temp < COOL_C and st.get("hot"):
        st["hot"] = False
        event(f"COOLED DOWN: CPU at {temp} C")
    # SD card space
    free = rec.get("sd_free_gb") or 99
    if free < LOW_SD_GB and not st.get("low_sd"):
        st["low_sd"] = True
        event(f"LOW SD SPACE: {free} GB free",
              run(["bash", "-c", f"df -h /; du -sh {LOCAL_RECENT} /var/log/journal /var/lib/teslacam 2>/dev/null"]).rstrip())
    elif free >= LOW_SD_GB + 1 and st.get("low_sd"):
        st["low_sd"] = False
        event(f"SD SPACE OK again: {free} GB free")
    # PC share unreachable while the Pi itself is online
    if rec["online"] and rec.get("pc_reachable") is False:
        st.setdefault("pc_down_since", t)
        if not st.get("pc_alerted") and t - st["pc_down_since"] >= PC_DOWN_ALERT_MIN * 60:
            st["pc_alerted"] = True
            event(f"PC UNREACHABLE for {PC_DOWN_ALERT_MIN}+ min while Pi is online "
                  f"(PC asleep/off, IP changed, or firewall?) - {rec['pipeline']['waiting_gb']} GB waiting",
                  pc_snapshot())
    else:
        if st.get("pc_alerted") and rec.get("pc_reachable"):
            event(f"PC REACHABLE again after {int(t - st['pc_down_since']) // 60} min")
        st.pop("pc_down_since", None)
        st["pc_alerted"] = False
    # upload errors written by teslacam-sync.sh since the last check
    since = st.get("sync_checked") or (t - 120)
    errs = run(["journalctl", "-t", "teslacam-sync", "--since", f"@{int(since)}", "--no-pager", "-o", "short-iso"])
    bad = [l for l in errs.splitlines() if "ERROR" in l or "rsync:" in l]
    if bad and not rec.get("online") and all("stopped early" in l for l in bad):
        # expected: the car drove away (or Wi-Fi dropped) in the middle of an upload - it resumes later
        event("UPLOAD PAUSED - the network went away mid-upload (car left home?); it resumes automatically",
              "\n".join(bad[-20:]))
    elif bad:
        event(f"UPLOAD PROBLEM: {len(bad)} error line(s) from teslacam-sync", "\n".join(bad[-20:]))
    st["sync_checked"] = t


def bundle():
    """One file with everything useful for troubleshooting (no Wi-Fi or share passwords)."""
    import tarfile
    import io
    stamp = datetime.now().strftime("%Y%m%d-%H%M")
    path = f"{DIAG_DIR}/bundle-{stamp}.tar.gz"
    cmds = {
        "report.txt": ["python3", "/usr/local/bin/teslacam-diag.py", "--report", "72"],
        "system.txt": ["bash", "-c", "uname -a; cat /etc/os-release; uptime; vcgencmd get_throttled; "
                                     "vcgencmd measure_temp; df -h; free -m; lsblk"],
        "services.txt": ["bash", "-c", "systemctl list-timers 'teslacam*' --no-pager; "
                                       "systemctl status 'teslacam*' --no-pager -n 5"],
        "network.txt": ["bash", "-c", "nmcli general; nmcli device status; nmcli -f NAME,TYPE,AUTOCONNECT,DEVICE "
                                      "connection show; iw dev wlan0 link; iw dev wlan0 get power_save; ip addr; "
                                      "ip route; rfkill list; cat /etc/NetworkManager/conf.d/*.conf"],
        "journal-this-boot.txt": ["journalctl", "-b", "0", "--no-pager", "-o", "short-iso", "-n", "4000"],
        "journal-previous-boot.txt": ["journalctl", "-b", "-1", "--no-pager", "-o", "short-iso", "-n", "4000"],
        "boots.txt": ["journalctl", "--list-boots", "--no-pager"],
        "footage.txt": ["bash", "-c", f"du -sh {LOCAL_RECENT}; find {LOCAL_RECENT} -type f | wc -l; "
                                      "tail -n 20 /var/lib/teslacam/metrics/sync-history.jsonl; "
                                      "ls -la /piusb; cat /sys/class/udc/*/state"],
        "boot-config.txt": ["bash", "-c", "tail -n 20 /boot/firmware/config.txt; cat /boot/firmware/cmdline.txt"],
    }
    with tarfile.open(path, "w:gz") as tar:
        def add_text(name, text):
            data = text.encode()
            info = tarfile.TarInfo(name)
            info.size, info.mtime = len(data), time.time()
            tar.addfile(info, io.BytesIO(data))
        for name, cmd in cmds.items():
            add_text(name, run(cmd, timeout=120))
        for p in sorted(glob.glob(f"{DIAG_DIR}/events-*.log"))[-2:] + sorted(glob.glob(f"{DIAG_DIR}/net-*.jsonl"))[-3:]:
            tar.add(p, arcname=os.path.basename(p))
        if os.path.exists(STATE):
            tar.add(STATE, arcname="diag-state.json")
    for old in sorted(glob.glob(f"{DIAG_DIR}/bundle-*.tar.gz"))[:-5]:
        os.remove(old)
    event(f"SUPPORT BUNDLE created: {os.path.basename(path)}")
    print(f"Created {path}\n(it is copied to the PC (TeslaCam share, PiMetrics\\diag) on the next upload)")


# ------------------------------------------------------------------ modes
def sample():
    lock = open(LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return
    os.makedirs(DIAG_DIR, exist_ok=True)
    st = load_state()
    t = time.time()
    boot_id = read("/proc/sys/kernel/random/boot_id")
    # self-healing: stale mounts, drive not handed back to the car, leftover temp files
    run(["/usr/local/bin/teslacam-heal.sh"], timeout=90)
    restored = restore_wifi_if_missing()
    w = wifi_status()
    gw = gateway() if w["connected"] else None
    gw_ms, gw_loss = ping(gw)
    online = bool(w["connected"] and w.get("ip") and gw_loss is not None and gw_loss < 100)

    home_ssids = set(st.get("home_ssids", []))
    if w["connected"] and w.get("ssid"):
        home_ssids.add(w["ssid"])
        st["home_conn"] = w.get("nm_connection") or st.get("home_conn")
    visible = None if online else visible_networks(rescan=True)
    home_visible = bool(visible and home_ssids & set(visible))

    rec = {"time": now_iso(t), "boot_id": boot_id,
           "uptime_s": round(float((read("/proc/uptime") or "0").split()[0])),
           "clock_synced": run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"]).strip() == "yes",
           "online": online, "wifi": w, "gateway": gw, "gw_ping_ms": gw_ms, "gw_loss_pct": gw_loss,
           "pc_reachable": pc_reachable() if online else False,
           "home_visible": home_visible if not online else True,
           "home_signal_pct": max((visible or {}).get(s, 0) for s in home_ssids) if visible and home_ssids else None,
           **health(), "pipeline": pipeline(), "recovery": None,
           "nm_connectivity": run(["nmcli", "networking", "connectivity"]).strip() or None}

    # ---- state changes and recovery
    same_boot = st.get("boot_id") == boot_id
    was_online = st.get("online") if same_boot else None
    if online:
        if was_online is False:
            down = int(t - st.get("offline_since", t))
            event(f"RECONNECTED after {down // 60} min {down % 60} s "
                  f"(signal {w.get('signal_dbm')} dBm, {st.get('attempts', 0)} recovery step(s) used)")
        st.update(online=True, offline_since=None, attempts=0, next_attempt=None)
    else:
        if was_online is not False:
            st.update(online=False, offline_since=t, attempts=0, next_attempt=t + RECOVER_AFTER_S)
            reason = "home network visible but not connected" if home_visible else "home network not visible (away from home?)"
            prev = st.get("last_online") or {}
            event(f"OFFLINE - {reason}",
                  f"Last good reading: {json.dumps(prev)}\n\n{snapshot()}")
        elif home_visible and t >= (st.get("next_attempt") or 0):
            step = st.get("attempts", 0)
            name, output = recover(step, st.get("home_conn"))
            rec["recovery"] = name
            st["attempts"] = step + 1
            st["next_attempt"] = t + (RECOVER_BACKOFF_S if st["attempts"] % 4 == 0 else RECOVER_EVERY_S)
            event(f"RECOVERY step {step + 1}: {name} (offline {int(t - st['offline_since']) // 60} min)", output)
    if online and w["connected"]:
        backup_wifi()
    rec["wifi_profiles"] = len(wifi_connections())
    if restored:
        rec["recovery"] = "restored Wi-Fi settings"
    if online:
        st["last_online"] = {"time": rec["time"], "ssid": w.get("ssid"), "bssid": w.get("bssid"),
                             "signal_dbm": w.get("signal_dbm"), "freq_mhz": w.get("freq_mhz")}
    change_events(st, rec, t)
    st["boot_id"] = boot_id
    st["home_ssids"] = sorted(home_ssids)
    save_state(st)

    with open(f"{DIAG_DIR}/net-{datetime.now().strftime('%Y-%m-%d')}.jsonl", "a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")
    cleanup()


def cleanup():
    cutoff = time.time() - KEEP_DAYS * 86400
    for p in glob.glob(f"{DIAG_DIR}/*"):
        try:
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass


def boot():
    os.makedirs(DIAG_DIR, exist_ok=True)
    restore_wifi_if_missing()
    clean = os.path.exists(CLEAN_MARK)
    if clean:
        os.remove(CLEAN_MARK)
    last = ""
    files = sorted(glob.glob(f"{DIAG_DIR}/net-*.jsonl"))
    if files:
        with open(files[-1]) as f:
            lines = f.readlines()
        last = lines[-1].strip() if lines else ""
    prev_log = run(["journalctl", "-b", "-1", "-n", "25", "--no-pager", "-o", "short-iso"])
    event(f"POWER-UP - previous shutdown was {'clean' if clean else 'a power cut (car slept / cable pulled)'}",
          f"Last reading before this power-up: {last or 'none'}\n\n"
          f"--- Last 25 log lines of the previous power-up\n{prev_log.rstrip()}\n\n"
          f"--- Power now\n{run(['vcgencmd', 'get_throttled']).strip()}")


def shutdown():
    with open(CLEAN_MARK, "w") as f:
        f.write(now_iso())


def report(hours):
    since = datetime.now().astimezone() - timedelta(hours=hours)
    recs = []
    for p in sorted(glob.glob(f"{DIAG_DIR}/net-*.jsonl"))[-((hours // 24) + 2):]:
        with open(p) as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if datetime.fromisoformat(r["time"]) >= since:
                    recs.append(r)
    print(f"TeslaCam Pi diagnostics - last {hours} h ({len(recs)} readings)\n")
    if recs:
        online = sum(1 for r in recs if r["online"])
        sig = [r["wifi"].get("signal_dbm") for r in recs if r["online"] and r["wifi"].get("signal_dbm") is not None]
        temps = [r["cpu_temp_c"] for r in recs if r.get("cpu_temp_c") is not None]
        boots = len({r["boot_id"] for r in recs})
        uv = any(r.get("throttled") not in (None, "0x0") for r in recs)
        print(f"  Online:            {online}/{len(recs)} minutes ({100 * online // len(recs)}%)")
        if sig:
            print(f"  Wi-Fi signal:      avg {sum(sig) / len(sig):.0f} dBm, worst {min(sig):.0f} dBm")
        print(f"  Power-ups:         {boots}")
        if temps:
            print(f"  Temperature:       max {max(temps)} C")
        print(f"  Power/heat flags:  {'SEEN - check events' if uv else 'none'}")
        print(f"  Recovery actions:  {sum(1 for r in recs if r.get('recovery'))}")
        pl = recs[-1].get("pipeline") or {}
        print(f"  Waiting on Pi:     {pl.get('waiting_gb', '?')} GB ({pl.get('waiting_files', '?')} files)")
        lu = pl.get("last_upload") or {}
        if lu:
            print(f"  Last upload:       {str(lu.get('time_pi'))[:16].replace('T', ' ')} - {lu.get('kind')} "
                  f"{lu.get('files')} files, {lu.get('mb')} MB, {'ok' if lu.get('success') else 'INCOMPLETE'}")
        # offline stretches
        print("\n  Offline periods:")
        run_start = None
        for r in recs + [{"online": True, "time": None}]:
            if not r["online"] and run_start is None:
                run_start = r
            elif r["online"] and run_start is not None:
                print(f"    from {run_start['time'][:16].replace('T', ' ')}  "
                      f"home network {'VISIBLE' if run_start.get('home_visible') else 'not visible'}")
                run_start = None
    print("\n  Recent events:")
    logs = sorted(glob.glob(f"{DIAG_DIR}/events-*.log"))[-2:]
    heads = []
    for p in logs:
        with open(p) as f:
            heads += [l.strip()[6:] for l in f if l.startswith("===== ")]
    for h in heads[-15:]:
        print(f"    {h}")
    print(f"\n  Full details: {DIAG_DIR}/events-*.log")


if __name__ == "__main__":
    if "--boot" in sys.argv:
        boot()
    elif "--shutdown" in sys.argv:
        shutdown()
    elif "--bundle" in sys.argv:
        bundle()
    elif "--backup-wifi" in sys.argv:
        backup_wifi()
    elif "--report" in sys.argv:
        i = sys.argv.index("--report")
        report(int(sys.argv[i + 1]) if len(sys.argv) > i + 1 else 24)
    else:
        sample()
