#!/usr/bin/env python3
r"""teslacam-manifest.py - write one manifest line per file copied to the PC.

Called by teslacam-sync.sh after each rsync:

  teslacam-manifest.py --kind auto|recent|saved|sentry --list LISTFILE --src SRC [--dest DEST] [--pc-prefix PREFIX]
  Without --dest, every file in LISTFILE is taken as confirmed on the PC (teslacam-upload.py's
  --verified output) and "auto" works out the kind from the folder (RecentClips/SavedClips/SentryClips).

  LISTFILE   lines of "<relative path>\t<size>" captured BEFORE the copy (find -printf '%P\t%s\n')
  SRC/DEST   source folder and destination folder (on the mounted PC share)
  PREFIX     path of DEST relative to the share root, e.g. "SavedClips" ("" for recent uploads)

A file counts as copied if it is now at DEST with the same size.
Output: /var/lib/teslacam/metrics/manifest-YYYY-MM.jsonl  (copied to \\PC\TeslaCam\PiMetrics)
"""
import argparse
import fcntl
import json
import os
import re
import subprocess
import time
from datetime import datetime

STATE_DIR = "/var/lib/teslacam"
METRICS_DIR = f"{STATE_DIR}/metrics"
ARCHIVE_META = f"{STATE_DIR}/archive-meta.jsonl"   # written by teslacam-archive.py
META_LOCK = "/run/teslacam-meta.lock"

TS = re.compile(r"(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})")
CAM = re.compile(r"-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$")


def car_time(name):
    m = TS.search(name)
    return f"{m.group(1)}T{m.group(2)}:{m.group(3)}:{m.group(4)}" if m else None


def name_epoch(name, event_folder=None):
    """Recording time from a Tesla file name (or its event folder), in this Pi's local time zone."""
    m = TS.search(name) or (TS.search(event_folder) if event_folder else None)
    if not m:
        return None
    return time.mktime(time.strptime(f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}", "%Y-%m-%d %H:%M:%S"))


def file_type(name):
    if name.endswith(".mp4"):
        return "video" if CAM.search(name) else "event_video"
    if name == "event.json":
        return "event_json"
    if name.endswith(".png"):
        return "thumbnail"
    return "other"


def read_json(path):
    try:
        with open(path) as f:
            return json.load(f)
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--kind", required=True, choices=["auto", "recent", "saved", "sentry"])
    ap.add_argument("--list", required=True)
    ap.add_argument("--src", required=True)
    ap.add_argument("--dest")
    ap.add_argument("--pc-prefix", default="")
    a = ap.parse_args()

    now = datetime.now().astimezone().isoformat(timespec="seconds")
    synced = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                            capture_output=True, text=True).stdout.strip() == "yes"
    with open("/proc/sys/kernel/random/boot_id") as f:
        boot_id = f.read().strip()

    lock = open(META_LOCK, "w")
    fcntl.flock(lock, fcntl.LOCK_EX)
    meta = {}
    if a.kind in ("recent", "auto") and os.path.exists(ARCHIVE_META):
        with open(ARCHIVE_META) as f:
            for line in f:
                try:
                    m = json.loads(line)
                    meta[m["rel"]] = m
                except (ValueError, KeyError):
                    pass

    os.makedirs(METRICS_DIR, exist_ok=True)
    out_path = f"{METRICS_DIR}/manifest-{datetime.now().strftime('%Y-%m')}.jsonl"
    written = 0
    with open(a.list) as lf, open(out_path, "a") as out:
        for line in lf:
            line = line.rstrip("\n")
            if not line or "\t" not in line:
                continue
            rel, size = line.rsplit("\t", 1)
            size = int(size)
            if a.dest:
                dest = os.path.join(a.dest, rel)
                try:
                    if os.path.getsize(dest) != size:
                        continue
                except OSError:
                    continue                              # not copied (yet)
            else:
                dest = os.path.join(a.src, rel)           # confirmed by teslacam-upload.py; read local copy
            kind = a.kind
            if kind == "auto":
                top = [p for p in rel.split("/") if p != "EncryptedClips"][:1]
                kind = {"RecentClips": "recent", "SavedClips": "saved", "SentryClips": "sentry"}.get(
                    top[0] if top else "", "recent")
            name = os.path.basename(rel)
            pc_path = "/".join(p for p in (a.pc_prefix, rel) if p)
            parts = rel.split("/")
            rec = {
                "uploaded_at": now,
                "clock_synced": synced,
                "kind": kind,
                "pc_path": pc_path,
                "file": name,
                "file_type": file_type(name),
                "camera": (CAM.search(name).group(1) if CAM.search(name) else None),
                "car_time": car_time(name),
                "event_folder": (parts[-2] if len(parts) >= 2 and parts[-2] not in ("SavedClips", "SentryClips")
                                 else None) if kind != "recent" else None,
                "size_bytes": size,
                "encrypted": "EncryptedClips" in pc_path,
                "boot_id": boot_id,
                "saved_to_pi_at": None,
                "saved_to_pi_clock_synced": None,
            }
            if kind == "recent":
                m = meta.pop(rel, None)
                if m:
                    rec["boot_id"] = m.get("boot_id")
                    rec["saved_to_pi_at"] = m.get("saved_at")
                    rec["saved_to_pi_clock_synced"] = m.get("clock_synced")
                    rec["recorded_where"] = m.get("where")
            if name == "event.json":
                rec["event"] = read_json(dest)
            t = name_epoch(name, rec["event_folder"])
            if t and a.dest:
                try:
                    os.utime(dest, (t, t))        # PC file time = recording time (not 7 h off)
                except OSError:
                    pass
            out.write(json.dumps(rec, separators=(",", ":")) + "\n")
            written += 1

    if a.kind in ("recent", "auto"):
        # keep metadata only for footage still waiting on the Pi
        keep = [m for r, m in meta.items() if os.path.exists(os.path.join(a.src, r))]
        tmp = ARCHIVE_META + ".tmp"
        with open(tmp, "w") as f:
            f.writelines(json.dumps(m, separators=(",", ":")) + "\n" for m in keep)
        os.replace(tmp, ARCHIVE_META)
    lock.close()
    print(f"manifest: {written} files recorded")


if __name__ == "__main__":
    main()
