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


# ------------------------------------------------------------------ plate analysis
# The GPU machine writes each run into its own folder under <share>\analysis (bench, bench-smoke, enhance ...).  This server
# only reads those; the one thing it writes is the labels you type in the browser (labels.sqlite next to the runs, plus a
# truth.csv inside the run folder so the analysis scripts on the GPU machine can score against it).
_cfg = Path(SETTINGS.get("analysis_root") or (ROOT / "analysis")).resolve()
ANALYSIS_ROOT: Path = _cfg.parent if (_cfg / "bench.sqlite").exists() else _cfg
_PLATE_FORMATS = [r"^\d{2}[A-Z]\d{3}$", r"^\d{3}[A-Z]\d{2}$", r"^\d{3}[A-Z]{3}$", r"^[A-Z]{3}\d{3}$", r"^\d{2}[A-Z]{2}\d{3}$",
                  r"^\d[A-Z]{3}\d{3}$", r"^[A-Z]{3}\d{4}$", r"^\d{3}[A-Z]{4}$", r"^[A-Z]\d{5}$", r"^[A-Z]\d{2}[A-Z]{2}\d$"]
_LABELS_LOCK = threading.Lock()


def _format_ok(t):
    return bool(t) and any(re.match(p, t) for p in _PLATE_FORMATS)


def _run_dir(run: str) -> Path:
    """a run folder by name; names are plain folder names, nothing else is accepted"""
    if not run or not re.match(r"^[A-Za-z0-9_.-]{1,64}$", run):
        raise HTTPException(400, "bad run name")
    d = (ANALYSIS_ROOT / run).resolve()
    if ANALYSIS_ROOT not in d.parents or not d.is_dir():
        raise HTTPException(404, "no such run")
    return d


def _adb(run_dir: Path, name="bench.sqlite"):
    """read-only connection; the GPU machine is the only writer"""
    p = run_dir / name
    if not p.is_file():
        return None
    con = sqlite3.connect(f"file:{p.as_posix()}?mode=ro", uri=True, timeout=2)
    con.row_factory = sqlite3.Row
    return con


def _arows(con, sql, args=()):
    try:
        return [dict(r) for r in con.execute(sql, args).fetchall()]
    except sqlite3.OperationalError:
        return []


def _one(con, sql, args=(), default=None):
    r = _arows(con, sql, args)
    return r[0] if r else default


def _progress(run_dir: Path):
    pj = run_dir / "progress.json"
    if not pj.is_file():
        return None
    try:
        prog = json.loads(pj.read_text())
        prog["age_s"] = round(time.time() - pj.stat().st_mtime)
        return prog
    except (OSError, ValueError):
        return None


# ---- labels (the only thing this server writes)
def _ldb():
    p = ANALYSIS_ROOT / "labels.sqlite"
    ANALYSIS_ROOT.mkdir(parents=True, exist_ok=True)
    con = sqlite3.connect(p.as_posix(), timeout=5)
    con.execute("CREATE TABLE IF NOT EXISTS labels(run TEXT, track_id INTEGER, truth TEXT, note TEXT, updated TEXT, PRIMARY KEY(run, track_id))")
    return con


def _labels(run: str) -> dict:
    """{track_id: {truth, note, updated}} for a run; falls back to a truth.csv / labels.csv written by hand"""
    out = {}
    try:
        con = _ldb()
        for r in con.execute("SELECT track_id, truth, note, updated FROM labels WHERE run=?", (run,)):
            out[r[0]] = {"truth": r[1], "note": r[2] or "", "updated": r[3]}
        con.close()
    except sqlite3.Error:
        pass
    if not out:
        try:
            import csv as _csv
            p = ANALYSIS_ROOT / run / "labels.csv"
            if p.is_file():
                with p.open(newline="", encoding="utf-8") as f:
                    for r in _csv.DictReader(f):
                        t = re.sub(r"[^A-Z0-9?]", "", (r.get("truth") or "").upper())
                        if t:
                            out[int(r["track_id"])] = {"truth": t, "note": "from labels.csv", "updated": None}
        except (OSError, ValueError):
            pass
    return out


