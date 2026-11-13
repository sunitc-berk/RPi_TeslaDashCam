#!/usr/bin/env python3
"""teslacam-archive.py - save the car's RecentClips to the Pi's SD card before the car overwrites them.

The car keeps only about the last hour of RecentClips, overwriting the oldest minutes. This runs
every 5 minutes (teslacam-archive.timer), mounts the dashcam drive READ-ONLY (the car keeps recording
undisturbed) and copies every finished one-minute segment to /var/lib/teslacam/recent-archive.
teslacam-sync.sh uploads that folder to the PC when the car is home.

At home, footage of the car sitting parked is not kept (SKIP_PARKED_AT_HOME): the car's own
driving data inside each clip (teslacam_sei.py) tells parked minutes from the last minutes of a
drive, so pulling in is kept and the garage is not. Saved / Sentry clips are not affected.

Clock-independent: "finished" is judged from the car's own timestamps in the file names
(every segment older than the newest one is complete), not from the Pi's clock.
"""
import fcntl
import json
import os
import re
import shutil
import subprocess
import time
from datetime import datetime, timedelta

try:
    import teslacam_sei             # installed next to this script
except Exception:                   # a missing helper must never stop footage being saved:
    teslacam_sei = None             # without it everything is kept, as before

# ---------------- settings ----------------
ARCHIVE_MAX_GB = 40      # max space on the Pi's SD card used for saved recent footage
MIN_FREE_GB = 5          # always leave at least this much free on the SD card
SKIP_PARKED_AT_HOME = True   # at home, don't keep footage of the car sitting parked (uses the car's
                             # driving data; the end of a drive home is still kept)
HOME_STASH_GB = 6        # at home, keep at most this much NOT-yet-uploaded garage footage
                         # (only used for footage that can't be checked, e.g. encrypted clips)
                         # (the car keeps its own last hour anyway; don't let a parked car
                         #  fill the SD card and push out trip footage)
# ------------------------------------------
# When space runs out, footage recorded AT HOME is deleted first; footage recorded away
# from home (your trips) only as a last resort. Every deletion of footage that was never
# uploaded is logged as "FOOTAGE LOST" in the diagnostics events log.

DRIVE_LOCK = "/run/teslacam-drive.lock"         # shared by everything that reads/writes the car drive
CAM_IMG = "/piusb/cam.bin"
MNT = "/mnt/camarchive"
ARCHIVE = "/var/lib/teslacam/recent-archive"
LEDGER = "/var/lib/teslacam/archived-recent.txt"  # segments already saved (so uploads aren't re-copied)
ARCHIVE_META = "/var/lib/teslacam/archive-meta.jsonl"  # when/which boot each segment was saved (for the manifest)
META_LOCK = "/run/teslacam-meta.lock"
SOURCES = [("TeslaCam/RecentClips", "RecentClips"),
           ("TeslaCam/EncryptedClips/RecentClips", "EncryptedClips/RecentClips")]
TS = re.compile(r"(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})")
DIAG_STATE = "/var/lib/teslacam/diag-state.json"      # written by teslacam-diag.py
DIAG_DIR = "/var/lib/teslacam/metrics/diag"
HOME_SKIP_FLAG = "/var/lib/teslacam/home-skip-active"
SYNC_LOCK = "/run/teslacam-sync.lock"               # held by teslacam-sync.sh while it uploads


def log(msg):
    print(msg)
    subprocess.run(["logger", "-t", "teslacam-archive", msg])


def diag_event(title, details=""):
    """Add an entry to the diagnostics events log (shown in the dashboard)."""
    try:
        os.makedirs(DIAG_DIR, exist_ok=True)
        with open(f"{DIAG_DIR}/events-{datetime.now().strftime('%Y-%m')}.log", "a") as f:
            f.write(f"\n===== {datetime.now().astimezone().isoformat(timespec='seconds')}  {title}\n")
            if details:
                f.write(details.rstrip() + "\n")
    except OSError:
        pass


