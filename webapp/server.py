"""server.py - TeslaCam dashboard web server.

    python server.py            then open http://localhost:8080

Re-indexes the TeslaCam folder in the background every few minutes (settings.json).
"""
import json
import mimetypes
import os
import re
import shutil
import sqlite3
import threading
import time
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path

import sys

if sys.stdout is None:                      # started hidden with pythonw: log to a file instead
    (Path(__file__).resolve().parent / "data").mkdir(exist_ok=True)
    _log = open(Path(__file__).resolve().parent / "data" / "server.log", "a", buffering=1)
    sys.stdout = sys.stderr = _log

import logging

import uvicorn

# On Windows, Python prints "ConnectionResetError: [WinError 10054]" every time the browser
# drops a video download it no longer needs (seeking, skipping, closing the player). Harmless - hide it.
logging.getLogger("asyncio").setLevel(logging.CRITICAL)
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import drives
import gps
import indexer

SETTINGS = indexer.load_settings()
ROOT: Path = SETTINGS["root"].resolve()
HERE = Path(__file__).resolve().parent
mimetypes.add_type("video/mp4", ".mp4")

_index_lock = threading.Lock()
_index_status = {"running": False, "last_result": None, "last_error": None}


def reindex():
    if not _index_lock.acquire(blocking=False):
        return
    _index_status["running"] = True
    try:
        _index_status["last_result"] = indexer.run_index(SETTINGS)
        _index_status["last_error"] = None
    except Exception as e:                                  # keep serving even if a scan fails
        _index_status["last_error"] = repr(e)
    finally:
        _index_status["running"] = False
        _index_lock.release()


def index_loop():
    while True:
        reindex()
        try:                                                # read the car's GPS track from new clips
            con = db()
            gps.warm(con, ROOT, budget_s=240)
            data = drives.get(con, ROOT, SETTINGS)          # split new footage into drives now, not on first view
            if SETTINGS.get("place_names") and data["missing_places"]:
                drives.lookup_places(con, data["missing_places"], budget_s=150)
            con.close()
        except Exception as e:
            print("GPS scan:", repr(e))
        time.sleep(SETTINGS["index_interval_seconds"])


@asynccontextmanager
async def lifespan(app):
    indexer.connect().close()                               # make sure the schema exists
    threading.Thread(target=index_loop, daemon=True).start()
    yield


app = FastAPI(title="TeslaCam Dashboard", lifespan=lifespan)


@app.middleware("http")
async def no_stale_pages(request, call_next):
    """Make browsers re-check the page files every time, so updates show up without Ctrl+F5."""
    response = await call_next(request)
    if not request.url.path.startswith("/media/"):
        response.headers["Cache-Control"] = "no-cache"
    return response


def db():
    return indexer.connect()


def rows(sql, args=()):
    con = db()
    try:
        return [dict(r) for r in con.execute(sql, args)]
    finally:
        con.close()


def seg_out(r):
    r = dict(r)
    r["cameras"] = json.loads(r["cameras"])
    return r


def fav_ids():
    return {r["id"] for r in rows("SELECT id FROM favorites")}


# ------------------------------------------------------------------ summary / browse
@app.get("/api/summary")
def summary():
    con = db()
    try:
        q = lambda sql, a=(): con.execute(sql, a).fetchone()
        clips = q("SELECT COUNT(*) n, COALESCE(SUM(size),0) b, MIN(car_time) first, MAX(car_time) last FROM clips")
        by_kind = {r["kind"]: {"files": r["n"], "gb": round(r["b"] / 1e9, 2)} for r in con.execute(
            "SELECT kind, COUNT(*) n, SUM(size) b FROM clips GROUP BY kind")}
        latest = q("SELECT * FROM pi_metrics ORDER BY time DESC LIMIT 1")
        last_sync = q("SELECT * FROM syncs ORDER BY time DESC LIMIT 1")
        meta = {r["k"]: r["v"] for r in con.execute("SELECT * FROM meta")}
        disk = shutil.disk_usage(ROOT)
        return {
            "files": clips["n"], "gb": round(clips["b"] / 1e9, 2),
            "first": clips["first"], "last": clips["last"], "by_kind": by_kind,
            "last_day": max(filter(None, [q("SELECT MAX(end) FROM trips")[0],
                                          q("SELECT MAX(timestamp) FROM events")[0]]), default=None),
            "trips": q("SELECT COUNT(*) FROM trips")[0], "events": q("SELECT COUNT(*) FROM events")[0],
            "favorites": q("SELECT COUNT(*) FROM favorites")[0],
            "encrypted_files": q("SELECT COUNT(*) FROM clips WHERE encrypted=1")[0],
            "pc_disk_free_gb": round(disk.free / 1e9, 1), "pc_disk_total_gb": round(disk.total / 1e9, 1),
            "pi_latest": dict(latest) if latest else None,
            "last_sync": dict(last_sync) if last_sync else None,
            "last_index": meta.get("last_index"), "index": _index_status, "root": str(ROOT),
        }
    finally:
        con.close()


