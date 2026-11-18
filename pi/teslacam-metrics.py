#!/usr/bin/env python3
"""teslacam-metrics.py - record Raspberry Pi health metrics as JSON Lines.

  teslacam-metrics.py           take one sample and append it to
                                /var/lib/teslacam/metrics/YYYY-MM-DD.jsonl  (run every 5 min by a timer)
  teslacam-metrics.py --fixup   fill in time_corrected for earlier samples (run by teslacam-sync.sh
                                before it copies the metrics to the PC)

Time correction
---------------
The Pi has no clock battery. If it boots away from home Wi-Fi its clock can be wrong.
The car's clock is accurate (GPS/cellular), and the car stamps every file it writes with it.
While the car is actively recording, we read (read-only) the newest file's timestamp on the
dashcam drive and compare it with the moment the Pi saw that write. The difference is the
Pi's clock error for this boot, which is then applied to every sample from the same boot.
"""
import fcntl
import glob
import json
import os
import re
import shutil
import socket
import statistics
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

def wifi_iface():
    """The Wi-Fi interface carrying the default route (the USB stick when it is up, else the built-in radio)."""
    try:
        out = subprocess.run(["ip", "-4", "route", "show", "default"], capture_output=True, text=True, timeout=5).stdout
        for line in out.splitlines():
            m = re.search(r"\bdev (wl\S+)", line)
            if m:
                return m.group(1)
    except Exception:
        pass
    return "wlan0"


CAR_TZ = ZoneInfo("America/Los_Angeles")       # the car writes local time
STATE_DIR = "/var/lib/teslacam"
METRICS_DIR = f"{STATE_DIR}/metrics"
BOOT_STATE = f"{STATE_DIR}/boot-state.json"
LAST_PI_WRITE = f"{STATE_DIR}/last-pi-write"   # touched by the sync script after it modifies the drive
CAM_IMG = "/piusb/cam.bin"
PEEK_MNT = "/mnt/campeek"
LOCK_FILE = "/run/teslacam-drive.lock"          # shared by everything that touches the car drive
LOCAL_RECENT = f"{STATE_DIR}/recent-archive"    # RecentClips saved on the SD card, waiting for upload
SYNC_SCRIPT = "/usr/local/bin/teslacam-sync.sh"
CLIP_FOLDERS = ["RecentClips", "SavedClips", "SentryClips"]
ACTIVE_WRITE_SECONDS = 90                       # only measure clock offset while the car is recording
FIXUP_DAYS = 30


# ---------------------------------------------------------------- helpers
def run(cmd, timeout=10):
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return r.stdout.strip() if r.returncode == 0 else None
    except Exception:
        return None


def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except Exception:
        return None


def iso(epoch):
    return datetime.fromtimestamp(epoch).astimezone().isoformat(timespec="seconds")


# ---------------------------------------------------------------- individual metrics
def cpu_temp_c():
    v = read("/sys/class/thermal/thermal_zone0/temp")
    return round(int(v) / 1000, 1) if v else None


def throttling():
    out = run(["vcgencmd", "get_throttled"])           # e.g. throttled=0x50005
    if not out or "=" not in out:
        return None
    bits = int(out.split("=")[1], 16)
    b = lambda n: bool(bits & (1 << n))
    return {
        "raw": hex(bits),
        "under_voltage_now": b(0), "freq_capped_now": b(1),
        "throttled_now": b(2), "soft_temp_limit_now": b(3),
        "under_voltage_since_boot": b(16), "freq_capped_since_boot": b(17),
        "throttled_since_boot": b(18), "soft_temp_limit_since_boot": b(19),
    }


def cpu_mhz():
    out = run(["vcgencmd", "measure_clock", "arm"])    # frequency(48)=1500398464
    return round(int(out.split("=")[1]) / 1e6) if out and "=" in out else None


def core_volts():
    out = run(["vcgencmd", "measure_volts", "core"])   # volt=0.8500V
    m = re.search(r"([\d.]+)V", out or "")
    return float(m.group(1)) if m else None


def cpu_usage_pct(interval=1.0):
    def snap():
        vals = list(map(int, read("/proc/stat").splitlines()[0].split()[1:]))
        idle = vals[3] + vals[4]                        # idle + iowait
        return idle, sum(vals)
    try:
        i1, t1 = snap(); time.sleep(interval); i2, t2 = snap()
        return round(100 * (1 - (i2 - i1) / (t2 - t1)), 1)
    except Exception:
        return None


def memory():
    info = {}
    for line in (read("/proc/meminfo") or "").splitlines():
        k, v = line.split(":", 1)
        info[k] = int(v.split()[0]) // 1024             # MB
    if "MemTotal" not in info:
        return None
    return {"total_mb": info["MemTotal"], "available_mb": info.get("MemAvailable"),
            "used_pct": round(100 * (1 - info.get("MemAvailable", 0) / info["MemTotal"]), 1)}