def where_am_i():
    """'home' if the Pi is on (or can see) the home network or a network cable, 'away' otherwise."""
    try:
        with open(DIAG_STATE) as f:
            st = json.load(f)
    except Exception:
        st = {}
    home_ssids = set(st.get("home_ssids", []))
    link = subprocess.run(["iw", "dev", "wlan0", "link"], capture_output=True, text=True).stdout
    m = re.search(r"SSID: (.+)", link)
    if m and m.group(1).strip() in home_ssids:
        return "home"
    if "default via" in subprocess.run(["ip", "route", "show", "dev", "eth0"],
                                       capture_output=True, text=True).stdout:
        return "home"                           # network cable plugged in
    # last diagnostics reading (taken every minute) says whether home Wi-Fi is visible
    try:
        files = sorted(f for f in os.listdir(DIAG_DIR) if f.startswith("net-"))
        with open(os.path.join(DIAG_DIR, files[-1])) as f:
            last = json.loads(f.readlines()[-1])
        age = time.time() - datetime.fromisoformat(last["time"]).timestamp()
        if age < 300 and last.get("home_visible"):
            return "home"
    except Exception:
        pass
    return "away"


def load_where():
    """rel path -> 'home'/'away' for footage waiting on the SD card."""
    out = {}
    try:
        with open(ARCHIVE_META) as f:
            for line in f:
                try:
                    m = json.loads(line)
                    out[m["rel"]] = m.get("where", "away")
                except (ValueError, KeyError):
                    pass
    except FileNotFoundError:
        pass
    return out


def ts_of(name):
    m = TS.search(name)
    return datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S") if m else None


def load_ledger():
    try:
        with open(LEDGER) as f:
            return set(line.strip() for line in f if line.strip())
    except FileNotFoundError:
        return set()


def save_ledger(entries, on_drive):
    """Remember a segment for as long as the car still has it on the drive.
    (The car can keep footage for many hours while parked, so a fixed time window is not safe.)"""
    keep = [e for e in entries if e in on_drive]
    tmp = LEDGER + ".tmp"
    with open(tmp, "w") as f:
        f.write("\n".join(sorted(keep)) + "\n")
        f.flush()
        os.fsync(f.fileno())                      # survive a power cut right after this
    os.replace(tmp, LEDGER)