def day_span(start, end):
    """All dates (YYYY-MM-DD) a trip touches - overnight footage shows on every day it covers."""
    d, last = datetime.strptime(start[:10], "%Y-%m-%d"), datetime.strptime(end[:10], "%Y-%m-%d")
    while d <= last:
        yield d.strftime("%Y-%m-%d")
        d += timedelta(days=1)


@app.get("/api/days")
def days(month: str):
    """Activity per day for a calendar month (YYYY-MM)."""
    out = {}
    for t in rows("SELECT start, end, duration_s, place FROM trips WHERE start <= ? AND end >= ?",
                  (month + "-31 23:59:59", month + "-01")):
        for d in day_span(t["start"], t["end"]):
            if d.startswith(month):
                key = "parked" if t["place"] == "home" else "trips"
                out.setdefault(d, {})[key] = out.get(d, {}).get(key, 0) + 1
    for r in rows("SELECT substr(timestamp,1,10) d, kind, COUNT(*) n FROM events "
                  "WHERE timestamp LIKE ? GROUP BY d, kind", (month + "%",)):
        out.setdefault(r["d"], {})[r["kind"]] = r["n"]
    return out


@app.get("/api/months")
def months():
    return [r["m"] for r in rows(
        "SELECT DISTINCT substr(start,1,7) m FROM segments WHERE start IS NOT NULL ORDER BY m DESC")]


@app.get("/api/day/{date}")
def day(date: str):
    favs = fav_ids()
    trips = rows("SELECT * FROM trips WHERE start <= ? AND end >= ? ORDER BY start",
                 (date + " 23:59:59", date + " 00:00:00"))
    events = rows("SELECT * FROM events WHERE timestamp LIKE ? ORDER BY timestamp", (date + "%",))
    for t in trips:
        t["favorite"] = t["id"] in favs
        t["thumb_segment"] = thumb_seg(t["first_segment"])
    for e in events:
        e["favorite"] = e["id"] in favs
        e.pop("raw", None)
    return {"date": date, "trips": trips, "events": events}


def thumb_seg(key):
    r = rows("SELECT cameras FROM segments WHERE key=?", (key,))
    if not r:
        return None
    cams = json.loads(r[0]["cameras"])
    return cams.get("front") or next(iter(cams.values()), None)


# ------------------------------------------------------------------ home list: drives, parked stretches, alerts
def feed_data():
    con = db()
    try:
        return drives.get(con, ROOT, SETTINGS)
    finally:
        con.close()


@app.get("/api/feed")
def feed(month: str = "", q: str = "", kept: bool = False):
    """Everything for the home list, newest first: one month (YYYY-MM, default the latest with footage),
    or - with q - whatever matches a place, a date or a type in any month, or - with kept - everything kept."""
    data = feed_data()
    items = data["items"]
    months = sorted({i["start"][:7] for i in items}, reverse=True)
    if kept:
        out, month, q = [i for i in items if i.get("kept")], "", ""
    elif q.strip():
        out, month = [i for i in items if drives.matches(i, q)][:400], ""
    else:
        month = month if month in months else (months[0] if months else "")
        out = [i for i in items if i["start"].startswith(month)] if month else []
    return {"month": month, "months": months, "q": q.strip(), "home": data["home"], "kept_only": kept,
            "keep_days": int(SETTINGS.get("recent_retention_days", 30)),
            "place_names": bool(SETTINGS.get("place_names")), "items": out}