def _write_truth_csv(run: str):
    """truth.csv inside the run folder, for the scripts on the GPU machine"""
    try:
        import csv as _csv
        d = ANALYSIS_ROOT / run
        if not d.is_dir():
            return
        rows = _labels(run)
        with (d / "truth.csv").open("w", newline="", encoding="utf-8") as f:
            w = _csv.writer(f)
            w.writerow(["track_id", "truth", "note", "updated"])
            for tid in sorted(rows):
                w.writerow([tid, rows[tid]["truth"], rows[tid]["note"], rows[tid]["updated"]])
    except OSError:
        pass


class LabelIn(BaseModel):
    run: str
    track_id: int
    truth: str = ""
    note: str = ""


@app.post("/api/plates/label")
def plates_label(v: LabelIn):
    _run_dir(v.run)
    truth = re.sub(r"[^A-Z0-9?]", "", v.truth.upper())[:10]
    with _LABELS_LOCK:
        con = _ldb()
        if truth:
            con.execute("INSERT OR REPLACE INTO labels VALUES (?,?,?,?,?)", (v.run, v.track_id, truth, v.note[:200], datetime.now().strftime("%Y-%m-%d %H:%M:%S")))
        else:
            con.execute("DELETE FROM labels WHERE run=? AND track_id=?", (v.run, v.track_id))
        con.commit(); con.close()
        _write_truth_csv(v.run)
    return {"ok": True, "truth": truth}


@app.get("/api/plates/labels.csv")
def plates_labels_csv(run: str):
    _run_dir(run)
    rows = _labels(run)
    body = "track_id,truth,note,updated\n" + "".join(f"{tid},{r['truth']},{(r['note'] or '').replace(',', ' ')},{r['updated'] or ''}\n" for tid, r in sorted(rows.items()))
    from fastapi.responses import Response
    return Response(body, media_type="text/csv", headers={"Content-Disposition": f"attachment; filename=truth-{run}.csv"})


# ---- runs
@app.get("/api/plates/runs")
def plates_runs():
    out = []
    if not ANALYSIS_ROOT.is_dir():
        return {"root": str(ANALYSIS_ROOT), "runs": []}
    for d in sorted(ANALYSIS_ROOT.iterdir()):
        if not d.is_dir():
            continue
        kind = "bench" if (d / "bench.sqlite").is_file() else "enhance" if (d / "enhance.sqlite").is_file() else None
        if not kind:
            continue
        r = {"name": d.name, "kind": kind, "live": False}
        prog = _progress(d)
        if prog:
            r["started"] = prog.get("started"); r["elapsed_s"] = prog.get("elapsed_s"); r["age_s"] = prog.get("age_s")
            r["current"] = prog.get("current"); r["stages"] = prog.get("stages")
            r["live"] = prog.get("age_s", 1e9) < 180 and not all(s.get("done", 0) >= s.get("total", 0) for s in (prog.get("stages") or {}).values())
            r["pct"] = _overall_pct(prog)
        con = _adb(d, "bench.sqlite" if kind == "bench" else "enhance.sqlite")
        if con is not None:
            try:
                if kind == "bench":
                    r["run"] = _one(con, "SELECT name, started, finished, status, machine, gpu, driver, versions, code_hash, notes FROM runs ORDER BY id DESC LIMIT 1")
                    c = _one(con, "SELECT COUNT(*) n, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done FROM clips", default={})
                    t = _one(con, "SELECT COUNT(*) n, SUM(CASE WHEN best_crop IS NOT NULL THEN 1 ELSE 0 END) with_plate FROM tracks", default={})
                    r.update(clips=c.get("n", 0), clips_done=c.get("done", 0) or 0, tracks=t.get("n", 0), with_plate=t.get("with_plate", 0) or 0)
                    r["v2"] = bool(_arows(con, "SELECT 1 FROM frames LIMIT 1"))
                else:
                    t = _one(con, "SELECT COUNT(*) n, SUM(matched) matched FROM tracks", default={})
                    r.update(tracks=t.get("n", 0), matched=t.get("matched", 0) or 0)
            finally:
                con.close()
        r["labelled"] = len(_labels(d.name)) if kind == "bench" else 0
        out.append(r)
    out.sort(key=lambda r: (0 if r["live"] else 1, -(os.path.getmtime(ANALYSIS_ROOT / r["name"]))))
    return {"root": str(ANALYSIS_ROOT), "runs": out}


