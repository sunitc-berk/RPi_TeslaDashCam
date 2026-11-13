"""fix-file-times.py - one-time fix: set each footage file's date to its recording time.

Files uploaded before the fix show a time 7 hours off in Explorer (the dashcam drive stores
times without a time zone). The real recording time is in every file name, so this sets each
file's "Date modified" from its name (or, for event.json / thumb.png, from its event folder).

Run from the webapp folder:   .venv\\Scripts\\python fix-file-times.py
"""
import os
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent          # D:\TeslaCam
TS = re.compile(r"(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})")
FOLDERS = ["RecentClips", "SavedClips", "SentryClips", "EncryptedClips", "Favorites"]


def name_time(*names):
    for n in names:
        m = TS.search(n)
        if m:
            return time.mktime(time.strptime(f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}",
                                             "%Y-%m-%d %H:%M:%S"))
    return None


fixed = same = skipped = 0
for folder in FOLDERS:
    base = ROOT / folder
    if not base.is_dir():
        continue
    for dirpath, _, files in os.walk(base):
        for name in files:
            p = Path(dirpath) / name
            # Favorites copies are named "SavedClips__<event>__<file>", so the name still has the time
            t = name_time(name.split("__")[-1], Path(dirpath).name, name)
            if t is None:
                skipped += 1
                continue
            if abs(p.stat().st_mtime - t) < 2:
                same += 1
                continue
            os.utime(p, (t, t))
            fixed += 1
print(f"Fixed {fixed} files, {same} were already right, {skipped} had no time in their name.")
