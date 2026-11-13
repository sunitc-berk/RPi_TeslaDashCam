"""indexer.py - scan the TeslaCam folder and build data/index.db (SQLite) for the dashboard.

Run by server.py every few minutes, or by hand:   python indexer.py

Reads:
  RecentClips/, SavedClips/<event>/, SentryClips/<event>/   (and the same under EncryptedClips/)
  Favorites/<id>/favorite.json                               (footage kept by the dashboard)
  PiMetrics/manifest-*.jsonl                                 (per-file info logged by the Pi)
  PiMetrics/YYYY-MM-DD.jsonl                                 (Pi health samples)
  PiMetrics/sync-history.jsonl                               (one line per upload)
"""
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path

HERE = Path(__file__).resolve().parent
CAMS = ["front", "left_pillar", "right_pillar", "left_repeater", "back", "right_repeater"]
TS = re.compile(r"(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})")
CAM_RE = re.compile(r"-(front|back|left_repeater|right_repeater|left_pillar|right_pillar)\.mp4$")
KIND_DIRS = {"RecentClips": "recent", "SavedClips": "saved", "SentryClips": "sentry"}


def load_settings():
    s = {"root": None, "host": "127.0.0.1", "port": 8080,
         "index_interval_seconds": 300, "trip_gap_minutes": 5, "show_home_footage_warnings": False,
         "recent_retention_days": 30, "place_names": False, "home": None}
    p = HERE / "settings.json"
    if p.exists():
        s.update(json.loads(p.read_text()))
    if s["root"]:
        s["root"] = Path(s["root"])
    else:
        # default: the folder above webapp - unless it has no footage (e.g. the dashboard was started
        # from a copy in another folder), then the standard D:\TeslaCam (C:\TeslaCam before the move)
        parent = HERE.parent
        has_footage = any((parent / d).is_dir() for d in ("RecentClips", "SavedClips", "SentryClips", "PiMetrics"))
        fallback = next((p for p in (Path("D:/TeslaCam"), Path("C:/TeslaCam")) if p.is_dir()), None)
        s["root"] = parent if has_footage or fallback is None else fallback
    return s


def db_path():
    d = HERE / "data"
    d.mkdir(exist_ok=True)
    return d / "index.db"


SCHEMA = """
CREATE TABLE IF NOT EXISTS clips (
  path TEXT PRIMARY KEY, kind TEXT, camera TEXT, file_type TEXT, car_time TEXT,
  segment_key TEXT, event_id TEXT, size INTEGER, mtime REAL, encrypted INTEGER,
  boot_id TEXT, uploaded_at TEXT, saved_to_pi_at TEXT, from_favorites INTEGER);
CREATE TABLE IF NOT EXISTS segments (
  key TEXT PRIMARY KEY, kind TEXT, event_id TEXT, start TEXT, cameras TEXT,
  n_cameras INTEGER, size INTEGER, encrypted INTEGER, trip_id TEXT, boot_id TEXT, place TEXT);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, kind TEXT, folder TEXT, path TEXT, timestamp TEXT, city TEXT,
  street TEXT, lat REAL, lon REAL, reason TEXT, camera TEXT, thumb TEXT, event_video TEXT,
  start TEXT, end TEXT, n_segments INTEGER, size INTEGER, encrypted INTEGER, trip_id TEXT,
  raw TEXT);
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY, start TEXT, end TEXT, duration_s INTEGER, n_segments INTEGER,
  size INTEGER, n_events INTEGER, encrypted INTEGER, first_segment TEXT, place TEXT);
CREATE TABLE IF NOT EXISTS pi_metrics (
  time TEXT, time_source TEXT, boot_id TEXT, uptime_s INTEGER, cpu_temp_c REAL,
  under_voltage_now INTEGER, under_voltage_since_boot INTEGER, throttled_now INTEGER,
  cpu_usage_pct REAL, memory_used_pct REAL, sd_free_gb REAL, wifi_connected INTEGER,
  wifi_dbm REAL, pc_reachable INTEGER, usb_state TEXT, cam_used_pct REAL,
  recent_on_pi_gb REAL, raw TEXT, PRIMARY KEY (boot_id, uptime_s));
CREATE TABLE IF NOT EXISTS syncs (
  time TEXT, kind TEXT, files INTEGER, mb INTEGER, duration_s INTEGER, mb_per_s REAL,
  success INTEGER, raw TEXT, PRIMARY KEY (time, kind));
CREATE TABLE IF NOT EXISTS removed (
  path TEXT PRIMARY KEY, kind TEXT, car_time TEXT, size INTEGER, removed_at TEXT);
CREATE TABLE IF NOT EXISTS favorites (
  id TEXT PRIMARY KEY, item_type TEXT, item_id TEXT, created TEXT, note TEXT);
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS gps (path TEXT PRIMARY KEY, size INTEGER, points TEXT);
CREATE TABLE IF NOT EXISTS trip_parts (trip_id TEXT PRIMARY KEY, sig TEXT, parts TEXT);
CREATE TABLE IF NOT EXISTS places (cell TEXT PRIMARY KEY, name TEXT, city TEXT, fetched TEXT);
CREATE INDEX IF NOT EXISTS seg_start ON segments(start);
CREATE INDEX IF NOT EXISTS seg_trip ON segments(trip_id);
CREATE INDEX IF NOT EXISTS ev_ts ON events(timestamp);
CREATE INDEX IF NOT EXISTS pm_time ON pi_metrics(time);
"""