def _overall_pct(prog):
    st = prog.get("stages") or {}
    if not st:
        return 0
    weights = {"clips": 50, "subset": 10, "vlm": 38, "report": 2, "enhance": 100}
    tot = sum(weights.get(k, 10) for k in st)
    return round(sum(weights.get(k, 10) * min(1, (v.get("done", 0) / max(1, v.get("total", 1)))) for k, v in st.items()) / max(1, tot) * 100, 1)


def _latest_run():
    runs = plates_runs()["runs"]
    bench = [r for r in runs if r["kind"] == "bench" and not r["name"].endswith("smoke")] or [r for r in runs if r["kind"] == "bench"]
    return bench[0]["name"] if bench else None


# ---- one run: status
@app.get("/api/plates/status")
def plates_status(run: str = ""):
    run = run or _latest_run()
    out = {"available": False, "root": str(ANALYSIS_ROOT), "run": run}
    if not run:
        return out
    d = _run_dir(run)
    prog = _progress(d)
    if prog:
        out["progress"] = prog; out["available"] = True
    con = _adb(d)
    if con is None:
        return out
    try:
        out["available"] = True
        out["meta"] = _one(con, "SELECT name, started, finished, status, machine, gpu, driver, versions, args, code_hash, notes FROM runs ORDER BY id DESC LIMIT 1")
        if out["meta"]:
            for k in ("versions", "args"):
                try: out["meta"][k] = json.loads(out["meta"][k] or "{}")
                except ValueError: pass
        c = _arows(con, "SELECT status, COUNT(*) n, SUM(frames) frames FROM clips GROUP BY status")
        out["clips"] = {r["status"]: r["n"] for r in c}
        out["frames"] = sum(r["frames"] or 0 for r in c)
        out["by_camera"] = _arows(con, """SELECT camera, bucket, COUNT(*) clips, SUM(CASE WHEN status='done' THEN 1 ELSE 0 END) done,
                                          SUM(n_vehicles_m) vehicles FROM clips GROUP BY camera, bucket ORDER BY camera, bucket""")
        out["tracks"] = _one(con, "SELECT COUNT(*) n, SUM(CASE WHEN best_crop IS NOT NULL THEN 1 ELSE 0 END) with_plate FROM tracks", default={})
        pb = _one(con, "SELECT COUNT(*) n FROM plate_boxes")
        out["plate_boxes"] = pb["n"] if pb and pb["n"] else (_one(con, "SELECT COUNT(DISTINCT track_id||'/'||frame_sec) n FROM plates WHERE detector='alpr_v9t' AND det_conf>=0.5", default={"n": 0})["n"])
        out["reads"] = _arows(con, """SELECT reader, COUNT(*) n FROM plates WHERE detector='alpr_v9t' AND det_conf>=0.5 AND prep='pad_up'
                                       AND conf>=0.7 AND LENGTH(text)>=5 GROUP BY reader""")
        out["vlm"] = _arows(con, """SELECT model, COUNT(*) asked, SUM(CASE WHEN text NOT IN ('?','ERR','') THEN 1 ELSE 0 END) answered,
                                     ROUND(AVG(seconds),1) avg_s, ROUND(AVG(tok_s),1) tok_s FROM vlm GROUP BY model""")
        out["timings"] = _arows(con, "SELECT stage, ROUND(SUM(ms)/1000,1) s, SUM(n) n, ROUND(SUM(ms)/MAX(1,SUM(n)),1) ms_each FROM timings GROUP BY stage ORDER BY s DESC")
        out["totals"] = _one(con, """SELECT SUM(t_decode) decode_s, SUM(t_detect) detect_s, SUM(t_plates) plates_s, SUM(n_vehicles_m) vehicles,
                                      SUM(size_bytes) bytes, SUM(duration_s) footage_s, AVG(moving_share) moving_share FROM clips WHERE status='done'""", default={})
        ex = _one(con, "SELECT value FROM experiments WHERE name='sample' AND key='summary'")
        if ex:
            try: out["sample"] = json.loads(ex["value"])
            except ValueError: pass
        out["errors"] = _arows(con, "SELECT name, err FROM clips WHERE status='error' ORDER BY id DESC LIMIT 5")
        out["labelled"] = len(_labels(run))
    finally:
        con.close()
    return out


