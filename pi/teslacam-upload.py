#!/usr/bin/env python3
"""teslacam-upload.py - upload files to the PC share with smbclient, safely, in small batches.

Why not mount the share? A mounted Windows share (CIFS) can hang processes in the kernel when
Wi-Fi drops mid-transfer - sometimes so badly they cannot be killed until a reboot. smbclient is
an ordinary program: it always times out, and it can always be killed.

  teslacam-upload.py --list LIST --src DIR --dest-prefix PREFIX --verified OUT [--max-minutes N]
      LIST: lines "<relative path>\\t<size>". Uploads DIR/<rel> to \\\\PC\\share\\PREFIX\\<rel>.
      Appends every file that is CONFIRMED on the PC (same size) to OUT. Never deletes anything.
      Each file is written as ".<name>.part" and renamed only when complete, so the PC never
      sees half-written footage. Stops cleanly when the PC becomes unreachable.
      Exit 0 = everything uploaded, 3 = PC unreachable / partial, 1 = other error.
      Several batches upload at once (TESLACAM_PARALLEL, default 3): each smbclient connection
      runs on its own CPU core, which is where a Pi 4 runs out of speed (Windows signs every
      SMB packet and the Pi 4 has no hardware help for that).

  teslacam-upload.py --retention DAYS --dirs RecentClips,EncryptedClips/RecentClips
      Deletes files older than DAYS (judged by the date in the file name) from those PC folders.

  teslacam-upload.py --heartbeat [--state idle|staging] [--note TEXT]
      Writes the Pi's live status (footage waiting, Wi-Fi, car drive, last uploads) to
      \\\\PC\\share\\PiMetrics\\live\\status.json for the dashboard's Status page.
      An upload started with --label KIND also updates that file before every batch, so the
      dashboard can show progress, speed and time left while it runs.
"""
import argparse
import glob
import json
import os
import re
import socket
import subprocess
import sys
import time
from datetime import datetime, timedelta

SYNC_SCRIPT = os.environ.get("TESLACAM_SYNC_SCRIPT", "/usr/local/bin/teslacam-sync.sh")
CREDS = os.environ.get("TESLACAM_CREDS", "/root/.teslacam-smb")
PORT = int(os.environ.get("TESLACAM_SMB_PORT", "445"))      # override only for testing
BATCH_FILES = int(os.environ.get("TESLACAM_BATCH", "30"))   # files per smbclient session
MIN_RATE = 0.5e6                 # assume at least 0.5 MB/s when sizing each batch's time limit
BATCH_BYTES = int(os.environ.get("TESLACAM_BATCH_BYTES", str(400_000_000)))  # ~10 clips per batch
SMB_TIMEOUT = int(os.environ.get("TESLACAM_SMB_TIMEOUT", "30"))  # smbclient per-operation timeout (s)
PARALLEL = max(1, int(os.environ.get("TESLACAM_PARALLEL", "3")))  # uploads running at the same time
LS_LINE = re.compile(r"^\s{2}(.+?)\s+[ADHNRSI]*\s+(\d+)\s+\w{3} \w{3}\s+\d+ [\d:]+ \d{4}$")
DATE = re.compile(r"^(\d{4}-\d{2}-\d{2})_")
STATE_DIR = os.environ.get("TESLACAM_STATE_DIR", "/var/lib/teslacam")
LIVE_LOCAL = os.environ.get("TESLACAM_LIVE_LOCAL", "/run/teslacam/live-status.json")
LIVE_DIR = "PiMetrics/live"


def config():
    """the PC's address: what teslacam-sync.sh found (by name, last known or configured), else the configured one"""
    text = open(SYNC_SCRIPT).read() if os.path.exists(SYNC_SCRIPT) else ""
    get = lambda k, d: (re.search(rf'^{k}="([^"]*)"', text, re.M) or [None, d])[1]
    host = os.environ.get("TESLACAM_PC_ADDR") or get("PC_HOST", "192.168.68.59")
    return host, get("SHARE_NAME", "TeslaCam")


def reachable(host, timeout=3):
    try:
        with socket.create_connection((host, PORT), timeout=timeout):
            return True
    except OSError:
        return False


NETWORK_ERRORS = ("NT_STATUS_IO_TIMEOUT", "NT_STATUS_CONNECTION_", "NT_STATUS_NETWORK_", "NT_STATUS_HOST_UNREACHABLE",
                  "NT_STATUS_INVALID_NETWORK_RESPONSE", "Connection to ", "NT_STATUS_PIPE_BROKEN",
                  "timed out", "Protocol negotiation", "session setup failed", "tree connect failed",
                  "NT_STATUS_LOGON_FAILURE", "NT_STATUS_ACCESS_DENIED", "NT_STATUS_BAD_NETWORK_NAME",
                  "Connection reset", "Broken pipe")