def connect():
    con = sqlite3.connect(db_path(), timeout=30)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    # upgrade databases made by older versions (these tables are rebuilt on every scan anyway)
    for table in ("segments", "trips"):
        cols = [r[1] for r in con.execute(f"PRAGMA table_info({table})")]
        if cols and "place" not in cols:
            con.execute(f"DROP TABLE {table}")
    con.executescript(SCHEMA)
    return con


def car_time(name):
    m = TS.search(name)
    return f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}" if m else None


def parse_t(s):
    return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")


def fnum(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def read_jsonl(path):
    out = []
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line:
                    try:
                        out.append(json.loads(line))
                    except ValueError:
                        pass
    except OSError:
        pass
    return out


# ------------------------------------------------------------------ scanning
def scan_footage(root):
    """Return {rel_path: clip dict} for every file in the clip folders."""
    clips = {}
    for prefix in ("", "EncryptedClips/"):
        for dirname, kind in KIND_DIRS.items():
            base = root / (prefix + dirname)
            if not base.is_dir():
                continue
            for dirpath, _, files in os.walk(base):
                for name in files:
                    full = Path(dirpath) / name
                    rel = full.relative_to(root).as_posix()
                    sub = full.relative_to(base).parts
                    event_folder = sub[0] if kind != "recent" and len(sub) > 1 else None
                    add_clip(clips, rel, full, kind, event_folder, bool(prefix))
    return clips


def add_clip(clips, rel, full, kind, event_folder, encrypted, from_fav=False, served_path=None):
    name = Path(rel).name                 # parse the ORIGINAL file name (favorites are renamed copies)
    if name.endswith(".part") or name.startswith("."):
        return                                # half-uploaded (rsync temp files start with ".")
    try:
        st = full.stat()
    except OSError:
        return
    # file date = recording time from the name (uploads arrive with the upload time as their date)
    m = TS.search(name) or (TS.search(event_folder) if event_folder else None)
    if m and not from_fav:
        t = time.mktime(time.strptime(f"{m.group(1)} {m.group(2)}:{m.group(3)}:{m.group(4)}", "%Y-%m-%d %H:%M:%S"))
        if abs(st.st_mtime - t) > 2:
            try:
                os.utime(full, (t, t))
            except OSError:
                pass
    cam = CAM_RE.search(name)
    if name.endswith(".mp4"):
        ftype = "video" if cam else "event_video"
    elif name == "event.json":
        ftype = "event_json"
    elif name.endswith(".png") or name.endswith(".jpg"):
        ftype = "thumbnail"
    else:
        ftype = "other"
    event_id = f"{'enc-' if encrypted else ''}{kind}-{event_folder}" if event_folder else None
    ct = car_time(name)
    seg_key = f"{kind}|{event_id or ''}|{ct}|{int(encrypted)}" if ftype == "video" and ct else None
    clips[rel] = {
        "path": served_path or rel, "kind": kind, "camera": cam.group(1) if cam else None,
        "file_type": ftype, "car_time": ct, "segment_key": seg_key, "event_id": event_id,
        "size": st.st_size, "mtime": st.st_mtime, "encrypted": int(encrypted),
        "boot_id": None, "uploaded_at": None, "saved_to_pi_at": None,
        "from_favorites": int(from_fav), "_event_folder": event_folder,
    }


def scan_favorites(root, clips):
    """Footage kept in Favorites/ stays viewable after the original is removed by retention."""
    fav_root = root / "Favorites"
    if not fav_root.is_dir():
        return
    for d in fav_root.iterdir():
        info_p = d / "favorite.json"
        if not info_p.exists():
            continue
        try:
            info = json.loads(info_p.read_text())
        except ValueError:
            continue
        for fname, orig in info.get("files", {}).items():
            if orig["rel"] in clips:
                continue                      # original still there
            full = d / fname
            if full.exists():
                add_clip(clips, orig["rel"], full, orig["kind"], orig.get("event_folder"),
                         orig.get("encrypted", False), from_fav=True,
                         served_path=full.relative_to(root).as_posix())


def merge_manifest(root, clips):
    for mf in sorted((root / "PiMetrics").glob("manifest-*.jsonl")):
        for rec in read_jsonl(mf):
            c = clips.get(rec.get("pc_path"))
            if c:
                c["boot_id"] = rec.get("boot_id")
                c["uploaded_at"] = rec.get("uploaded_at")
                c["saved_to_pi_at"] = rec.get("saved_to_pi_at")
                c["place"] = rec.get("recorded_where")


# ------------------------------------------------------------------ building
def build_segments(clips):
    segs = {}
    for rel, c in clips.items():
        k = c["segment_key"]
        if not k:
            continue
        s = segs.setdefault(k, {"key": k, "kind": c["kind"], "event_id": c["event_id"],
                                "start": c["car_time"], "cameras": {}, "size": 0,
                                "encrypted": c["encrypted"], "trip_id": None, "boot_id": None,
                                "place": None})
        s["cameras"][c["camera"]] = c["path"]
        s["size"] += c["size"]
        s["boot_id"] = s["boot_id"] or c["boot_id"]
        s["place"] = s["place"] or c.get("place")
    return segs


def build_trips(segs, gap_minutes):
    recent = sorted((s for s in segs.values() if s["kind"] == "recent"), key=lambda s: s["start"])
    trips, cur, prev = [], None, None
    for s in recent:
        t = parse_t(s["start"])
        place = s.get("place")
        # new trip after a gap, or when the Pi says the car moved between home and away
        if (cur is None or t - prev > timedelta(minutes=1 + gap_minutes)
                or (place and cur["place"] and place != cur["place"])):
            cur = {"segs": [], "place": place}
            trips.append(cur)
        cur["place"] = cur["place"] or place
        cur["segs"].append(s)
        prev = t
    out = {}
    for tr in trips:
        first, last = tr["segs"][0], tr["segs"][-1]
        tid = "trip-" + first["start"].replace("-", "").replace(":", "").replace(" ", "-")
        end = (parse_t(last["start"]) + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
        for s in tr["segs"]:
            s["trip_id"] = tid
        out[tid] = {"id": tid, "start": first["start"], "end": end,
                    "duration_s": int((parse_t(end) - parse_t(first["start"])).total_seconds()),
                    "n_segments": len(tr["segs"]), "size": sum(s["size"] for s in tr["segs"]),
                    "n_events": 0, "encrypted": int(all(s["encrypted"] for s in tr["segs"])),
                    "first_segment": first["key"], "place": tr["place"]}
    return out


def build_events(root, clips, segs, trips):
    events = {}
    for rel, c in clips.items():
        if not c["event_id"]:
            continue
        e = events.setdefault(c["event_id"], {
            "id": c["event_id"], "kind": c["kind"], "folder": c["_event_folder"],
            "path": str(Path(rel).parent.as_posix()), "timestamp": car_time(c["_event_folder"]),
            "city": None, "street": None, "lat": None, "lon": None, "reason": None,
            "camera": None, "thumb": None, "event_video": None, "start": None, "end": None,
            "n_segments": 0, "size": 0, "encrypted": c["encrypted"], "trip_id": None, "raw": None})
        e["size"] += c["size"]
        if c["file_type"] == "thumbnail":
            e["thumb"] = c["path"]
        elif c["file_type"] == "event_video":
            e["event_video"] = c["path"]
        elif c["file_type"] == "event_json":
            try:
                j = json.loads((root / c["path"]).read_text(encoding="utf-8"))
            except (OSError, ValueError):
                j = None
            if j:
                e["raw"] = json.dumps(j)
                if j.get("timestamp"):
                    e["timestamp"] = j["timestamp"].replace("T", " ")[:19]
                e["city"], e["street"] = j.get("city"), j.get("street")
                e["lat"], e["lon"] = fnum(j.get("est_lat")), fnum(j.get("est_lon"))
                e["reason"], e["camera"] = j.get("reason"), j.get("camera")
    for s in segs.values():
        e = events.get(s["event_id"]) if s["event_id"] else None
        if e:
            e["n_segments"] += 1
            e["start"] = min(e["start"] or s["start"], s["start"])
            end = (parse_t(s["start"]) + timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
            e["end"] = max(e["end"] or end, end)
    for e in events.values():
        if e["timestamp"]:
            for t in trips.values():
                if t["start"] <= e["timestamp"] <= t["end"]:
                    e["trip_id"] = t["id"]
                    t["n_events"] += 1
                    break
    return events


def load_metrics(root):
    rows = []
    for p in sorted((root / "PiMetrics").glob("*.jsonl")):
        if p.name.startswith(("manifest-", "sync-history")):
            continue
        for r in read_jsonl(p):
            th = r.get("throttling") or {}
            wifi = r.get("wifi") or {}
            rows.append((
                r.get("time_corrected") or r.get("time_pi"), r.get("time_source"), r.get("boot_id"),
                r.get("uptime_s"), r.get("cpu_temp_c"), int(bool(th.get("under_voltage_now"))),
                int(bool(th.get("under_voltage_since_boot"))), int(bool(th.get("throttled_now"))),
                r.get("cpu_usage_pct"), (r.get("memory") or {}).get("used_pct"),
                (r.get("sd_card") or {}).get("free_gb"), int(bool(wifi.get("connected"))),
                wifi.get("signal_dbm"), int(bool(r.get("pc_reachable"))), r.get("usb_state"),
                (r.get("cam_drive") or {}).get("used_pct"),
                (r.get("recent_saved_on_pi") or {}).get("gb"), json.dumps(r)))
    return rows


def load_syncs(root):
    rows = []
    for r in read_jsonl(root / "PiMetrics" / "sync-history.jsonl"):
        rows.append((r.get("time_pi"), r.get("kind", "events"), r.get("files"), r.get("mb"),
                     r.get("duration_s"), r.get("mb_per_s"), int(bool(r.get("success"))),
                     json.dumps(r)))
    return rows


# ------------------------------------------------------------------ main
def run_index(settings=None):
    settings = settings or load_settings()
    root = settings["root"]
    t0 = time.time()
    clips = scan_footage(root)
    scan_favorites(root, clips)
    merge_manifest(root, clips)
    segs = build_segments(clips)
    trips = build_trips(segs, settings["trip_gap_minutes"])
    events = build_events(root, clips, segs, trips)
    metrics = load_metrics(root)
    syncs = load_syncs(root)

    con = connect()
    with con:
        old = {r["path"]: r for r in con.execute("SELECT path, kind, car_time, size FROM clips")}
        now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        current_paths = {c["path"] for c in clips.values()}
        for p, r in old.items():
            if p not in current_paths:
                con.execute("INSERT OR REPLACE INTO removed VALUES (?,?,?,?,?)",
                            (p, r["kind"], r["car_time"], r["size"], now))
        for t in ("clips", "segments", "events", "trips", "pi_metrics", "syncs"):
            con.execute(f"DELETE FROM {t}")
        con.executemany("INSERT INTO clips VALUES (:path,:kind,:camera,:file_type,:car_time,"
                        ":segment_key,:event_id,:size,:mtime,:encrypted,:boot_id,:uploaded_at,"
                        ":saved_to_pi_at,:from_favorites)", list(clips.values()))
        con.executemany("INSERT INTO segments VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
            (s["key"], s["kind"], s["event_id"], s["start"], json.dumps(s["cameras"]),
             len(s["cameras"]), s["size"], s["encrypted"], s["trip_id"], s["boot_id"], s["place"])
            for s in segs.values()])
        con.executemany("INSERT INTO trips VALUES (:id,:start,:end,:duration_s,:n_segments,:size,"
                        ":n_events,:encrypted,:first_segment,:place)", list(trips.values()))
        con.executemany("INSERT INTO events VALUES (:id,:kind,:folder,:path,:timestamp,:city,"
                        ":street,:lat,:lon,:reason,:camera,:thumb,:event_video,:start,:end,"
                        ":n_segments,:size,:encrypted,:trip_id,:raw)", list(events.values()))
        con.executemany("INSERT OR IGNORE INTO pi_metrics VALUES "
                        "(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", metrics)
        con.executemany("INSERT OR IGNORE INTO syncs VALUES (?,?,?,?,?,?,?,?)", syncs)
        con.execute("INSERT OR REPLACE INTO meta VALUES ('last_index', ?)", (now,))
        con.execute("INSERT OR REPLACE INTO meta VALUES ('index_seconds', ?)",
                    (f"{time.time() - t0:.1f}",))
    con.close()
    return {"clips": len(clips), "segments": len(segs), "trips": len(trips),
            "events": len(events), "metrics": len(metrics), "syncs": len(syncs),
            "seconds": round(time.time() - t0, 1)}


if __name__ == "__main__":
    print(run_index())