def disk(path):
    try:
        u = shutil.disk_usage(path)
        return {"total_gb": round(u.total / 1e9, 2), "free_gb": round(u.free / 1e9, 2),
                "used_pct": round(100 * u.used / u.total, 1)}
    except Exception:
        return None


def sd_card_errors_this_boot():
    out = run(["journalctl", "-k", "-b", "--no-pager", "-o", "cat"], timeout=20)
    if out is None:
        return None
    pat = re.compile(r"(mmc\d.*(error|timeout))|(I/O error.*mmcblk)|(EXT4-fs error)", re.I)
    return sum(1 for line in out.splitlines() if pat.search(line))


def wifi():
    out = run(["iw", "dev", wifi_iface(), "link"])
    w = {"connected": False}
    if out and out.startswith("Connected"):
        w["connected"] = True
        for key, pat in [("ssid", r"SSID: (.+)"), ("signal_dbm", r"signal: (-?\d+)"),
                         ("tx_mbps", r"tx bitrate: ([\d.]+)"), ("freq_mhz", r"freq: ([\d.]+)")]:
            m = re.search(pat, out)
            if m:
                w[key] = m.group(1) if key == "ssid" else float(m.group(1))
    ips = run(["hostname", "-I"])
    w["ip"] = ips.split()[0] if ips else None
    return w


def pc_reachable():
    m = re.search(r'^PC_HOST="([^"]+)"', read(SYNC_SCRIPT) or "", re.M)
    if not m:
        return None
    try:
        with socket.create_connection((m.group(1), 445), timeout=2):
            return True
    except Exception:
        return False


def local_recent_archive():
    files = size = 0
    for root, _, names in os.walk(LOCAL_RECENT):
        for n in names:
            if not n.endswith(".part"):
                try:
                    size += os.path.getsize(os.path.join(root, n))
                    files += 1
                except OSError:
                    pass
    return {"files": files, "gb": round(size / 1e9, 2)}


def usb_state():
    states = glob.glob("/sys/class/udc/*/state")
    return read(states[0]) if states else None


def boot_info():
    boot_id = read("/proc/sys/kernel/random/boot_id")
    try:
        with open(BOOT_STATE) as f:
            st = json.load(f)
    except Exception:
        st = {"boot_id": None, "boot_count": 0}
    if st.get("boot_id") != boot_id:
        st = {"boot_id": boot_id, "boot_count": st.get("boot_count", 0) + 1}
        with open(BOOT_STATE, "w") as f:
            json.dump(st, f)
    return boot_id, st["boot_count"]


def clock_synced():
    return run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"]) == "yes"