def smb(host, share, commands, limit):
    """Run smbclient commands; returns (ok, output). Always ends within `limit` seconds, and stops
    at the FIRST network error (instead of timing out command after command)."""
    import threading
    script = "\n".join(commands) + "\n"
    cmd = ["smbclient", f"//{host}/{share}", "-A", CREDS, "-m", "SMB3",
           "-t", str(SMB_TIMEOUT), "-p", str(PORT), "-E"]
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    lines, net_error = [], threading.Event()

    def reader():
        for line in p.stdout:
            lines.append(line)
            if any(k in line for k in NETWORK_ERRORS):
                net_error.set()
                p.kill()
                return

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    try:
        p.stdin.write(script)
        p.stdin.close()
    except (BrokenPipeError, OSError):
        pass
    try:
        p.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        p.kill()
        lines.append("smbclient did not finish in time\n")
        p.wait()
    t.join(timeout=5)
    ok = p.returncode == 0 and not net_error.is_set()
    return ok, "".join(lines)


def q(path):
    """Quote a path for an smbclient command (Windows separators)."""
    return '"' + path.replace("/", "\\").replace('"', "") + '"'


def remote_sizes(host, share, rdir, names):
    """{name: size} for files in remote dir rdir whose names start with the batch's common prefix."""
    prefix = os.path.commonprefix(names) or ""
    ok, out = smb(host, share, [f"ls {q((rdir + '/' if rdir else '') + prefix + '*')}"], 120)
    sizes = {}
    for line in out.splitlines():
        m = LS_LINE.match(line)
        if m:
            sizes[m.group(1).strip()] = int(m.group(2))
    return sizes


# ------------------------------------------------------------------ live status for the dashboard
def read(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


def folder_totals(d):
    """(files, bytes) of finished files waiting in a Pi folder."""
    n = b = 0
    for root, _, files in os.walk(d):
        for name in files:
            if name.startswith(".") or name.endswith(".part"):
                continue
            try:
                b += os.path.getsize(os.path.join(root, name))
                n += 1
            except OSError:
                pass
    return n, b


def pi_facts():
    facts = {"time_pi": datetime.now().astimezone().isoformat(timespec="seconds"),
             "clock_synced": None, "cpu_temp_c": None, "wifi_dbm": None, "wifi_ssid": None, "car_usb": None}
    t = read("/sys/class/thermal/thermal_zone0/temp")
    if t.isdigit():
        facts["cpu_temp_c"] = round(int(t) / 1000, 1)
    for p in glob.glob("/sys/class/udc/*/state"):
        facts["car_usb"] = read(p) or None
    try:
        out = subprocess.run(["iw", "dev", "wlan0", "link"], capture_output=True, text=True, timeout=5).stdout
        m = re.search(r"signal:\s*(-?\d+)", out)
        facts["wifi_dbm"] = int(m.group(1)) if m else None
        m = re.search(r"SSID:\s*(.+)", out)
        facts["wifi_ssid"] = m.group(1).strip() if m else None
        facts["clock_synced"] = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                                               capture_output=True, text=True, timeout=5).stdout.strip() == "yes"
    except (OSError, subprocess.SubprocessError):
        pass
    rn, rb = folder_totals(os.path.join(STATE_DIR, "recent-archive"))
    en, eb = folder_totals(os.path.join(STATE_DIR, "event-outbox"))
    facts["waiting"] = {"recent_files": rn, "recent_bytes": rb, "event_files": en, "event_bytes": eb}
    last = []
    try:
        with open(os.path.join(STATE_DIR, "metrics", "sync-history.jsonl")) as f:
            last = [json.loads(l) for l in f.readlines()[-5:] if l.strip()]
    except (OSError, ValueError):
        pass
    facts["last_runs"] = last
    return facts


def push_status(host, share, status):
    """Write the live status file on the PC (small; failures are ignored - it is only informational)."""
    try:
        os.makedirs(os.path.dirname(LIVE_LOCAL), exist_ok=True)
        with open(LIVE_LOCAL, "w") as f:
            json.dump({**pi_facts(), **status}, f)
        tmp, dst = f"{LIVE_DIR}/.status.tmp", f"{LIVE_DIR}/status.json"
        smb(host, share, ["mkdir PiMetrics", f"mkdir {q(LIVE_DIR)}", f"put {q(LIVE_LOCAL).replace(chr(92), '/')} {q(tmp)}",
                          f"rm {q(dst)}", f"rename {q(tmp)} {q(dst)}"], 30)
    except Exception:          # never let the status display break an upload
        pass