def write_meta(rels, where="away"):
    if not rels:
        return
    try:
        with open("/proc/sys/kernel/random/boot_id") as f:
            boot_id = f.read().strip()
    except OSError:
        boot_id = None
    synced = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                            capture_output=True, text=True).stdout.strip() == "yes"
    now = datetime.now().astimezone().isoformat(timespec="seconds")
    lock = open(META_LOCK, "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    with open(ARCHIVE_META, "a") as f:
        for rel in rels:
            f.write(json.dumps({"rel": rel, "saved_at": now, "boot_id": boot_id,
                                "clock_synced": synced, "where": where}, separators=(",", ":")) + "\n")
        f.flush()
        os.fsync(f.fileno())
    lock.close()


def front_of(path):
    """The front-camera clip recorded in the same minute (the car's driving data is read from it)."""
    d, n = os.path.split(path)
    m = TS.search(n)
    if not m:
        return None
    f = os.path.join(d, f"{m.group(1)}-front.mp4")
    return f if os.path.exists(f) else None


class DriveCheck:
    """Was the car driving in this minute? Cached per minute; unknown (no front clip,
    encrypted) counts as driving, so nothing is ever dropped on a guess."""
    def __init__(self):
        self.cache = {}

    def __call__(self, path):
        if teslacam_sei is None or "EncryptedClips" in path:
            return True
        front = front_of(path)
        if not front:
            return True
        if front not in self.cache:
            self.cache[front] = teslacam_sei.driving(front) is True
        return self.cache[front]


def purge_parked_home():
    """Delete parked-at-home footage that is still waiting on the SD card (saved before this
    check existed). Skipped while an upload is running, so nothing disappears under it."""
    lock = open(SYNC_LOCK, "a")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        lock.close()
        return 0, 0
    try:
        where_map, check, n, b = load_where(), DriveCheck(), 0, 0
        for _, p, size in local_files():
            rel = os.path.relpath(p, ARCHIVE)
            if where_map.get(rel) == "home" and "EncryptedClips" not in rel and front_of(p) and not check(p):
                try:
                    os.remove(p)
                    n += 1
                    b += size
                except OSError:
                    pass
        for root, dirs, _ in os.walk(ARCHIVE, topdown=False):
            for d in dirs:
                try:
                    os.rmdir(os.path.join(root, d))
                except OSError:
                    pass
        return n, b
    finally:
        lock.close()


def local_files():
    out = []
    for root, _, names in os.walk(ARCHIVE):
        for n in names:
            if not n.endswith(".part"):
                p = os.path.join(root, n)
                try:
                    out.append((ts_of(n) or datetime.min, p, os.path.getsize(p)))
                except OSError:
                    pass
    return sorted(out)


class Space:
    """Keeps the local archive under ARCHIVE_MAX_GB and the SD card above MIN_FREE_GB.
    Deletes footage recorded at home first (oldest first), trip footage only as a last resort."""
    def __init__(self, where_map):
        files = local_files()
        tag = lambda p: where_map.get(os.path.relpath(p, ARCHIVE), "away")
        self.home = [f for f in files if tag(f[1]) == "home"]
        self.away = [f for f in files if tag(f[1]) != "home"]
        self.used = sum(s for _, _, s in files)
        self.home_used = sum(s for _, _, s in self.home)
        self.lost = {"home": [], "away": []}         # (time, size) of never-uploaded footage deleted

    def full(self, size):
        return (self.used + size > ARCHIVE_MAX_GB * 1e9
                or shutil.disk_usage("/").free - size < MIN_FREE_GB * 1e9)

    def make_room(self, size, where):
        """Free space for one new segment. At home nothing is ever deleted for garage footage
        (returns False instead). Away: delete home footage first, then the oldest trip footage."""
        while self.full(size):
            if where == "home":
                return False
            pool, kind = (self.home, "home") if self.home else (self.away, "away")
            if not pool:
                return False
            t, p, s = pool.pop(0)
            try:
                os.remove(p)
            except OSError:
                pass
            self.used -= s
            if kind == "home":
                self.home_used -= s
            self.lost[kind].append((t, s))
        return True

    def added(self, t, path, size, where):
        self.used += size
        if where == "home":
            self.home_used += size
            self.home.append((t, path, size))
        else:
            self.away.append((t, path, size))

    def report_losses(self):
        for kind, items in self.lost.items():
            if not items:
                continue
            mb = sum(s for _, s in items) // 1_000_000
            first, last = min(t for t, _ in items), max(t for t, _ in items)
            title = (f"FOOTAGE LOST: deleted {len(items)} never-uploaded {'garage/home' if kind == 'home' else 'TRIP'} "
                     f"segments ({mb} MB) to make room on the SD card")
            details = (f"Recorded {first:%Y-%m-%d %H:%M} to {last:%Y-%m-%d %H:%M} (car time).\n"
                       f"SD card limit {ARCHIVE_MAX_GB} GB / keep {MIN_FREE_GB} GB free; "
                       f"now {self.used / 1e9:.1f} GB waiting, {shutil.disk_usage('/').free / 1e9:.1f} GB free.\n"
                       "Usually means the Pi could not upload for a long time (no Wi-Fi at home, PC off).")
            log(title)
            diag_event(title, details)


def main():
    lock = open(DRIVE_LOCK, "w")
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("The drive is busy (a background save or sync is running) - nothing to do now.")
        return                                    # a sync or peek is using the drive; try next run
    os.makedirs(MNT, exist_ok=True)
    os.makedirs(ARCHIVE, exist_ok=True)
    # leftovers from a run that was killed or lost power: our own mount, half-copied files
    if subprocess.run(["mountpoint", "-q", MNT]).returncode == 0:
        if subprocess.run(["umount", MNT], capture_output=True).returncode != 0:
            subprocess.run(["umount", "-l", MNT], capture_output=True)
    for root, _, names in os.walk(ARCHIVE):
        for n in names:
            if n.endswith(".part"):
                try:
                    os.remove(os.path.join(root, n))
                except OSError:
                    pass
    try:
        if subprocess.run(["mount", "-o", "ro,loop", CAM_IMG, MNT], capture_output=True,
                          timeout=60).returncode != 0:
            return
    except subprocess.TimeoutExpired:
        log("Car drive could not be opened in 60 s - trying again next run")
        return
    try:
        segs = []                                 # (archive-relative path, source path, car time)
        for src_rel, dst_rel in SOURCES:
            base = os.path.join(MNT, src_rel)
            for root, _, names in os.walk(base):
                for n in names:
                    t = ts_of(n)
                    if t and n.endswith(".mp4"):
                        src = os.path.join(root, n)
                        segs.append((os.path.join(dst_rel, os.path.relpath(src, base)), src, t))
        if not segs:
            return
        newest = max(t for _, _, t in segs)
        # The newest segment is still being written - unless the car has stopped recording
        # (drive untouched for 2+ minutes), in which case it is finished too.
        car_idle = time.time() - os.stat(CAM_IMG).st_mtime > 120
        ledger = load_ledger()
        todo = sorted((s for s in segs if (s[2] < newest or car_idle) and s[0] not in ledger),
                      key=lambda s: s[2])

        where = where_am_i()
        space = Space(load_where())
        copied = nbytes = skipped = home_skipped = parked = 0
        saved_rels, drove_rels = [], []
        check = DriveCheck()
        for rel, src, _ in todo:
            try:
                size = os.stat(src).st_size
            except OSError:
                continue                          # car deleted it meanwhile
            seg_where = where
            if (where == "home" and SKIP_PARKED_AT_HOME and teslacam_sei is not None
                    and "EncryptedClips" not in rel and front_of(src)):
                if not check(src):
                    parked += 1                   # parked at home - not wanted, never uploaded
                    ledger.add(rel)
                    continue
                seg_where = "away"                # the end of a drive: keep it as trip footage
            if seg_where == "home" and (space.home_used + size > HOME_STASH_GB * 1e9 or space.full(size)):
                home_skipped += 1                 # parked at home and not uploading - don't hoard,
                ledger.add(rel)                   # and never push out older footage for it
                continue                          # (remembered as handled, so it isn't saved later)
            if not space.make_room(size, seg_where):
                log("SD card full - cannot save more recent footage")
                break
            dst = os.path.join(ARCHIVE, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            tmp = dst + ".part"
            try:
                shutil.copyfile(src, tmp)
                with open(tmp, "rb+") as fh:
                    os.fsync(fh.fileno())         # on the card before we call it saved
                st = os.stat(src)
                ok = st.st_size == size == os.path.getsize(tmp)   # unchanged while we copied
            except OSError:
                ok = False
            if ok:
                # file time = recording time from the name (the drive's own times have no time zone)
                t = time.mktime(ts_of(os.path.basename(dst)).timetuple())
                os.utime(tmp, (t, t))
                os.replace(tmp, dst)
                ledger.add(rel)
                (drove_rels if seg_where != where else saved_rels).append(rel)
                space.added(ts_of(os.path.basename(dst)) or datetime.min, dst, size, seg_where)
                copied += 1
                nbytes += size
            else:
                skipped += 1
                if os.path.exists(tmp):
                    os.remove(tmp)
        save_ledger(ledger, {s[0] for s in segs})
        write_meta(saved_rels, where)
        write_meta(drove_rels, "away")
        space.report_losses()
        # note once when we start/stop skipping garage footage
        if home_skipped and not os.path.exists(HOME_SKIP_FLAG):
            open(HOME_SKIP_FLAG, "w").close()
            msg = (f"At home with {space.home_used / 1e9:.1f} GB of garage footage not yet uploaded - "
                   f"not saving more (limit {HOME_STASH_GB} GB). The car still keeps its own last hour.")
            log(msg)
            diag_event("HOME FOOTAGE PAUSED - upload is not keeping up", msg)
        elif not home_skipped and os.path.exists(HOME_SKIP_FLAG):
            os.remove(HOME_SKIP_FLAG)
            diag_event("HOME FOOTAGE RESUMED - uploads caught up or car left home")
        if copied or skipped or parked:
            log(f"Saved {copied} recent segments ({nbytes // 1_000_000} MB, {where}) to the SD card"
                + (f", skipped {skipped} that changed while copying" if skipped else "")
                + (f", {parked} parked-at-home files not kept" if parked else "")
                + (f", {home_skipped} garage segments not kept (home limit)" if home_skipped else ""))
    finally:
        try:
            if subprocess.run(["umount", MNT], capture_output=True, timeout=30).returncode != 0:
                subprocess.run(["umount", "-l", MNT], capture_output=True)
        except subprocess.TimeoutExpired:
            subprocess.run(["umount", "-l", MNT], capture_output=True)
        lock.close()
    if SKIP_PARKED_AT_HOME and teslacam_sei is not None:
        try:
            n, b = purge_parked_home()
            if n:
                log(f"Removed {n} parked-at-home files ({b // 1_000_000} MB) that were waiting to upload")
        except Exception as e:                    # tidying up must never fail the save
            log(f"Could not tidy parked-at-home footage: {e!r}")
    if teslacam_sei is None:
        log("teslacam_sei.py is missing - keeping all footage (run install.sh again to install it)")


if __name__ == "__main__":
    main()