@app.get("/api/parts/{trip_id}")
def trip_parts(trip_id: str):
    """The drives and parked stretches one recording is made of, oldest first (the player's titles)."""
    return sorted((i for i in feed_data()["items"] if i.get("trip") == trip_id), key=lambda i: i["a"])


# ------------------------------------------------------------------ search
def fav_times():
    return {r["id"]: r["created"] for r in rows("SELECT id, created FROM favorites")}


@app.get("/api/search")
def search(start: str = "", end: str = "", kind: str = "all", reason: str = "",
           q: str = "", favorites_only: bool = False, limit: int = 5000):
    """kind: all | trip (driving) | parked (recorded while parked at home) | saved | sentry.
    Every result carries type, start/end, duration_s, size, favorite, starred (when starred)
    and cameras (most cameras in any of its one-minute segments)."""
    favs = fav_times()
    start = start.replace("T", " ") or "0000"
    end = end.replace("T", " ") or "9999"
    results = []
    if kind in ("all", "trip", "parked"):
        sql = ("SELECT t.*, (SELECT MAX(n_cameras) FROM segments s WHERE s.trip_id=t.id) cameras "
               "FROM trips t WHERE end >= ? AND start <= ?")
        if kind == "trip":
            sql += " AND COALESCE(place,'') <> 'home'"
        elif kind == "parked":
            sql += " AND place = 'home'"
        for t in rows(sql + " ORDER BY start DESC LIMIT ?", (start, end, limit)):
            if favorites_only and t["id"] not in favs:
                continue
            if q or reason:
                continue                       # trips have no location/reason
            t.update(type="parked" if t["place"] == "home" else "trip", favorite=t["id"] in favs,
                     starred=favs.get(t["id"]), time=t["start"], thumb_segment=thumb_seg(t["first_segment"]))
            results.append(t)
    if kind in ("all", "saved", "sentry"):
        sql = ("SELECT e.*, (SELECT MAX(n_cameras) FROM segments s WHERE s.event_id=e.id) cameras "
               "FROM events e WHERE COALESCE(timestamp,start) BETWEEN ? AND ?")
        args = [start, end]
        if kind != "all":
            sql += " AND kind=?"
            args.append(kind)
        if reason:
            sql += " AND reason=?"
            args.append(reason)
        if q:
            sql += " AND (city LIKE ? OR street LIKE ?)"
            args += [f"%{q}%", f"%{q}%"]
        sql += " ORDER BY timestamp DESC LIMIT ?"
        args.append(limit)
        for e in rows(sql, args):
            if favorites_only and e["id"] not in favs:
                continue
            e.pop("raw", None)
            dur = 0
            try:
                dur = int((datetime.fromisoformat(e["end"]) - datetime.fromisoformat(e["start"])).total_seconds())
            except (TypeError, ValueError):
                pass
            e.update(type=e["kind"], favorite=e["id"] in favs, starred=favs.get(e["id"]),
                     time=e["timestamp"], duration_s=dur)
            results.append(e)
    results.sort(key=lambda r: r["time"] or "", reverse=True)
    return results[:limit]


@app.get("/api/reasons")
def reasons():
    return [r["reason"] for r in rows(
        "SELECT DISTINCT reason FROM events WHERE reason IS NOT NULL ORDER BY reason")]


# ------------------------------------------------------------------ playback
@app.get("/api/trip/{trip_id}")
def trip(trip_id: str):
    t = rows("SELECT * FROM trips WHERE id=?", (trip_id,))
    if not t:
        raise HTTPException(404, "trip not found")
    t = t[0]
    t["favorite"] = trip_id in fav_ids()
    t["segments"] = [seg_out(r) for r in rows(
        "SELECT * FROM segments WHERE trip_id=? ORDER BY start", (trip_id,))]
    t["events"] = rows("SELECT id, kind, timestamp, reason, city FROM events WHERE trip_id=? "
                       "ORDER BY timestamp", (trip_id,))
    return t


@app.get("/api/event/{event_id}")
def event(event_id: str):
    e = rows("SELECT * FROM events WHERE id=?", (event_id,))
    if not e:
        raise HTTPException(404, "event not found")
    e = e[0]
    e["details"] = json.loads(e.pop("raw")) if e.get("raw") else None
    e["favorite"] = event_id in fav_ids()
    e["segments"] = [seg_out(r) for r in rows(
        "SELECT * FROM segments WHERE event_id=? ORDER BY start", (event_id,))]
    return e