def heartbeat(args):
    host, share = config()
    if not reachable(host):
        return 3
    push_status(host, share, {"state": args.state, "note": args.note or ""})
    return 0


def upload(args):
    host, share = config()
    items = []
    with open(args.list) as f:
        for line in f:
            line = line.rstrip("\n")
            if "\t" in line:
                rel, size = line.rsplit("\t", 1)
                items.append((rel, int(size)))
    deadline = time.time() + args.max_minutes * 60
    done_bytes, done_files, failures = 0, 0, 0
    tty = sys.stdout.isatty()
    t0 = time.time()
    made_dirs = set()

    # group by remote directory, keep order
    batches, cur, cur_bytes = [], [], 0
    for it in items:                       # at most BATCH_FILES files or BATCH_BYTES per batch
        if cur and (len(cur) >= BATCH_FILES or cur_bytes + it[1] > BATCH_BYTES):
            batches.append(cur)
            cur, cur_bytes = [], 0
        cur.append(it)
        cur_bytes += it[1]
    if cur:
        batches.append(cur)
    total_bytes = sum(s for _, s in items)
    started_iso = datetime.now().astimezone().isoformat(timespec="seconds")

    def status(state, k=None, note=""):
        if not args.label:
            return
        el = max(1.0, time.time() - t0)
        rate = done_bytes / el if done_files else None
        b = batches[k] if k is not None and k < len(batches) else []
        push_status(host, share, {
            "state": state, "note": note, "kind": args.label, "started_pi": started_iso,
            "elapsed_s": round(el), "files_total": len(items), "files_done": done_files,
            "bytes_total": total_bytes, "bytes_done": done_bytes,
            "rate_bps": round(rate) if rate else None,
            "eta_s": round((total_bytes - done_bytes) / rate) if rate else None,
            "batch": k + 1 if k is not None else None, "batches": len(batches),
            "batch_files": len(b), "batch_bytes": sum(s for _, s in b),
            "batch_first": os.path.basename(b[0][0]) if b else None, "batch_last": os.path.basename(b[-1][0]) if b else None})

    import threading
    from concurrent.futures import ThreadPoolExecutor

    # 1. folders first, and remove temp files an interrupted run left behind - once, before any
    #    upload starts (so no connection can delete another one's file in progress)
    dirs = set()
    for rel, _ in items:
        rdir = os.path.dirname("/".join(p for p in (args.dest_prefix, rel) if p))
        dirs.add(rdir)
    prep = []
    for rdir in sorted(dirs):
        parts = rdir.split("/") if rdir else []
        for i in range(1, len(parts) + 1):
            d = "/".join(parts[:i])
            if d not in made_dirs:
                prep.append(f"mkdir {q(d)}")
                made_dirs.add(d)
        prep.append(f"del {q((rdir + '/' if rdir else '') + '.*.part')}")
    if not reachable(host):
        print("PC is not reachable (Wi-Fi dropped, PC asleep or off) - stopping, will resume next run")
        return 3
    smb(host, share, prep, 120)

    # 2. batches upload in parallel; each one is verified on the PC before it counts
    lock = threading.Lock()
    stop = threading.Event()
    state = {"failures": 0, "started": -1, "reason": ""}
    queue = list(enumerate(batches))

    def worker():
        nonlocal done_files, done_bytes
        while not stop.is_set():
            with lock:
                if not queue:
                    return
                k, batch = queue.pop(0)
                state["started"] = max(state["started"], k)
            if time.time() > deadline:
                state["reason"] = "time"
                stop.set()
                return
            if not reachable(host):
                state["reason"] = "unreachable"
                stop.set()
                return
            cmds, by_dir = [], {}
            for rel, size in batch:
                remote = "/".join(p for p in (args.dest_prefix, rel) if p)
                rdir, name = os.path.split(remote)
                by_dir.setdefault(rdir, []).append((rel, name, size))
                tmp = (rdir + "/" if rdir else "") + "." + name + ".part"
                cmds += [f"put {q(os.path.join(args.src, rel)).replace(chr(92), '/')} {q(tmp)}",
                         f"rm {q(remote)}",
                         f"rename {q(tmp)} {q(remote)}"]
            batch_bytes = sum(s for _, s in batch)
            limit = 60 + batch_bytes / MIN_RATE * PARALLEL      # connections share the Wi-Fi
            ok, out = smb(host, share, cmds, limit)
            verified = []
            for rdir, entries in by_dir.items():
                sizes = remote_sizes(host, share, rdir, [n for _, n, _ in entries])
                verified += [(rel, size) for rel, name, size in entries if sizes.get(name) == size]
            with lock:
                with open(args.verified, "a") as f:
                    for rel, size in verified:
                        f.write(f"{rel}\t{size}\n")
                    f.flush()
                    os.fsync(f.fileno())
                done_files += len(verified)
                done_bytes += sum(s for _, s in verified)
                if len(verified) < len(batch):
                    state["failures"] += 1
                    err = " | ".join(l for l in out.splitlines() if "NT_STATUS" in l or "ERR" in l.upper())[-400:]
                    print(f"\nBatch incomplete: {len(verified)}/{len(batch)} confirmed on the PC. {err}", flush=True)
                    network_trouble = (not verified or any(k in out for k in NETWORK_ERRORS + ("did not finish in time",)))
                    if network_trouble or state["failures"] >= 3 or not reachable(host):
                        state["reason"] = "network"
                        stop.set()
                else:
                    state["failures"] = 0

    with ThreadPoolExecutor(max_workers=min(PARALLEL, len(batches)) or 1) as pool:
        futures = [pool.submit(worker) for _ in range(min(PARALLEL, len(batches)) or 1)]
        last_push = 0
        while not all(f.done() for f in futures):
            time.sleep(0.5)
            if time.time() - last_push >= 5:              # live status for the dashboard
                last_push = time.time()
                status("uploading", max(0, state["started"]))
            if tty:
                rate = done_bytes / max(1, time.time() - t0) / 1e6
                print(f"\r  {done_files}/{len(items)} files, {done_bytes // 1_000_000} MB, {rate:.1f} MB/s   ",
                      end="", flush=True)
        for f in futures:
            f.result()                                     # surface unexpected errors
    if state["reason"] == "time":
        print("\nTime limit reached - the rest goes next run")
        status("stopped", note="Time limit for one run reached - continues on the next run")
        return 3
    if state["reason"] == "unreachable":
        print("\nPC is not reachable (Wi-Fi dropped, PC asleep or off) - stopping, will resume next run")
        status("stopped", note="The PC stopped answering - continues on the next run")
        return 3
    if state["reason"] == "network":
        print("\nNetwork trouble talking to the PC - stopping, will resume next run", flush=True)
        status("stopped", note="Network trouble talking to the PC - continues on the next run")
        return 3
    if tty:
        print()
    ok = done_files == len(items)
    status("finished" if ok else "stopped", note="" if ok else "Not everything was confirmed - continues on the next run")
    return 0 if ok else 3


