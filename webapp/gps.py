"""gps.py - read the location track Tesla writes into its dashcam videos.

Cars on firmware 2025.44.25 or later (HW3/HW4) put a small SEI message in front of every video frame
with GPS position, heading, speed, gear and Autopilot state (format: github.com/teslamotors/dashcam,
dashcam.proto). This reads it straight from the MP4 - no extra software needed - and keeps about one
point per second.

  python gps.py <clip.mp4>      prints the points (for checking a file by hand)
"""
import json
import struct
import sys
import time
from pathlib import Path

PER_SECOND = 1          # points kept per second of video
AP = {0: None, 1: "fsd", 2: "autosteer", 3: "tacc"}
GEAR = {0: "P", 1: "D", 2: "R", 3: "N"}


def _boxes(f, start, end):
    """(type, payload offset, payload size) for each box between start and end."""
    pos = start
    while pos + 8 <= end:
        f.seek(pos)
        h = f.read(16)
        if len(h) < 8:
            return
        size, typ = struct.unpack(">I4s", h[:8])
        hs = 8
        if size == 1:
            size = struct.unpack(">Q", h[8:16])[0]
            hs = 16
        elif size == 0:
            size = end - pos
        if size < hs:
            return
        yield typ, pos + hs, size - hs
        pos += size


def _video_timing(f, moov_off, moov_size):
    """(seconds per frame, frame count) of the first video track, from mdhd + stsz."""
    for typ, off, size in _boxes(f, moov_off, moov_off + moov_size):
        if typ != b"trak":
            continue
        timescale = duration = count = None
        is_video = False
        stack = [(off, size)]
        while stack:                                     # walk trak > mdia > minf > stbl
            o, s = stack.pop()
            for t, po, ps in _boxes(f, o, o + s):
                if t in (b"mdia", b"minf", b"stbl"):
                    stack.append((po, ps))
                elif t == b"mdhd":
                    f.seek(po)
                    d = f.read(32)
                    if d[0] == 1:
                        timescale, duration = struct.unpack(">IQ", d[20:32])
                    else:
                        timescale, duration = struct.unpack(">II", d[12:20])
                elif t == b"hdlr":
                    f.seek(po + 8)
                    is_video = f.read(4) == b"vide"
                elif t == b"stsz":
                    f.seek(po + 8)
                    count = struct.unpack(">I", f.read(4))[0]
        if is_video and timescale and duration and count:
            return duration / timescale / count, count
    return None, None


def _unescape(b):
    """Remove H.264 emulation-prevention bytes (00 00 03 -> 00 00)."""
    if b"\x00\x00\x03" not in b:
        return b
    out, zeros = bytearray(), 0
    for x in b:
        if zeros >= 2 and x == 3:
            zeros = 0
            continue
        out.append(x)
        zeros = zeros + 1 if x == 0 else 0
    return bytes(out)


def _varint(b, i):
    r = shift = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << shift
        if x < 0x80:
            return r, i
        shift += 7


def _decode(b):
    """Minimal protobuf decoder for SeiMetadata: {field number: value}."""
    out, i = {}, 0
    try:
        while i < len(b):
            key, i = _varint(b, i)
            field, wt = key >> 3, key & 7
            if wt == 0:
                out[field], i = _varint(b, i)
            elif wt == 1:
                out[field] = struct.unpack("<d", b[i:i + 8])[0]
                i += 8
            elif wt == 5:
                out[field] = struct.unpack("<f", b[i:i + 4])[0]
                i += 4
            elif wt == 2:
                n, i = _varint(b, i)
                i += n
            else:
                break
    except (IndexError, struct.error):
        pass
    return out


def _payload(nal):
    """The protobuf bytes inside a Tesla SEI NAL (same rule as Tesla's sei_extractor.py), or None."""
    i = 3
    while i < len(nal) and nal[i] == 0x42:
        i += 1
    if i <= 3 or i >= len(nal) or nal[i] != 0x69:
        return None
    return _unescape(nal[i + 1:-1])