def norm_time(s):
    s = s.replace("T", " ").strip()
    return s + ":00" if len(s) == 16 else s


@app.get("/api/range")
def time_range(start: str, end: str):
    """All recent-footage segments overlapping a time window (for 'show me 5:10-5:20')."""
    start, end = norm_time(start), norm_time(end)
    lo = (datetime.strptime(start, "%Y-%m-%d %H:%M:%S") - timedelta(minutes=1)).strftime("%Y-%m-%d %H:%M:%S")
    segs = [seg_out(r) for r in rows(
        "SELECT * FROM segments WHERE kind='recent' AND start > ? AND start <= ? ORDER BY start",
        (lo, end))]
    return {"start": start, "end": end, "segments": segs}


@app.get("/api/gps")
def gps_track(keys: str):
    """Location track (about one point a second) for each segment key, comma separated:
    {key: [{t, lat, lon, hdg, mph, ap, gear}, ...]}. t is seconds into that segment's video.
    Read from the GPS data Tesla puts in the video itself; empty when a clip has none."""
    out = {}
    con = db()
    try:
        for k in keys.split(",")[:120]:
            r = con.execute("SELECT cameras, encrypted FROM segments WHERE key=?", (k,)).fetchone()
            rel = gps.segment_clip(json.loads(r["cameras"])) if r and not r["encrypted"] else None
            out[k] = gps.cached_track(con, ROOT, rel) if rel else []
    finally:
        con.close()
    return out


@app.get("/media/{path:path}")
def media(path: str):
    full = (ROOT / path).resolve()
    if ROOT not in full.parents or not full.is_file():
        raise HTTPException(404)
    return FileResponse(full)                     # supports Range requests (seeking)


# ------------------------------------------------------------------ Pi health
@app.get("/api/metrics")
def metrics(hours: int = 48):
    since = (datetime.now() - timedelta(hours=hours)).strftime("%Y-%m-%dT%H:%M:%S")
    return rows("SELECT time, time_source, boot_id, uptime_s, cpu_temp_c, under_voltage_now, "
                "under_voltage_since_boot, throttled_now, cpu_usage_pct, memory_used_pct, "
                "sd_free_gb, wifi_connected, wifi_dbm, pc_reachable, usb_state, cam_used_pct, "
                "recent_on_pi_gb FROM pi_metrics WHERE time >= ? ORDER BY time", (since,))


DIAG_KINDS = [("JOB FAILED", "bad"), ("JOB RECOVERED", "good"), ("FOOTAGE LOST", "bad"), ("OFFLINE - home network not visible", "info"), ("OFFLINE", "bad"), ("UPLOAD PROBLEM", "bad"), ("PC UNREACHABLE", "bad"),
              ("POWER/HEAT", "bad"), ("LOW SD", "bad"), ("WI-FI SETTINGS WERE MISSING", "bad"), ("HOT", "warn"),
              ("RECOVERY", "warn"), ("HOME FOOTAGE PAUSED", "warn"), ("RECONNECTED", "good"), ("PC REACHABLE", "good"),
              ("COOLED", "good"), ("SD SPACE OK", "good"), ("HOME FOOTAGE RESUMED", "good"), ("POWER-UP", "info"),
              ("CAR USB", "info"), ("SUPPORT BUNDLE", "info")]


def diag_dir():
    return ROOT / "PiMetrics" / "diag"


def is_home_footage_entry(title):
    """Pi log entries about footage recorded while parked at home (hidden unless
    "show_home_footage_warnings": true in settings.json). Lost TRIP footage is always shown."""
    return (title.startswith("FOOTAGE LOST") and "garage/home" in title) or title.startswith("HOME FOOTAGE")


@app.get("/api/diag/events")
def diag_events(limit: int = 300, problems_only: bool = False):
    """Entries from the Pi's diagnostics events log (newest first)."""
    out = []
    for p in sorted(diag_dir().glob("events-*.log"), reverse=True):
        text = p.read_text(encoding="utf-8", errors="replace")
        for chunk in reversed(text.split("\n===== ")):
            chunk = chunk.strip().lstrip("= ").strip()
            if not chunk:
                continue
            head, _, details = chunk.partition("\n")
            when, _, title = head.partition("  ")
            if not SETTINGS.get("show_home_footage_warnings") and is_home_footage_entry(title):
                continue                       # garage/home footage is not wanted - its warnings are noise
            kind = next((k for key, k in DIAG_KINDS if title.startswith(key)), "info")
            if problems_only and kind not in ("bad", "warn"):
                continue
            out.append({"time": when, "title": title, "kind": kind, "details": details.strip()})
            if len(out) >= limit:
                return out
    return out