def retention(args):
    host, share = config()
    if not reachable(host):
        return 3
    cutoff = (datetime.now() - timedelta(days=args.retention)).strftime("%Y-%m-%d")
    removed = 0
    for d in args.dirs.split(","):
        ok, out = smb(host, share, [f"ls {q(d + '/*')}"], 300)
        dates = set()
        for line in out.splitlines():
            m = LS_LINE.match(line)
            if m:
                dm = DATE.match(m.group(1).strip())
                if dm and dm.group(1) < cutoff:
                    dates.add(dm.group(1))
        for day in sorted(dates):
            ok, _ = smb(host, share, [f"del {q(d + '/' + day + '_*')}"], 300)
            removed += 1 if ok else 0
            print(f"Removed {d} footage from {day} (older than {args.retention} days)")
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list")
    ap.add_argument("--src")
    ap.add_argument("--dest-prefix", default="")
    ap.add_argument("--verified")
    ap.add_argument("--max-minutes", type=float, default=90)
    ap.add_argument("--retention", type=int)
    ap.add_argument("--dirs", default="RecentClips,EncryptedClips/RecentClips")
    ap.add_argument("--label", help="kind of footage (recent/events) - turns on live status updates")
    ap.add_argument("--heartbeat", action="store_true")
    ap.add_argument("--state", default="idle")
    ap.add_argument("--note", default="")
    a = ap.parse_args()
    if a.heartbeat:
        sys.exit(heartbeat(a))
    if a.retention:
        sys.exit(retention(a))
    if not (a.list and a.src and a.verified):
        ap.error("--list, --src and --verified are required")
    sys.exit(upload(a))


if __name__ == "__main__":
    main()
