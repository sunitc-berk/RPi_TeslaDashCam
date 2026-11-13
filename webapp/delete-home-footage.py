"""delete-home-footage.py - delete the footage recorded while the car was parked at home.

Deletes exactly what the dashboard lists under Parked as "at home": stretches where the car was
not being driven and was at home. Drives are never deleted - not even a drive that ends in your
garage. (An earlier version of this script went by the Pi's "home" label, which could include
the last part of a drive home.)

A stretch is only deleted when the script is sure of both things:
  - parked: the car's own data in the video (gear and speed) was read for every minute of it
  - at home: the drive before or after it ended/started at home, or the whole recording has no
    driving in it and the Pi saw your home Wi-Fi while saving it
Anything it cannot be sure about is left alone and counted as "not sure".

Afterwards the dashboard's records are cleaned up so nothing points at the deleted files, and the
files are NOT listed under "Removed by retention" on the Storage page.
Saved and Sentry clips are never touched. Footage you marked Keep is kept.

Usage (from the webapp folder, e.g. D:\\TeslaCam\\webapp):
  python delete-home-footage.py                 # dry run: shows what would be deleted, deletes nothing
  python delete-home-footage.py --delete        # deletes, after you type YES
  python delete-home-footage.py --delete --yes  # deletes without asking (for a scheduled task)
  python delete-home-footage.py --before 2026-11-01   # only footage recorded before that day

The dashboard can stay running.
"""
import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import drives  # noqa: E402
import gps  # noqa: E402
import indexer  # noqa: E402


def gb(b):
    return f"{b / 1e9:.1f} GB" if b >= 1e8 else f"{b / 1e6:.0f} MB"


def main():
    ap = argparse.ArgumentParser(description="Delete footage recorded while parked at home.")
    ap.add_argument("--delete", action="store_true", help="really delete (default is a dry run)")
    ap.add_argument("--yes", action="store_true", help="don't ask for confirmation")
    ap.add_argument("--before", metavar="YYYY-MM-DD", help="only trips that started before this day")
    args = ap.parse_args()
    if args.before:
        datetime.strptime(args.before, "%Y-%m-%d")         # fail early on a bad date

    settings = indexer.load_settings()
    root = Path(settings["root"]).resolve()
    print(f"Footage folder: {root}")
    print("Refreshing the index ...")
    indexer.run_index(settings)

    con = indexer.connect()
    print("Reading the car's data from footage that has not been looked at yet (this can take a few minutes) ...")
    count = lambda: con.execute("SELECT COUNT(*) FROM gps").fetchone()[0]
    while True:                                            # until every clip has been read
        before = count()
        gps.warm(con, root, budget_s=120)
        if count() == before:
            break
        left = con.execute("SELECT COUNT(*) FROM segments WHERE encrypted=0").fetchone()[0] - count()
        if left > 0:
            print(f"  ... about {left} minutes of footage to go")
    data = drives.build(con, root, settings)
    if not data["home"]:
        print("Cannot tell where home is yet (it is worked out from where your drives start and end).\n"
              "Nothing was deleted. Try again after a few more drives.")
        return 0
    has_drive = {it["trip"] for it in data["items"] if it["type"] == "drive"}
    read = {r[0] for r in con.execute("SELECT path FROM gps")}

    parts, kept, unsure = [], 0, 0
    for it in data["items"]:
        if it["type"] != "parked" or not it["at_home"]:
            continue
        if args.before and it["start"] >= args.before:
            continue
        if it["kept"]:
            kept += 1
            continue
        segs = con.execute("SELECT key, cameras, encrypted FROM segments WHERE trip_id=? ORDER BY start",
                           (it["trip"],)).fetchall()[it["a"]:it["b"] + 1]
        checked = segs and all(not s["encrypted"] and gps.segment_clip(json.loads(s["cameras"])) in read for s in segs)
        located = it["at"] is not None or it["trip"] not in has_drive
        if not (checked and located):
            unsure += 1
            continue
        it["keys"] = [s["key"] for s in segs]
        parts.append(it)
    parts.sort(key=lambda x: x["start"])
    if not parts:
        print("Nothing to delete - no parked-at-home footage found"
              + (f" ({kept} kept, {unsure} not sure)." if kept or unsure else "."))
        return 0

    keys = [k for it in parts for k in it["keys"]]
    files = []
    for i in range(0, len(keys), 500):                     # SQLite limits the number of ? per query
        chunk = keys[i:i + 500]
        files += [dict(r) for r in con.execute(
            f"SELECT path, size FROM clips WHERE segment_key IN ({','.join('?' * len(chunk))}) "
            "AND from_favorites = 0 AND kind = 'recent'", chunk)]
    total = sum(f["size"] or 0 for f in files)

    print()
    print(f"Parked at home: {len(parts)} recordings, {len(keys)} minutes, {len(files)} files, {gb(total)}")
    print(f"Recorded {parts[0]['start'][:16]} to {parts[-1]['end'][:16]}")
    if kept:
        print(f"Keeping {kept} that you marked Keep.")
    if unsure:
        print(f"Leaving {unsure} alone: not sure they are parked at home.")
    by_day = {}
    for it in parts:
        d = by_day.setdefault(it["start"][:10], [0, 0])
        d[0] += len(it["keys"])
        d[1] += it["size"] or 0
    for d, (n, b) in sorted(by_day.items()):
        print(f"  {d}  {n:4d} min  {gb(b):>8}")

    if not args.delete:
        print("\nDry run - nothing was deleted. Run again with --delete to delete these files.")
        return 0
    if not args.yes:
        if input(f"\nDelete these {len(files)} files ({gb(total)})? This cannot be undone. Type YES: ").strip() != "YES":
            print("Cancelled - nothing was deleted.")
            return 1

    deleted, failed, freed = [], [], 0
    for f in files:
        p = (root / f["path"]).resolve()
        if root not in p.parents:                           # never touch anything outside the footage folder
            failed.append((f["path"], "outside the footage folder"))
            continue
        try:
            p.unlink()
            deleted.append(f["path"])
            freed += f["size"] or 0
        except FileNotFoundError:
            deleted.append(f["path"])                       # already gone - still clean up its records
        except OSError as e:                                # e.g. open in the dashboard player right now
            failed.append((f["path"], e.strerror or str(e)))

    # clean the dashboard's records: drop the deleted files from the index first, so the rebuild does not
    # list them as "Removed by retention", then rebuild, then clear any that slipped in meanwhile
    with con:
        for i in range(0, len(deleted), 500):
            chunk = deleted[i:i + 500]
            marks = ",".join("?" * len(chunk))
            con.execute(f"DELETE FROM clips WHERE path IN ({marks})", chunk)
            con.execute(f"DELETE FROM removed WHERE path IN ({marks})", chunk)
    con.close()
    print("Updating the dashboard ...")
    indexer.run_index(settings)
    con = indexer.connect()
    with con:
        for i in range(0, len(deleted), 500):
            chunk = deleted[i:i + 500]
            con.execute(f"DELETE FROM removed WHERE path IN ({','.join('?' * len(chunk))})", chunk)
    con.close()

    print(f"\nDeleted {len(deleted)} files, freed {gb(freed)}.")
    if failed:
        print(f"{len(failed)} file{'s' if len(failed) != 1 else ''} could not be deleted "
              "(close the dashboard's player and run the script again):")
        for path, why in failed[:10]:
            print(f"  {path}: {why}")
        return 1
    print("Refresh the dashboard to see the change.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