# ---------------------------------------------------------------- dashcam drive peek (read-only)
def peek_drive(cam_mtime, seconds_since_car_write, write_uptime):
    """Mount the car drive read-only, report usage and pending clips, and measure the Pi's
    clock offset against the car's clock. Skipped while a sync holds the lock."""
    result = {"cam_drive": None, "clips_pending": None, "clock_offset_s": None}
    lock = open(LOCK_FILE, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return result                                   # sync is running - don't touch the drive
    try:
        os.makedirs(PEEK_MNT, exist_ok=True)
        # tz=UTC: give us the car's raw local timestamps without conversion
        if subprocess.run(["mountpoint", "-q", PEEK_MNT]).returncode == 0:   # leftover from a killed run
            subprocess.run(["umount", "-l", PEEK_MNT], capture_output=True)
        try:
            if subprocess.run(["mount", "-o", "ro,loop,tz=UTC", CAM_IMG, PEEK_MNT],
                              capture_output=True, timeout=60).returncode != 0:
                return result
        except subprocess.TimeoutExpired:
            return result
        try:
            result["cam_drive"] = disk(PEEK_MNT)
            newest, pending = 0.0, 0
            for base in (f"{PEEK_MNT}/TeslaCam", f"{PEEK_MNT}/TeslaCam/EncryptedClips"):
                for folder in CLIP_FOLDERS:
                    for root, _, files in os.walk(f"{base}/{folder}"):
                        for name in files:
                            try:
                                mt = os.stat(os.path.join(root, name)).st_mtime
                            except OSError:
                                continue
                            newest = max(newest, mt)
                            if folder != "RecentClips":
                                pending += 1
            result["clips_pending"] = pending

            # Clock offset: only while the car is actively recording, only for writes made
            # during this boot, and not if the last change to the drive was our own sync.
            last_pi = os.stat(LAST_PI_WRITE).st_mtime if os.path.exists(LAST_PI_WRITE) else 0
            if (newest and write_uptime is not None
                    and seconds_since_car_write is not None
                    and seconds_since_car_write < ACTIVE_WRITE_SECONDS
                    and cam_mtime > last_pi + 2):
                car_naive = datetime.fromtimestamp(newest, timezone.utc).replace(tzinfo=None)
                car_epoch = car_naive.replace(tzinfo=CAR_TZ).timestamp()
                result["clock_offset_s"] = round(car_epoch - cam_mtime)
        finally:
            try:
                if subprocess.run(["umount", PEEK_MNT], capture_output=True, timeout=30).returncode != 0:
                    subprocess.run(["umount", "-l", PEEK_MNT], capture_output=True)
            except subprocess.TimeoutExpired:
                subprocess.run(["umount", "-l", PEEK_MNT], capture_output=True)
    finally:
        lock.close()
    return result


# ---------------------------------------------------------------- one sample
def sample():
    os.makedirs(METRICS_DIR, exist_ok=True)
    now = time.time()
    uptime = float((read("/proc/uptime") or "0").split()[0])
    boot_id, boot_count = boot_info()
    synced = clock_synced()

    cam_mtime = seconds_since_write = write_uptime = None
    if os.path.exists(CAM_IMG):
        cam_mtime = os.stat(CAM_IMG).st_mtime
        seconds_since_write = round(now - cam_mtime)
        wu = uptime - (now - cam_mtime)
        write_uptime = round(wu) if wu >= 0 else None   # None = last write was before this boot

    peek = peek_drive(cam_mtime, seconds_since_write, write_uptime) if cam_mtime else {}
    offset = peek.get("clock_offset_s")

    if synced:
        corrected, source = iso(now), "ntp"
    elif offset is not None:
        corrected, source = iso(now + offset), "car"
    else:
        corrected, source = None, "pending"

    rec = {
        "time_pi": iso(now),
        "time_corrected": corrected,
        "time_source": source,                 # ntp = internet time, car = corrected from car clock
        "clock_synced": synced,
        "boot_id": boot_id,
        "boot_count": boot_count,
        "uptime_s": round(uptime),
        "cpu_temp_c": cpu_temp_c(),
        "throttling": throttling(),
        "cpu_mhz": cpu_mhz(),
        "core_volts": core_volts(),
        "cpu_usage_pct": cpu_usage_pct(),
        "load_avg": [round(x, 2) for x in os.getloadavg()],
        "memory": memory(),
        "sd_card": disk("/"),
        "sd_card_errors_this_boot": sd_card_errors_this_boot(),
        "wifi": wifi(),
        "pc_reachable": pc_reachable(),
        "usb_state": usb_state(),              # configured = car awake and using the drive
        "seconds_since_car_write": seconds_since_write,
        "car_write_uptime_s": write_uptime,
        "cam_drive": peek.get("cam_drive"),
        "clips_pending": peek.get("clips_pending"),
        "recent_saved_on_pi": local_recent_archive(),   # recent footage waiting to upload
        "clock_offset_s": offset,
    }
    path = f"{METRICS_DIR}/{datetime.now().strftime('%Y-%m-%d')}.jsonl"
    with open(path, "a") as f:
        f.write(json.dumps(rec, separators=(",", ":")) + "\n")


# ---------------------------------------------------------------- fixup
def fixup():
    """Fill time_corrected for samples taken before the clock offset was known."""
    cutoff = time.time() - FIXUP_DAYS * 86400
    # only the daily sample files (YYYY-MM-DD.jsonl) - not manifest-*.jsonl or sync-history.jsonl
    files = [p for p in glob.glob(f"{METRICS_DIR}/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9].jsonl")
             if os.path.getmtime(p) >= cutoff]
    data = {}
    offsets = {}                                  # boot_id -> offsets measured while clock unsynced
    for p in files:
        recs = []
        with open(p) as f:
            for line in f:
                try:
                    recs.append(json.loads(line))
                except ValueError:
                    pass
        data[p] = recs
        for r in recs:
            if not r.get("clock_synced") and r.get("clock_offset_s") is not None:
                offsets.setdefault(r.get("boot_id"), []).append(r["clock_offset_s"])
    medians = {b: statistics.median(v) for b, v in offsets.items()}

    for p, recs in data.items():
        for r in recs:
            if "time_pi" not in r:
                continue                          # not a metrics sample - leave it alone
            if r.get("clock_synced"):
                r["time_corrected"], r["time_source"] = r["time_pi"], "ntp"
            elif r.get("boot_id") in medians:
                t = datetime.fromisoformat(r["time_pi"]) + timedelta(seconds=medians[r["boot_id"]])
                r["time_corrected"] = t.isoformat(timespec="seconds")
                r["time_source"] = "car"
            else:
                r["time_corrected"], r["time_source"] = None, "uncorrected"
        new = "".join(json.dumps(r, separators=(",", ":")) + "\n" for r in recs)
        with open(p) as f:
            old = f.read()
        if new != old:                            # rewrite only when something changed
            tmp = p + ".tmp"
            with open(tmp, "w") as f:
                f.write(new)
            os.replace(tmp, p)


if __name__ == "__main__":
    if "--fixup" in sys.argv:
        fixup()
    else:
        sample()