@app.get("/api/diag/summary")
def diag_summary(hours: int = 24):
    since = (datetime.now() - timedelta(hours=hours)).astimezone()
    recs = []
    for p in sorted(diag_dir().glob("net-*.jsonl"))[-(hours // 24 + 2):]:
        for line in p.read_text(errors="replace").splitlines():
            try:
                r = json.loads(line)
                if datetime.fromisoformat(r["time"]) >= since:
                    recs.append(r)
            except (ValueError, KeyError):
                pass
    events = diag_events(limit=1000)
    recent = [e for e in events if e["time"] and datetime.fromisoformat(e["time"]) >= since]
    count = lambda key: sum(1 for e in recent if e["title"].startswith(key))
    online = sum(1 for r in recs if r.get("online"))
    bundles = sorted(diag_dir().glob("bundle-*.tar.gz"), reverse=True)
    last = recs[-1] if recs else None
    return {
        "readings": len(recs), "online_pct": round(100 * online / len(recs)) if recs else None,
        "drops": count("OFFLINE"), "recoveries": count("RECOVERY"), "lost": count("FOOTAGE LOST"),
        "power_ups": count("POWER-UP"), "upload_problems": count("UPLOAD PROBLEM"),
        "last": last, "bundles": [f"PiMetrics/diag/{b.name}" for b in bundles[:5]],
    }


# ------------------------------------------------------------------ System page
LOST_RE = re.compile(r"deleted (\d+) never-uploaded (.+?) segments \((\d+) MB\)")


@app.get("/api/system")
def system():
    """One screen of plain facts: last upload, the Pi, PC storage, anything that needs attention, recent activity."""
    now = datetime.now()
    events = diag_events(limit=4000)
    when = lambda e: datetime.fromisoformat(e["time"]).replace(tzinfo=None) if e.get("time") else None

    # footage the Pi deleted before it could upload it (last 14 days)
    lost = {"mb": 0, "segments": 0, "days": set(), "last": None}
    for e in events:
        t = when(e)
        m = LOST_RE.search(e["title"]) if e["title"].startswith("FOOTAGE LOST") else None
        if not m or not t or (now - t).days >= 14:
            continue
        lost["mb"] += int(m.group(3))
        lost["segments"] += int(m.group(1))
        lost["days"].add(t.strftime("%Y-%m-%d"))
        lost["last"] = max(lost["last"] or e["time"], e["time"])
    lost["days"] = sorted(lost["days"])
    problems = [e for e in events if e["title"].startswith("UPLOAD PROBLEM") and when(e) and (now - when(e)).total_seconds() < 6 * 3600]
    # a Pi job that keeps crashing (the Pi logs "JOB FAILED" hourly while it does, "JOB RECOVERED" once it runs again)
    job_failed, settled = None, set()
    for e in events:                                        # newest first
        m = re.match(r"JOB (FAILED|RECOVERED): ([^\s:]+)", e["title"])
        if not m or not when(e) or m.group(2) in settled:
            continue
        if m.group(1) == "RECOVERED" or (now - when(e)).days >= 14:
            settled.add(m.group(2))
        elif job_failed and job_failed["job"] == m.group(2):
            job_failed["since"] = e["time"]                 # an earlier entry of the same run of failures
        elif not job_failed:
            job_failed = {"job": m.group(2), "since": e["time"], "last": e["time"], "details": e["details"][-600:]}

    # storage: how fast footage arrives, and how long the free space lasts at that rate
    disk = shutil.disk_usage(ROOT)
    con = db()
    try:
        footage = con.execute("SELECT COALESCE(SUM(size),0) FROM clips").fetchone()[0]
        since = (now - timedelta(days=10)).strftime("%Y-%m-%d")
        recent_b = con.execute("SELECT COALESCE(SUM(size),0) FROM clips WHERE car_time >= ?", (since,)).fetchone()[0]
        first = con.execute("SELECT MIN(car_time) FROM clips").fetchone()[0]
        last_up = con.execute("SELECT time, kind, files, mb, duration_s FROM syncs WHERE success=1 AND files>0 "
                              "ORDER BY time DESC LIMIT 1").fetchone()
        ups = [dict(r) for r in con.execute("SELECT time, kind, files, mb FROM syncs WHERE success=1 AND files>0 "
                                            "ORDER BY time DESC LIMIT 40")]
        pi = con.execute("SELECT time, cpu_temp_c, wifi_dbm, under_voltage_now, throttled_now, sd_free_gb "
                         "FROM pi_metrics ORDER BY time DESC LIMIT 1").fetchone()
    finally:
        con.close()
    span = 10
    if first:
        try:
            span = max(1, min(10, (now - datetime.fromisoformat(first.replace(" ", "T"))).days + 1))
        except ValueError:
            pass
    per_day = recent_b / span

    # recent activity, newest first; uploads within the same hour are one line
    lately = []
    for u in ups:
        t = datetime.fromisoformat(u["time"]).replace(tzinfo=None)
        prev = lately[-1] if lately else None
        if prev and prev["kind"] == "upload" and prev["what"] == u["kind"] and (prev["_t"] - t).total_seconds() < 3600:
            prev["files"] += u["files"]
            prev["mb"] += u["mb"] or 0
            prev["_t"] = t
        else:
            lately.append({"kind": "upload", "what": u["kind"], "time": u["time"], "files": u["files"], "mb": u["mb"] or 0, "_t": t})
    for e in events[:400]:
        t = when(e)
        if not t:
            continue
        if e["title"].startswith("POWER-UP"):
            if lately and lately[-1]["kind"] == "wake" and abs((lately[-1]["_t"] - t).total_seconds()) < 1800:
                continue
            lately.append({"kind": "wake", "time": e["time"], "_t": t})
        elif e["title"].startswith("FOOTAGE LOST"):
            m = LOST_RE.search(e["title"])
            if lately and lately[-1]["kind"] == "lost" and abs((lately[-1]["_t"] - t).total_seconds()) < 3600:
                lately[-1]["mb"] += int(m.group(3)) if m else 0
                continue
            lately.append({"kind": "lost", "time": e["time"], "mb": int(m.group(3)) if m else 0, "_t": t})
        elif e["title"].startswith("UPLOAD PROBLEM"):
            lately.append({"kind": "upload_problem", "time": e["time"], "_t": t})
    lately.sort(key=lambda x: x["_t"], reverse=True)
    merged = []
    for x in lately:                                        # merging again: the two sources were appended separately
        p = merged[-1] if merged else None
        if p and p["kind"] == x["kind"] and p.get("what") == x.get("what") and (p["_t"] - x["_t"]).total_seconds() < 3600 and x["kind"] != "upload_problem":
            for k in ("files", "mb"):
                if k in x:
                    p[k] = p.get(k, 0) + x[k]
            p["_t"] = x["_t"]
        else:
            merged.append(x)
    for x in merged:
        x.pop("_t", None)
    return {
        "last_upload": dict(last_up) if last_up else None,
        "pi": dict(pi) if pi else None,
        "storage": {"footage_gb": round(footage / 1e9, 1), "free_gb": round(disk.free / 1e9, 1),
                    "total_gb": round(disk.total / 1e9, 1), "gb_per_day": round(per_day / 1e9, 1),
                    "days_left": round(disk.free / per_day) if per_day > 1e8 else None},
        "lost": lost, "upload_problems": len(problems), "job_failed": job_failed, "lately": merged[:5],
        "place_names": bool(SETTINGS.get("place_names")), "home_known": feed_data()["home"] is not None,
        "retention_days": int(SETTINGS.get("recent_retention_days", 30)),
    }


class SettingsIn(BaseModel):
    place_names: bool


@app.post("/api/settings")
def save_settings(v: SettingsIn):
    """Turn place names on or off (kept in settings.json). When on, the start and end of each drive -
    never your home - are looked up once with OpenStreetMap's public service."""
    p = HERE / "settings.json"
    try:
        cur = json.loads(p.read_text()) if p.exists() else {}
    except ValueError:
        cur = {}
    cur["place_names"] = bool(v.place_names)
    p.write_text(json.dumps(cur, indent=2))
    SETTINGS["place_names"] = bool(v.place_names)
    if v.place_names:
        def fill():
            con = db()
            try:
                drives.lookup_places(con, drives.get(con, ROOT, SETTINGS)["missing_places"], budget_s=600)
            finally:
                con.close()
        threading.Thread(target=fill, daemon=True).start()
    return {"ok": True, "place_names": SETTINGS["place_names"]}


@app.get("/api/config")
def config():
    """Settings the web page needs (the map key is used by the browser to load CARTO map tiles)."""
    return {"carto_api_key": SETTINGS.get("carto_api_key") or ""}


@app.get("/api/syncs")
def syncs(limit: int = 100):
    return rows("SELECT time, kind, files, mb, duration_s, mb_per_s, success FROM syncs "
                "ORDER BY time DESC LIMIT ?", (limit,))


# ------------------------------------------------------------------ live upload status
FOOTAGE_DIRS = ("RecentClips", "SavedClips", "SentryClips", "EncryptedClips")
_live_cache = {"t": 0.0, "v": None}
_live_lock = threading.Lock()


def _born(st):
    """When the file appeared on this PC (creation time on Windows)."""
    return getattr(st, "st_birthtime", None) or st.st_ctime


def _scan_arrivals(window_s):
    """Footage that arrived on the PC in the last window_s seconds, and uploads in progress (.part files)."""
    now = time.time()
    parts, arrived = [], []

    def walk(d, rel, depth):
        try:
            entries = list(os.scandir(d))
        except OSError:
            return
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    # event folders untouched for longer than the window cannot hold anything new
                    if depth < 3 and e.stat().st_mtime >= now - window_s:
                        walk(e.path, f"{rel}/{e.name}", depth + 1)
                    continue
                st = e.stat()
                if e.name.startswith(".") and e.name.endswith(".part"):
                    # Windows only updates a file's size in the folder listing when the file is closed,
                    # so ask the file itself how big it is right now
                    try:
                        st = os.stat(e.path)
                    except OSError:
                        pass
                    parts.append({"name": e.name[1:-5], "folder": rel, "size": st.st_size,
                                  "age_s": round(now - st.st_mtime, 1)})
                elif not e.name.startswith("."):
                    born = _born(st)
                    if now - born <= window_s:
                        arrived.append((born, f"{rel}/{e.name}", st.st_size))
            except OSError:
                pass

    for top in FOOTAGE_DIRS:
        if (ROOT / top).is_dir():
            walk(str(ROOT / top), top, 1)
    return parts, arrived


@app.get("/api/live")
def live():
    """What the Pi says it is doing (PiMetrics/live/status.json) + what is arriving on this PC right now."""
    with _live_lock:
        if time.time() - _live_cache["t"] < 2 and _live_cache["v"]:
            return _live_cache["v"]
        now = time.time()
        status = None
        p = ROOT / "PiMetrics" / "live" / "status.json"
        try:
            status = json.loads(p.read_text())
            status["age_s"] = round(now - p.stat().st_mtime)
        except (OSError, ValueError):
            status = None
        parts, arrived = _scan_arrivals(3600)
        arrived.sort()
        per_min = {}
        for born, _, size in arrived:
            m = int(born // 60) * 60
            f, b = per_min.get(m, (0, 0))
            per_min[m] = (f + 1, b + size)
        last15 = [a for a in arrived if now - a[0] <= 900]
        # what has landed since the current upload run began: the Pi only counts a batch once it is verified,
        # so this is the live figure the progress bar follows (run start = status file time - time the run has been going)
        run = None
        if status and status.get("state") == "uploading":
            run_start = p.stat().st_mtime - (status.get("elapsed_s") or 0) - 5
            since = [a for a in arrived if a[0] >= run_start]
            run = {"files": len(since), "bytes": sum(a[2] for a in since)}
        v = {"server_time": now, "status": status, "run": run,
             "receiving": sorted(parts, key=lambda x: x["age_s"]),
             "per_min": [{"t": m, "files": f, "bytes": b} for m, (f, b) in sorted(per_min.items())],
             "last15": {"files": len(last15), "bytes": sum(a[2] for a in last15)},
             "latest": [{"t": a[0], "path": a[1], "size": a[2]} for a in arrived[-30:][::-1]]}
        _live_cache.update(t=now, v=v)
        return v


@app.get("/api/storage")
def storage():
    by_day = rows("SELECT substr(car_time,1,10) d, kind, SUM(size) b FROM clips "
                  "WHERE car_time IS NOT NULL GROUP BY d, kind ORDER BY d")
    removed = rows("SELECT substr(removed_at,1,10) d, COUNT(*) n, SUM(size) b FROM removed "
                   "GROUP BY d ORDER BY d DESC LIMIT 30")
    return {"by_day": by_day, "removed": removed, "keep_days": int(SETTINGS.get("recent_retention_days", 30))}


# ------------------------------------------------------------------ favorites
class Fav(BaseModel):
    item_type: str          # "trip" or "event"
    item_id: str
    note: str = ""


@app.post("/api/favorites")
def add_favorite(f: Fav):
    """Hard-link the footage into Favorites/<id>/ so retention never deletes it (no extra space)."""
    if f.item_type == "trip":
        clips = rows("SELECT c.* FROM clips c JOIN segments s ON c.segment_key=s.key "
                     "WHERE s.trip_id=?", (f.item_id,))
    elif f.item_type == "event":
        clips = rows("SELECT * FROM clips WHERE event_id=?", (f.item_id,))
    else:
        raise HTTPException(400, "item_type must be trip or event")
    if not clips:
        raise HTTPException(404, "nothing to keep")
    fid = f"{f.item_type}-{f.item_id}"
    d = ROOT / "Favorites" / fid
    d.mkdir(parents=True, exist_ok=True)
    info = {"item_type": f.item_type, "item_id": f.item_id, "note": f.note,
            "created": datetime.now().isoformat(timespec="seconds"), "files": {}}
    for c in clips:
        if c["from_favorites"]:
            continue
        src = ROOT / c["path"]
        fname = c["path"].replace("/", "__")
        dst = d / fname
        if not dst.exists():
            try:
                os.link(src, dst)                 # NTFS hard link: instant, no extra space
            except OSError:
                shutil.copy2(src, dst)            # different drive: real copy
        ev_folder = Path(c["path"]).parent.name if c["event_id"] else None
        info["files"][fname] = {"rel": c["path"], "kind": c["kind"], "event_folder": ev_folder,
                                "encrypted": bool(c["encrypted"])}
    (d / "favorite.json").write_text(json.dumps(info, indent=1))
    con = db()
    with con:
        con.execute("INSERT OR REPLACE INTO favorites VALUES (?,?,?,?,?)",
                    (f.item_id, f.item_type, f.item_id, info["created"], f.note))
    con.close()
    return {"ok": True, "files": len(info["files"])}


@app.delete("/api/favorites/{item_type}/{item_id}")
def remove_favorite(item_type: str, item_id: str):
    d = ROOT / "Favorites" / f"{item_type}-{item_id}"
    if d.is_dir() and ROOT in d.resolve().parents:
        shutil.rmtree(d)                          # removes only the links; originals are untouched
    con = db()
    with con:
        con.execute("DELETE FROM favorites WHERE id=?", (item_id,))
    con.close()
    threading.Thread(target=reindex, daemon=True).start()
    return {"ok": True}


@app.get("/api/favorites")
def list_favorites():
    return rows("SELECT * FROM favorites ORDER BY created DESC")


@app.post("/api/reindex")
def api_reindex():
    threading.Thread(target=reindex, daemon=True).start()
    return {"ok": True}


app.mount("/", StaticFiles(directory=HERE / "static", html=True), name="static")

if __name__ == "__main__":
    print(f"TeslaCam dashboard: http://{'localhost' if SETTINGS['host'] in ('127.0.0.1', 'localhost') else SETTINGS['host']}:{SETTINGS['port']}")
    print(f"Footage folder:     {ROOT}")
    print("Press Ctrl+C to stop.")
    # Don't wait for the browser's open video connections when stopping - give them 2 seconds, then quit
    uvicorn.run(app, host=SETTINGS["host"], port=SETTINGS["port"], log_level="warning",
                timeout_graceful_shutdown=2)
    os._exit(0)                                   # also ends the background indexer immediately
