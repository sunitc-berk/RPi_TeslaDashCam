"""drives.py - turn recordings into what the home list shows: drives, parked stretches and alerts.

The index groups footage into "trips" purely by time (any gap under 5 minutes continues the trip),
so one trip is often drive + parked at a shop + drive back. The car's own data inside the video
(gps.py) says which minutes were driving, so here every trip is cut into parts:

  drive    the car was moving / in gear: has a route, miles, a start and an end place
  parked   five minutes or more with no driving (shorter stops stay inside the drive)

Saved and Sentry clips are added as their own items; a saved clip that falls inside a drive is
attached to that drive as a "saved moment". Places are named "Home" (worked out from where drives
start and end most often), from the street/city Tesla wrote into nearby Saved/Sentry clips, and -
only if "place_names" is turned on in settings - from OpenStreetMap's public look-up service.
"""
import json
import math
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta

import gps

VERSION = 3                       # bump to recompute every cached trip
NEAR_M = 250                      # this close to home counts as "at home"
FMT = "%Y-%m-%d %H:%M:%S"
_lock = threading.Lock()
_cache = {"key": None, "data": None}


def parse(s):
    return datetime.strptime(s[:19].replace("T", " "), FMT)


def meters(a, b):
    """Distance between two (lat, lon) points."""
    r = math.pi / 180
    dlat, dlon = (b[0] - a[0]) * r, (b[1] - a[1]) * r
    h = math.sin(dlat / 2) ** 2 + math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlon / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


