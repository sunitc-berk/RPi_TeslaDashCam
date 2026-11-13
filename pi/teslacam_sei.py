"""teslacam_sei.py - was the car driving during this clip? Read from the data Tesla puts in the video.

Since firmware 2025.44.25 the car writes a small SEI message (GPS, speed, gear, Autopilot state)
in front of every video frame while it is driving (format: github.com/teslamotors/dashcam).
Footage recorded while parked has none. To stay quick on the Pi this reads only about one frame
per second, using the MP4's own index of where each frame is - a few dozen small reads per clip.

  driving(path) -> True   the car was in gear or moving at some point in the clip
                   False  the clip has the car's data and the car was parked the whole time
                   None   no driving data at all (parked, older firmware, or unreadable)

  python3 teslacam_sei.py CLIP.mp4 ...     prints the answer for each clip
"""
import struct
import sys

SAMPLE_EVERY = 36          # frames between checks (the car records ~36 frames a second)
MOVING_MS = 0.5            # m/s - anything above this counts as driving


def _boxes(f, start, end):
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


def _frame_offsets(f, end):
    """File offset of every video frame, from the first video track's sample tables."""
    moov = next(((o, s) for t, o, s in _boxes(f, 0, end) if t == b"moov"), None)
    if not moov:
        return None
    for typ, off, size in _boxes(f, moov[0], moov[0] + moov[1]):
        if typ != b"trak":
            continue
        tables, is_video, stack = {}, False, [(off, size)]
        while stack:
            o, s = stack.pop()
            for t, po, ps in _boxes(f, o, o + s):
                if t in (b"mdia", b"minf", b"stbl"):
                    stack.append((po, ps))
                elif t == b"hdlr":
                    f.seek(po + 8)
                    is_video = f.read(4) == b"vide"
                elif t in (b"stsz", b"stco", b"co64", b"stsc"):
                    f.seek(po)
                    tables[t] = f.read(ps)
        if not is_video or b"stsz" not in tables or b"stsc" not in tables:
            continue
        sz = tables[b"stsz"]
        fixed, count = struct.unpack(">II", sz[4:12])
        sizes = [fixed] * count if fixed else list(struct.unpack(f">{count}I", sz[12:12 + 4 * count]))
        if b"co64" in tables:
            c = tables[b"co64"]
            n = struct.unpack(">I", c[4:8])[0]
            chunks = list(struct.unpack(f">{n}Q", c[8:8 + 8 * n]))
        elif b"stco" in tables:
            c = tables[b"stco"]
            n = struct.unpack(">I", c[4:8])[0]
            chunks = list(struct.unpack(f">{n}I", c[8:8 + 4 * n]))
        else:
            return None
        sc = tables[b"stsc"]
        n = struct.unpack(">I", sc[4:8])[0]
        runs = [struct.unpack(">III", sc[8 + 12 * i:20 + 12 * i]) for i in range(n)]
        offsets, si = [], 0
        for r, (first, per_chunk, _) in enumerate(runs):
            last = runs[r + 1][0] - 1 if r + 1 < len(runs) else len(chunks)
            for ch in range(first, last + 1):
                pos = chunks[ch - 1]
                for _ in range(per_chunk):
                    if si >= len(sizes):
                        return offsets
                    offsets.append(pos)
                    pos += sizes[si]
                    si += 1
        return offsets
    return None


def _varint(b, i):
    r = shift = 0
    while True:
        x = b[i]
        i += 1
        r |= (x & 0x7F) << shift
        if x < 0x80:
            return r, i
        shift += 7


def _fields(b):
    """Gear (field 2) and speed in m/s (field 4) from Tesla's SeiMetadata protobuf."""
    out, i = {}, 0
    try:
        while i < len(b):
            key, i = _varint(b, i)
            field, wt = key >> 3, key & 7
            if wt == 0:
                out[field], i = _varint(b, i)
            elif wt == 1:
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


def _sei(nal):
    """Protobuf bytes of a Tesla SEI NAL unit, or None."""
    if len(nal) < 6 or (nal[0] & 0x1F) != 6 or nal[1] != 5:
        return None
    i = 3
    while i < len(nal) and nal[i] == 0x42:
        i += 1
    if i <= 3 or i >= len(nal) or nal[i] != 0x69:
        return None
    raw = nal[i + 1:-1]
    if b"\x00\x00\x03" in raw:                          # emulation-prevention bytes
        out, zeros = bytearray(), 0
        for x in raw:
            if zeros >= 2 and x == 3:
                zeros = 0
                continue
            out.append(x)
            zeros = zeros + 1 if x == 0 else 0
        raw = bytes(out)
    return raw


def driving(path):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            end = f.tell()
            offsets = _frame_offsets(f, end)
            if not offsets:
                return None
            seen = False
            for off in offsets[::SAMPLE_EVERY]:
                f.seek(off)
                head = f.read(1024)                     # the SEI comes first in the frame
                p = 0
                while p + 5 <= len(head):
                    n = struct.unpack(">I", head[p:p + 4])[0]
                    if n == 0:
                        break
                    if (head[p + 4] & 0x1F) == 6:
                        if p + 4 + n > len(head):
                            f.seek(off + p + 4)
                            nal = f.read(n)
                        else:
                            nal = head[p + 4:p + 4 + n]
                        payload = _sei(nal)
                        if payload is not None:
                            seen = True
                            m = _fields(payload)
                            if m.get(2, 0) in (1, 2, 3) or m.get(4, 0.0) > MOVING_MS:   # D, R, N or moving
                                return True
                    elif (head[p + 4] & 0x1F) in (1, 5):
                        break                          # reached the picture itself
                    p += 4 + n
            return False if seen else None
    except (OSError, struct.error, ValueError, IndexError):
        return None


if __name__ == "__main__":
    import time
    for p in sys.argv[1:]:
        t0 = time.time()
        r = driving(p)
        print(f"{p}: {'driving' if r else 'parked' if r is False else 'no driving data'} ({time.time() - t0:.3f} s)")