def _vote(rows):
    """the read most frames agreed on, weighted by confidence"""
    score: dict = {}
    for r in rows:
        if r["text"] and len(r["text"]) >= 5:
            score[r["text"]] = score.get(r["text"], 0) + (r["conf"] or 0)
    if not score:
        return None
    best = max(score, key=score.get)
    return {"text": best, "score": round(score[best], 2), "format_ok": _format_ok(best)}


# ---- vehicles (the grid)
@app.get("/api/plates/tracks")
def plates_tracks(run: str = "", camera: str = "", bucket: str = "", min_pw: int = 0, q: str = "", labelled: str = "",
                  color: str = "", sort: str = "newest", limit: int = 48, offset: int = 0):
    run = run or _latest_run()
    if not run:
        return {"items": [], "total": 0, "run": None}
    d = _run_dir(run); con = _adb(d)
    if con is None:
        return {"items": [], "total": 0, "run": run}
    try:
        labels = _labels(run)
        where = ["t.best_crop IS NOT NULL"]; args: list = []
        if camera: where.append("c.camera=?"); args.append(camera)
        if bucket: where.append("c.bucket=?"); args.append(bucket)
        if min_pw: where.append("t.best_plate_w>=?"); args.append(min_pw)
        if color: where.append("t.color=?"); args.append(color)
        q = re.sub(r"[^A-Z0-9]", "", q.upper())
        if q:
            where.append("""(t.id IN (SELECT track_id FROM plates WHERE text LIKE ?) OR t.id IN (SELECT track_id FROM vlm WHERE text LIKE ?))""")
            args += [f"%{q}%", f"%{q}%"]
        if labelled == "yes":
            ids = list(labels) or [-1]; where.append(f"t.id IN ({','.join('?' * len(ids))})"); args += ids
        elif labelled == "no" and labels:
            ids = list(labels); where.append(f"t.id NOT IN ({','.join('?' * len(ids))})"); args += ids
        order = {"newest": "t.id DESC", "oldest": "t.id ASC", "biggest": "t.best_plate_w DESC, t.id DESC", "smallest": "t.best_plate_w ASC, t.id DESC",
                 "sharpest": "t.sharp_best DESC, t.id DESC", "clip": "c.date DESC, c.hour DESC, t.id DESC"}.get(sort, "t.id DESC")
        w = " AND ".join(where)
        total = _one(con, f"SELECT COUNT(*) n FROM tracks t JOIN clips c ON c.id=t.clip_id WHERE {w}", args, default={"n": 0})["n"]
        tracks = _arows(con, f"""SELECT t.id, t.best_crop, t.best_context, t.best_plate_w, t.best_det_conf, t.n_frames, t.max_w, t.first_sec, t.last_sec,
                                        t.cls, t.color, t.sharp_best, t.n_plate_frames, t.crops, t.entry_side, t.exit_side, t.mean_dw,
                                        c.name clip, c.camera, c.bucket, c.date, c.hour
                                 FROM tracks t JOIN clips c ON c.id=t.clip_id WHERE {w} ORDER BY {order} LIMIT ? OFFSET ?""", args + [limit, offset])
        for t in tracks:
            reads = _arows(con, "SELECT reader, text, conf FROM plates WHERE track_id=? AND detector='alpr_v9t' AND prep='pad_up' AND det_conf>=0.5", (t["id"],))
            by: dict = {}
            for r in reads:
                by.setdefault(r["reader"], []).append(r)
            t["fast"] = {k: _vote(v) for k, v in by.items()}
            t["vlm"] = {r["model"]: r["text"] for r in _arows(con, "SELECT model, text FROM vlm WHERE track_id=?", (t["id"],))}
            t["frames_read"] = len({r["conf"] for r in reads if r["conf"] and r["conf"] >= 0.7})
            try: t["crops"] = json.loads(t["crops"]) if t["crops"] else []
            except ValueError: t["crops"] = []
            lab = labels.get(t["id"])
            t["truth"] = lab["truth"] if lab else None
        return {"items": tracks, "total": total, "run": run, "labelled": len(labels)}
    finally:
        con.close()