def simplify(pts, eps_m=12, cap=90):
    """Douglas-Peucker: the fewest points that keep the shape of the route."""
    if len(pts) <= 2:
        return pts
    step = max(1, len(pts) // 1500)
    pts = pts[::step] + ([pts[-1]] if (len(pts) - 1) % step else [])
    k = math.cos(pts[0][0] * math.pi / 180)
    xy = [((p[1] - pts[0][1]) * 111320 * k, (p[0] - pts[0][0]) * 110540) for p in pts]

    def run(eps):
        keep = [False] * len(pts)
        keep[0] = keep[-1] = True
        stack = [(0, len(pts) - 1)]
        while stack:
            a, b = stack.pop()
            ax, ay = xy[a]
            bx, by = xy[b]
            dx, dy = bx - ax, by - ay
            ln = math.hypot(dx, dy) or 1e-9
            best, bi = 0, None
            for i in range(a + 1, b):
                d = abs(dy * (xy[i][0] - ax) - dx * (xy[i][1] - ay)) / ln if ln > 1e-6 else math.hypot(xy[i][0] - ax, xy[i][1] - ay)
                if d > best:
                    best, bi = d, i
            if bi is not None and best > eps:
                keep[bi] = True
                stack += [(a, bi), (bi, b)]
        return [p for p, k_ in zip(pts, keep) if k_]

    out = run(eps_m)
    while len(out) > cap:
        eps_m *= 1.6
        out = run(eps_m)
    return out


# ------------------------------------------------------------------ one trip -> parts
def trip_parts(con, root, trip, gap, budget):
    segs = con.execute("SELECT key, start, cameras, size, encrypted FROM segments WHERE trip_id=? ORDER BY start",
                       (trip["id"],)).fetchall()
    n = len(segs)
    tracks = []
    for s in segs:
        pts = []
        rel = gps.segment_clip(json.loads(s["cameras"])) if not s["encrypted"] else None
        if rel:
            r = con.execute("SELECT points FROM gps WHERE path=?", (rel,)).fetchone()
            if r:
                pts = json.loads(r[0])
            elif budget[0] > 0:                           # not read yet (just arrived): read a few now
                budget[0] -= 1
                pts = gps.cached_track(con, root, rel)
        tracks.append(pts)
    driving = [any(p.get("gear") in ("D", "R", "N") or (p.get("mph") or 0) > 1 for p in t) for t in tracks]
    runs, i = [], 0
    while i < n:
        if driving[i]:
            j = i
            while j + 1 < n and driving[j + 1]:
                j += 1
            if runs and i - runs[-1][1] - 1 < gap:        # a stop shorter than the gap stays in the drive
                runs[-1][1] = j
            else:
                runs.append([i, j])
            i = j + 1
        else:
            i += 1
    if runs:                                              # a minute or two parked at either end is part of the drive
        if runs[0][0] < gap:
            runs[0][0] = 0
        if n - 1 - runs[-1][1] < gap:
            runs[-1][1] = n - 1
    t_end = parse(trip["end"])
    seg_t = [parse(s["start"]) for s in segs]
    seg_end = lambda b: min(seg_t[b] + timedelta(seconds=60), t_end) if b == n - 1 else seg_t[b + 1]
    size = lambda a, b: sum(segs[k]["size"] or 0 for k in range(a, b + 1))

    def parked(a, b):
        at = next(([p["lat"], p["lon"]] for k in range(a, b + 1) for p in tracks[k]), None)
        return {"k": "parked", "a": a, "b": b, "start": seg_t[a].strftime(FMT), "end": seg_end(b).strftime(FMT),
                "dur": int((seg_end(b) - seg_t[a]).total_seconds()), "size": size(a, b), "at": at}

    parts, nxt = [], 0
    for a, b in runs:
        if a > nxt:
            parts.append(parked(nxt, a - 1))
        pts = [(seg_t[k] + timedelta(seconds=p["t"]), p) for k in range(a, b + 1) for p in tracks[k]]
        moving = [x for x in pts if x[1].get("gear") in ("D", "R", "N") or (x[1].get("mph") or 0) > 1] or pts
        t0, t1 = moving[0][0], moving[-1][0]
        miles, top, prev = 0.0, 0.0, None
        for t, p in pts:
            top = max(top, p.get("mph") or 0)
            if prev and (t - prev[0]).total_seconds() <= 5 and ((p.get("mph") or 0) > 1 or (prev[1].get("mph") or 0) > 1):
                d = meters((prev[1]["lat"], prev[1]["lon"]), (p["lat"], p["lon"]))
                if d < 300:                               # ignore GPS jumps
                    miles += d / 1609.344
            prev = (t, p)
        line = [[p["lat"], p["lon"]] for t, p in pts if t0 <= t <= t1]
        parts.append({"k": "drive", "a": a, "b": b, "start": t0.strftime(FMT), "end": t1.strftime(FMT),
                      "dur": int((t1 - t0).total_seconds()), "mi": round(miles, 1), "top": round(top),
                      "from": line[0], "to": line[-1], "size": size(a, b),
                      "route": [[round(x, 5), round(y, 5)] for x, y in simplify(line)]})
        nxt = b + 1
    if nxt < n:
        parts.append(parked(nxt, n - 1))
    return parts


def all_parts(con, root, settings):
    """{trip id: [parts]} for every trip, recomputed only for trips whose footage or GPS data changed."""
    gap = int(settings.get("trip_gap_minutes", 5))
    try:
        sigs = {r[0]: f"{VERSION}:{gap}:{r[1]}:{r[2]}:{r[3]}" for r in con.execute(
            "SELECT s.trip_id, COUNT(*), COUNT(g.path), COALESCE(SUM(s.size),0) FROM segments s "
            "LEFT JOIN gps g ON g.path = json_extract(s.cameras, '$.front') "
            "WHERE s.trip_id IS NOT NULL GROUP BY s.trip_id")}
    except Exception:                                      # very old SQLite without JSON support
        sigs = {r[0]: f"{VERSION}:{gap}:{r[1]}:{r[2]}:{int(time.time() // 600)}" for r in con.execute(
            "SELECT trip_id, COUNT(*), COALESCE(SUM(size),0) FROM segments WHERE trip_id IS NOT NULL GROUP BY trip_id")}
    have = {r[0]: (r[1], r[2]) for r in con.execute("SELECT trip_id, sig, parts FROM trip_parts")}
    out, budget, fresh = {}, [240], []
    for t in con.execute("SELECT id, start, end FROM trips ORDER BY start").fetchall():
        sig = sigs.get(t["id"], "")
        if have.get(t["id"], ("",))[0] == sig:
            out[t["id"]] = json.loads(have[t["id"]][1])
        else:
            out[t["id"]] = trip_parts(con, root, t, gap, budget)
            if budget[0] > 0:                             # (out of budget = some GPS not read yet: don't cache)
                fresh.append((t["id"], sig, json.dumps(out[t["id"]], separators=(",", ":"))))
    gone = [(k,) for k in have if k not in out]
    if fresh or gone:
        with con:
            con.executemany("INSERT OR REPLACE INTO trip_parts VALUES (?,?,?)", fresh)
            con.executemany("DELETE FROM trip_parts WHERE trip_id=?", gone)
    return out


# ------------------------------------------------------------------ home and place names
def find_home(settings, parts_by_trip):
    h = settings.get("home")
    if isinstance(h, (list, tuple)) and len(h) == 2:
        return [float(h[0]), float(h[1])]
    ends = [p[k] for parts in parts_by_trip.values() for p in parts if p["k"] == "drive" for k in ("from", "to")]
    if len(ends) < 4:
        return None
    cells = {}
    for e in ends:
        cells.setdefault((round(e[0], 3), round(e[1], 3)), []).append(e)
    cell, members = max(cells.items(), key=lambda kv: len(kv[1]))
    if len(members) < 3 or len(members) < 0.2 * len(ends):
        return None
    near = [e for e in ends if meters(e, cell) < NEAR_M] or members
    return [round(sum(e[0] for e in near) / len(near), 5), round(sum(e[1] for e in near) / len(near), 5)]


def cell_of(pt):
    return f"{pt[0]:.3f},{pt[1]:.3f}"                     # about a 100 m square


class Namer:
    def __init__(self, con, home):
        self.home = home
        self.places = {r[0]: (r[1], r[2]) for r in con.execute("SELECT cell, name, city FROM places")}
        self.known = [((r[0], r[1]), r[2] or r[3], r[3]) for r in con.execute(
            "SELECT lat, lon, street, city FROM events WHERE lat IS NOT NULL AND lon IS NOT NULL "
            "AND (COALESCE(street,'') <> '' OR COALESCE(city,'') <> '')")]
        self.missing = set()

    def at_home(self, pt):
        return bool(self.home and pt and meters(pt, self.home) < NEAR_M)

    def name(self, pt):
        """{name, city, home} for a point; name is None when nothing is known about the place."""
        if not pt:
            return {"name": None, "city": None, "home": False}
        if self.at_home(pt):
            return {"name": "Home", "city": None, "home": True}
        c = cell_of(pt)
        if c in self.places and self.places[c][0]:
            return {"name": self.places[c][0], "city": self.places[c][1], "home": False}
        best = min(self.known, key=lambda k: meters(pt, k[0]), default=None)
        if c not in self.places:
            self.missing.add(c)
        if best and meters(pt, best[0]) < 200:
            return {"name": best[1], "city": best[2], "home": False}
        return {"name": None, "city": None, "home": False}


def lookup_places(con, cells, budget_s=120):
    """Ask OpenStreetMap (Nominatim) what is at each ~100 m cell; at most one request a second
    (their usage policy), each cell asked once. Only runs when "place_names" is on in settings."""
    t0, n = time.time(), 0
    for c in sorted(cells):
        if time.time() - t0 > budget_s:
            break
        lat, lon = c.split(",")
        url = "https://nominatim.openstreetmap.org/reverse?" + urllib.parse.urlencode(
            {"format": "jsonv2", "lat": lat, "lon": lon, "zoom": 17, "addressdetails": 1})
        name = city = None
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "TeslaCam-dashboard/1.0 (personal dashcam viewer)",
                                                       "Accept-Language": "en"})
            with urllib.request.urlopen(req, timeout=15) as r:
                a = json.load(r).get("address", {})
            name = a.get("road") or a.get("neighbourhood") or a.get("suburb") or a.get("hamlet")
            city = a.get("city") or a.get("town") or a.get("village") or a.get("county")
        except Exception as e:
            print("Place look-up failed:", repr(e))
            break                                          # offline or blocked: try again on a later pass
        with con:
            con.execute("INSERT OR REPLACE INTO places VALUES (?,?,?,?)",
                        (c, name, city, datetime.now().isoformat(timespec="seconds")))
        n += 1
        time.sleep(1.1)
    return n