def read_track(path):
    """[{t, lat, lon, hdg, mph, ap, gear}, ...] about once per second; t = seconds into the clip.
    Empty when the clip has no location data (older firmware, or parked)."""
    points = []
    with open(path, "rb") as f:
        f.seek(0, 2)
        end = f.tell()
        mdat = moov = None
        for typ, off, size in _boxes(f, 0, end):
            if typ == b"mdat":
                mdat = (off, size)
            elif typ == b"moov":
                moov = (off, size)
        if not mdat:
            return points
        spf, _ = _video_timing(f, *moov) if moov else (None, None)
        spf = spf or 1 / 36                                # Tesla records at about 36 frames a second
        pos, stop = mdat[0], mdat[0] + mdat[1]
        frame, next_t = 0, 0.0
        while pos + 5 <= stop:
            f.seek(pos)
            h = f.read(6)
            if len(h) < 6:
                break
            n = struct.unpack(">I", h[:4])[0]
            if n == 0:
                break
            ntype = h[4] & 0x1F
            if ntype == 6 and h[5] == 5:                    # SEI, user data: Tesla's metadata
                t = frame * spf
                if t >= next_t:
                    f.seek(pos + 4)
                    m = _decode(_payload(f.read(min(n, 4096))) or b"")
                    lat, lon = m.get(11), m.get(12)
                    if lat and lon and abs(lat) <= 90 and abs(lon) <= 180:
                        points.append({"t": round(t, 2), "lat": round(lat, 6), "lon": round(lon, 6),
                                       "hdg": round(m.get(13, 0.0), 1),
                                       "mph": round(max(0.0, m.get(4, 0.0)) * 2.23694, 1),
                                       "ap": AP.get(m.get(10, 0)), "gear": GEAR.get(m.get(2, 0))})
                        next_t = (int(t * PER_SECOND) + 1) / PER_SECOND
            elif ntype in (1, 5):                           # a picture: the next frame starts after it
                frame += 1
            pos += 4 + n
    return points


# ------------------------------------------------------------------ cache (table "gps" in data/index.db)
def segment_clip(cameras):
    """The clip to read a segment's track from: the front camera, else any camera."""
    return cameras.get("front") or next(iter(cameras.values()), None)


def cached_track(con, root, rel):
    """Track of one clip (path relative to the footage folder), read once and kept in the database."""
    full = Path(root) / rel
    try:
        size = full.stat().st_size
    except OSError:
        return []
    r = con.execute("SELECT size, points FROM gps WHERE path=?", (rel,)).fetchone()
    if r and r[0] == size:
        return json.loads(r[1])
    try:
        pts = read_track(full)
    except (OSError, ValueError, struct.error):
        pts = []
    with con:
        con.execute("INSERT OR REPLACE INTO gps VALUES (?,?,?)", (rel, size, json.dumps(pts, separators=(",", ":"))))
    return pts


def warm(con, root, budget_s=240):
    """Read tracks for clips not seen yet, newest first, for up to budget_s seconds (runs after each scan)."""
    t0 = time.time()
    with con:
        con.execute("DELETE FROM gps WHERE path NOT IN (SELECT path FROM clips)")   # clips that were removed
    done = {r[0] for r in con.execute("SELECT path FROM gps")}
    n = 0
    for r in con.execute("SELECT cameras FROM segments WHERE encrypted=0 ORDER BY start DESC").fetchall():
        rel = segment_clip(json.loads(r[0]))
        if rel and rel not in done:
            cached_track(con, root, rel)
            n += 1
            if time.time() - t0 > budget_s:
                break
    return n


if __name__ == "__main__":
    t0 = time.time()
    pts = read_track(sys.argv[1])
    print(f"{len(pts)} points in {time.time() - t0:.2f} s")
    for p in pts[:5] + (["..."] if len(pts) > 10 else []) + pts[-5:]:
        print(p)