# ---- one vehicle in full
@app.get("/api/plates/track/{track_id}")
def plates_track(track_id: int, run: str = ""):
    run = run or _latest_run()
    d = _run_dir(run); con = _adb(d)
    if con is None:
        raise HTTPException(404)
    try:
        t = _one(con, """SELECT t.*, c.name clip, c.camera, c.bucket, c.date, c.hour, c.w clip_w, c.h clip_h, c.fps clip_fps, c.path clip_path
                         FROM tracks t JOIN clips c ON c.id=t.clip_id WHERE t.id=?""", (track_id,))
        if not t:
            raise HTTPException(404)
        t.pop("embedding", None)
        try: t["crops"] = json.loads(t["crops"]) if t.get("crops") else []
        except ValueError: t["crops"] = []
        t["boxes"] = _arows(con, """SELECT id, sec, detector, det_conf, pw, ph, aspect, sharpness, brightness, contrast, skew_deg, crop_file, kept
                                    FROM plate_boxes WHERE track_id=? ORDER BY sec""", (track_id,))
        reads = _arows(con, "SELECT frame_sec sec, detector, det_conf, pw, prep, reader, text, conf, char_confs, ms, box_id FROM plates WHERE track_id=? ORDER BY frame_sec, reader, prep", (track_id,))
        for r in reads:
            try: r["char_confs"] = json.loads(r["char_confs"]) if r.get("char_confs") else None
            except ValueError: r["char_confs"] = None
        t["reads"] = reads
        by: dict = {}
        for r in reads:
            if r["detector"] == "alpr_v9t" and r["prep"] == "pad_up" and (r["det_conf"] or 0) >= 0.5:
                by.setdefault(r["reader"], []).append(r)
        t["fast"] = {k: _vote(v) for k, v in by.items()}
        t["vlm"] = _arows(con, "SELECT model, text, raw, seconds, prompt_ver, prompt_tokens, eval_tokens, tok_s, think_off, image_w, crop_file FROM vlm WHERE track_id=? ORDER BY model", (track_id,))
        t["path"] = _arows(con, "SELECT f.sec, d.x1, d.y1, d.x2, d.y2, d.bw, d.conf, d.cls, d.dw FROM detections d JOIN frames f ON f.id=d.frame_id WHERE d.track_id=? ORDER BY f.sec", (track_id,))
        lab = _labels(run).get(track_id)
        t["truth"] = lab["truth"] if lab else None; t["note"] = lab["note"] if lab else ""
        # neighbours for the Previous / Next buttons
        nxt = _one(con, "SELECT id FROM tracks WHERE id>? AND best_crop IS NOT NULL ORDER BY id LIMIT 1", (track_id,))
        prv = _one(con, "SELECT id FROM tracks WHERE id<? AND best_crop IS NOT NULL ORDER BY id DESC LIMIT 1", (track_id,))
        t["next_id"] = nxt["id"] if nxt else None; t["prev_id"] = prv["id"] if prv else None
        t["run"] = run
        return t
    finally:
        con.close()