# ------------------------------------------------------------------ everything, newest first
def build(con, root, settings):
    parts_by_trip = all_parts(con, root, settings)
    home = find_home(settings, parts_by_trip)
    namer = Namer(con, home)
    favs = {r[0] for r in con.execute("SELECT id FROM favorites")}
    keep_days = int(settings.get("recent_retention_days", 30))
    today = datetime.now().date()
    trips = {t["id"]: t for t in con.execute("SELECT id, start, end, place, encrypted FROM trips").fetchall()}
    fronts = {}                                            # trip id -> front-camera file of each minute (the list's pictures)
    for r in con.execute("SELECT trip_id, cameras, encrypted FROM segments WHERE trip_id IS NOT NULL ORDER BY trip_id, start"):
        cams = {} if r[2] else json.loads(r[1])
        fronts.setdefault(r[0], []).append(cams.get("front") or next(iter(cams.values()), None))

    def still(tid, a, b):
        """A front-camera minute to take the row's picture from: the middle of a drive, the start of a parked stretch."""
        f = fronts.get(tid, [])
        order = sorted(range(a, b + 1), key=lambda k: abs(k - (a + b) // 2))
        return next((f[k] for k in order if k < len(f) and f[k]), None)

    flat = sorted(((tid, p) for tid, parts in parts_by_trip.items() if tid in trips for p in parts),
                  key=lambda x: x[1]["start"])
    items, last = [], None                                 # last = (place, time) where the car was last seen driving
    for idx, (tid, p) in enumerate(flat):
        t = trips[tid]
        kept = tid in favs
        left = keep_days - (today - parse(p["start"]).date()).days
        it = {"id": f"{tid}:{p['a']}", "trip": tid, "a": p["a"], "b": p["b"], "type": p["k"], "start": p["start"],
              "end": p["end"], "dur": p["dur"], "size": p["size"], "kept": kept,
              "expires_days": None if kept else left, "encrypted": bool(t["encrypted"])}
        it["still"] = still(tid, p["a"], p["b"] if p["k"] == "drive" else min(p["b"], p["a"] + 1))
        if p["k"] == "drive":
            it.update(miles=p["mi"], top_mph=p["top"], route=p["route"], saved=[],
                      frm=namer.name(p["from"]), to=namer.name(p["to"]))
            last = (p["to"], parse(p["end"]))
        else:
            at = p.get("at")
            if not at and last and (parse(p["start"]) - last[1]).total_seconds() <= 1200:
                at = last[0]                               # the car has not moved since the drive ended
            if not at:
                nx = next((q for _, q in flat[idx + 1:idx + 3] if q["k"] == "drive"), None)
                if nx and (parse(nx["start"]) - parse(p["end"])).total_seconds() <= 1200:
                    at = nx["from"]
            home_now = namer.at_home(at) if at else (t["place"] == "home")   # no position: go by the Pi's label
            it.update(at=at, at_home=home_now,
                      place={"name": "Home", "city": None, "home": True} if home_now else namer.name(at))
        items.append(it)

    # Saved and Sentry clips
    drives = [it for it in items if it["type"] == "drive"]
    group = None
    for e in con.execute("SELECT id, kind, timestamp, start, end, city, street, reason, lat, lon, thumb, size, encrypted "
                         "FROM events ORDER BY COALESCE(timestamp, start)").fetchall():
        when = e["timestamp"] or e["start"]
        if not when:
            continue
        pt = [e["lat"], e["lon"]] if e["lat"] is not None and e["lon"] is not None else None
        dur = 0
        try:
            dur = int((parse(e["end"]) - parse(e["start"])).total_seconds())
        except (TypeError, ValueError):
            pass
        ev = {"id": e["id"], "type": e["kind"], "start": when, "end": e["end"] or when, "dur": dur, "size": e["size"] or 0,
              "reason": e["reason"], "thumb": e["thumb"], "at": pt, "kept": e["id"] in favs, "expires_days": None,
              "encrypted": bool(e["encrypted"]), "at_home": namer.at_home(pt),
              "place": {"name": "Home", "city": None, "home": True} if namer.at_home(pt)
              else {"name": e["street"] or e["city"] or None, "city": e["city"], "home": False}}
        if e["kind"] == "saved":
            d = next((d for d in drives if d["start"] <= when <= d["end"]), None)
            if d:                                          # a moment inside a drive: shown on that drive
                seg0 = con.execute("SELECT start FROM segments WHERE trip_id=? ORDER BY start LIMIT 1 OFFSET ?",
                                   (d["trip"], d["a"])).fetchone()
                pos = (parse(when) - parse(seg0[0])).total_seconds() if seg0 else 0
                d["saved"].append({"id": e["id"], "time": when, "pos": max(0, round(pos)), "reason": e["reason"]})
                ev["in_drive"] = d["id"]
            items.append(ev)
            continue
        # Sentry: alerts minutes apart at the same spot are one row
        same = (group and (parse(when) - parse(group["end_t"])).total_seconds() <= 1800
                and (pt is None or group["at"] is None or meters(pt, group["at"]) < 150))
        member = {"id": e["id"], "time": when, "reason": e["reason"], "thumb": e["thumb"], "kept": ev["kept"]}
        if same:
            group["members"].append(member)
            group["end_t"] = when
            group["kept"] = group["kept"] or ev["kept"]
        else:
            group = dict(ev, members=[member], end_t=when)
            items.append(group)
    for it in items:
        if "members" in it:
            it["end"] = it.pop("end_t")
            it["count"] = len(it["members"])
    items.sort(key=lambda x: x["start"], reverse=True)
    return {"home": home, "items": items, "missing_places": sorted(namer.missing)}


def state_key(con, settings):
    q = lambda sql: con.execute(sql).fetchone()[0]
    return (q("SELECT COUNT(*) FROM trips"), q("SELECT MAX(end) FROM trips"), q("SELECT COUNT(*) FROM segments"),
            q("SELECT COUNT(*) FROM gps"), q("SELECT COUNT(*) FROM events"), q("SELECT COUNT(*) FROM favorites"),
            q("SELECT MAX(created) FROM favorites"), q("SELECT COUNT(*) FROM places"),
            str(settings.get("home")), datetime.now().strftime("%Y-%m-%d"))


def get(con, root, settings):
    """Everything for the home list (cached until footage, favorites or place names change)."""
    with _lock:
        key = state_key(con, settings)
        if _cache["key"] != key:
            _cache["data"] = build(con, root, settings)
            _cache["key"] = state_key(con, settings)       # building may have filled the GPS cache
        return _cache["data"]


# ------------------------------------------------------------------ search
WD = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
MO = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"]
WORDS = {"drive": "drive trip", "parked": "parked parking", "sentry": "sentry alert", "saved": "saved clip honk"}


def haystack(it):
    d = parse(it["start"])
    bits = [it["start"][:10], MO[d.month - 1], MO[d.month - 1][:3], str(d.day), WD[d.weekday()], WD[d.weekday()][:3],
            f"{d.month}/{d.day}", f"{d.month}/{d.day}/{d.year}", f"{d.month:02d}/{d.day:02d}", str(d.year), WORDS.get(it["type"], "")]
    for k in ("frm", "to", "place"):
        pl = it.get(k) or {}
        bits += [pl.get("name") or "", pl.get("city") or ""]
    if it.get("kept"):
        bits.append("kept")
    return " ".join(bits).lower()


def matches(it, q):
    hay = haystack(it)
    words = hay.split()
    for tok in q.lower().replace(",", " ").split():
        if tok.isdigit():
            if tok not in words:                           # "4" must be the 4th, not part of 2026
                return False
        elif tok not in hay:
            return False
    return True