# ---- charts: distributions and time series
@app.get("/api/plates/charts")
def plates_charts(run: str = ""):
    run = run or _latest_run()
    d = _run_dir(run); con = _adb(d)
    out = {"run": run}
    if con is None:
        return out
    try:
        out["plate_width"] = _arows(con, """SELECT CASE WHEN best_plate_w<40 THEN '<40' WHEN best_plate_w<60 THEN '40-60' WHEN best_plate_w<80 THEN '60-80'
                                             WHEN best_plate_w<110 THEN '80-110' WHEN best_plate_w<160 THEN '110-160' ELSE '160+' END bucket, COUNT(*) n
                                             FROM tracks WHERE best_crop IS NOT NULL GROUP BY bucket""")
        out["per_camera"] = _arows(con, """SELECT c.camera, c.bucket, COUNT(*) tracks, SUM(CASE WHEN t.best_crop IS NOT NULL THEN 1 ELSE 0 END) with_plate
                                           FROM tracks t JOIN clips c ON c.id=t.clip_id GROUP BY c.camera, c.bucket""")
        out["colors"] = _arows(con, "SELECT color, COUNT(*) n FROM tracks WHERE best_crop IS NOT NULL AND color IS NOT NULL GROUP BY color ORDER BY n DESC")
        out["classes"] = _arows(con, "SELECT cls, COUNT(*) n FROM tracks WHERE cls IS NOT NULL GROUP BY cls ORDER BY n DESC")
        out["conf_hist"] = _arows(con, """SELECT reader, CAST(conf*10 AS INT)/10.0 bin, COUNT(*) n FROM plates
                                          WHERE detector='alpr_v9t' AND prep='pad_up' AND det_conf>=0.5 AND text<>'' GROUP BY reader, bin ORDER BY reader, bin""")
        out["throughput"] = _arows(con, """SELECT SUBSTR(processed,1,15)||'0' slot, COUNT(*) clips, SUM(frames) frames FROM clips
                                           WHERE processed IS NOT NULL GROUP BY slot ORDER BY slot""")
        out["clip_time"] = _arows(con, """SELECT camera, ROUND(AVG(t_decode),2) decode, ROUND(AVG(t_detect),2) detect, ROUND(AVG(t_plates),2) plates, COUNT(*) n
                                          FROM clips WHERE status='done' GROUP BY camera""")
        out["sharp_vs_width"] = _arows(con, """SELECT best_plate_w pw, sharp_best sharp, color FROM tracks WHERE best_crop IS NOT NULL AND sharp_best IS NOT NULL
                                               ORDER BY RANDOM() LIMIT 600""")
        out["motion"] = _arows(con, """SELECT CASE WHEN moving_share IS NULL THEN 'unknown' WHEN moving_share<0.2 THEN 'parked' WHEN moving_share<0.8 THEN 'mixed' ELSE 'driving' END state,
                                       COUNT(*) clips, SUM(n_tracks) tracks FROM clips WHERE status='done' GROUP BY state""")
        # the experiments stored as json
        exps: dict = {}
        for r in _arows(con, "SELECT name, key, value FROM experiments WHERE name IN ('sampling','detector')"):
            try: v = json.loads(r["value"])
            except ValueError: continue
            mode = r["key"].split("|")[-1]
            e = exps.setdefault(r["name"], {}).setdefault(mode, {"frames": 0, "seconds": 0, "vehicles": 0, "reads": 0, "clips": 0, "by_width": {}})
            e["frames"] += v.get("frames", 0); e["seconds"] += v.get("seconds", 0); e["vehicles"] += v.get("vehicles", 0); e["reads"] += v.get("distinct_confident_reads", 0); e["clips"] += 1
            for k, n in (v.get("by_width") or {}).items():
                e["by_width"][k] = e["by_width"].get(k, 0) + n
        out["experiments"] = exps
    finally:
        con.close()
    return out


@app.get("/api/plates/telemetry")
def plates_telemetry(run: str = "", points: int = 240):
    run = run or _latest_run()
    d = _run_dir(run)
    p = d / "telemetry.csv"
    if not p.is_file():
        return {"run": run, "rows": []}
    import csv as _csv
    try:
        with p.open(newline="", encoding="utf-8") as f:
            rows = list(_csv.DictReader(f))
    except (OSError, ValueError):
        return {"run": run, "rows": []}
    keep = ["time", "cpu_pct", "ram_used_gb", "gpu_util", "vram_used_gb", "gpu_temp_c", "gpu_power_w", "cpu_temp_c", "disk_read_mbs", "disk_write_mbs", "net_rx_mbs", "net_tx_mbs"]
    step = max(1, len(rows) // max(10, points))
    out = []
    for i in range(0, len(rows), step):
        chunk = rows[i:i + step]
        r = {"time": chunk[0].get("time")}
        for k in keep[1:]:
            vals = []
            for c in chunk:
                try: vals.append(float(c.get(k) or ""))
                except ValueError: pass
            r[k] = round(sum(vals) / len(vals), 1) if vals else None
        out.append(r)
    return {"run": run, "rows": out, "samples": len(rows), "every_s": step * 10}


# ---- scorecard: every method against the labels
def _lev(a, b):
    if a == b: return 0
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


@app.get("/api/plates/scorecard")
def plates_scorecard(run: str = ""):
    run = run or _latest_run()
    d = _run_dir(run); con = _adb(d)
    labels = {tid: l["truth"] for tid, l in _labels(run).items() if l["truth"] and l["truth"] != "?"}
    out = {"run": run, "labelled": len(labels), "methods": []}
    if con is None or not labels:
        return out
    try:
        ids = list(labels)
        agg: dict = {}

        def score(method, reader, tid, text, ms):
            a = agg.setdefault((method, reader), {"method": method, "reader": reader, "n": 0, "exact": 0, "within1": 0, "answered": 0, "ms": 0.0, "ms_n": 0})
            truth = labels[tid]; text = text or ""
            a["n"] += 1
            if text and text not in ("?", "ERR") and not text.startswith("ERR"):
                a["answered"] += 1
                if text == truth: a["exact"] += 1
                if _lev(text, truth) <= 1: a["within1"] += 1
            if ms is not None:
                a["ms"] += ms; a["ms_n"] += 1

        for chunk in (ids[i:i + 400] for i in range(0, len(ids), 400)):
            ph = ",".join("?" * len(chunk))
            reads = _arows(con, f"""SELECT track_id, prep, reader, text, conf, ms FROM plates WHERE detector='alpr_v9t' AND det_conf>=0.5 AND track_id IN ({ph})""", chunk)
            per: dict = {}
            for r in reads:
                per.setdefault((r["track_id"], r["reader"], r["prep"]), []).append(r)
            for (tid, reader, prep), rs in per.items():
                v = _vote(rs)
                ms = sum(r["ms"] or 0 for r in rs) if any(r["ms"] for r in rs) else None
                score(f"vote/{prep}", reader, tid, v["text"] if v else "", ms)
                best = max(rs, key=lambda r: r["conf"] or 0)
                score(f"best-conf/{prep}", reader, tid, best["text"] if (best["conf"] or 0) >= 0.5 else "?", (best["ms"] if best["ms"] else None))
            # every reader and prep together
            per_t: dict = {}
            for r in reads:
                per_t.setdefault(r["track_id"], []).append(r)
            for tid, rs in per_t.items():
                v = _vote(rs); score("vote/all preps", "all readers", tid, v["text"] if v else "", None)
            for r in _arows(con, f"SELECT track_id, model, text, seconds FROM vlm WHERE track_id IN ({ph})", chunk):
                score("vlm/sharpest crop", r["model"], r["track_id"], r["text"], (r["seconds"] or 0) * 1000 if r["seconds"] else None)
        # the enhancement experiment, if it ran against this benchmark
        ed = ANALYSIS_ROOT / "enhance"
        econ = _adb(ed, "enhance.sqlite") if ed.is_dir() else None
        if econ is not None:
            try:
                for r in _arows(econ, "SELECT r.track_id, r.method, r.reader, r.text, r.ms FROM reads r JOIN tracks t ON t.track_id=r.track_id WHERE t.matched=1"):
                    if r["track_id"] in labels:
                        score(f"enhance/{r['method']}", r["reader"], r["track_id"], r["text"], r["ms"])
            finally:
                econ.close()
        methods = []
        for a in agg.values():
            n = a["n"]
            methods.append({"method": a["method"], "reader": a["reader"], "n": n, "exact": a["exact"], "exact_pct": round(100 * a["exact"] / n, 1),
                            "within1": a["within1"], "within1_pct": round(100 * a["within1"] / n, 1), "answered": a["answered"],
                            "answered_pct": round(100 * a["answered"] / n, 1), "ms": round(a["ms"] / a["ms_n"], 1) if a["ms_n"] else None})
        methods.sort(key=lambda m: (-m["exact_pct"], -m["within1_pct"], m["ms"] or 1e9))
        out["methods"] = methods
    finally:
        con.close()
    return out


@app.get("/plates-media/{run}/{name}")
def plates_media(run: str, name: str):
    d = _run_dir(run)
    full = (d / "crops" / name).resolve()
    if (d / "crops").resolve() not in full.parents or not full.is_file():
        raise HTTPException(404)
    return FileResponse(full, headers={"Cache-Control": "public, max-age=86400"})


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
        status, mtime = None, None
        p = ROOT / "PiMetrics" / "live" / "status.json"
        try:
            status = json.loads(p.read_text())
            mtime = p.stat().st_mtime
            status["age_s"] = round(now - mtime)
            _live_cache["last_status"] = (status, mtime, now)
        except (OSError, ValueError):
            # The Pi replaces this file every 5 s, so a read can land in the moment between the old file going and the
            # new one arriving (or see half a file). The last good reading stands in for up to 30 s rather than erroring.
            last = _live_cache.get("last_status")
            if last and now - last[2] < 30:
                status, mtime = dict(last[0]), last[1]
                status["age_s"] = round(now - mtime)
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
        if status and mtime is not None and status.get("state") == "uploading":
            run_start = mtime - (status.get("elapsed_s") or 0) - 5
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
