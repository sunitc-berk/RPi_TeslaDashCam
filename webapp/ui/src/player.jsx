// Player - six cameras in sync: one big, five small (click a small one to make it big), one timeline, the map.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, Card, Badge, Button, Slider, Spinner, Menu, MenuTrigger, MenuPopover, MenuList, MenuItemRadio } from "@fluentui/react-components";
import { ArrowLeft20Regular, Play24Filled, Pause24Filled, ChevronDown16Regular, FullScreenMaximize20Regular, Target20Regular } from "@fluentui/react-icons";
import { api, media, parseT, ymd, hms, pad, t12, range12, dayLabel, WD, MO, CAMS, CAM_NAMES, CAM_SHORT, clipOf, itemTitle, placeText, milesText, whyText, FAV, LIVE, upState, useStore, ROUTE } from "./lib.js";
import { useCrumb } from "./shell.jsx";
import { KeepButton } from "./footage.jsx";
import { T, useColors } from "./theme.js";
import { streetLayer } from "./maps.js";

const SLOTS = ["big", "mirror", "lp", "rp", "lr", "rr"];
const DEFAULT_SLOTS = { big: "front", mirror: "back", lp: "left_pillar", rp: "right_pillar", lr: "left_repeater", rr: "right_repeater" };
const SPEEDS = [0.5, 1, 2, 4];
const FPS = 36;                                     // Tesla cameras record about 36 frames a second
// half the cameras load through the PC's other local name so all six get their own connections (browsers allow 6 per name)
const ALT_HOST = { "localhost": "127.0.0.1", "127.0.0.1": "localhost" }[location.hostname];
const camSrc = (cam, src) => { const url = media(src); return !ALT_HOST || !["left_pillar", "right_pillar", "left_repeater", "right_repeater"].includes(cam) ? url : `${location.protocol}//${ALT_HOST}${location.port ? ":" + location.port : ""}${url}`; };
const muted = { color: T.colorNeutralForeground2 };

export function Player({ params }) {
  const [d, setD] = useState(null), [err, setErr] = useState(null);
  const tid = params.get("trip"), eid = params.get("event"), a = params.get("a"), b = params.get("b"), from = params.get("from"), to = params.get("to");
  useEffect(() => {
    let on = true;
    (async () => {
      let clip = null, segs = [], events = [], item = null;
      if (tid) {
        const [r, parts] = await Promise.all([api(`/api/trip/${encodeURIComponent(tid)}`), api(`/api/parts/${encodeURIComponent(tid)}`).catch(() => [])]);
        clip = clipOf(r); segs = r.segments; events = r.events || [];
        if (a != null && b != null) { item = parts.find(p => p.a === +a) || null; segs = segs.slice(+a, +b + 1); } else if (parts.length === 1) item = parts[0];
        if (item && item.type === "parked" && item.at) { clip.lat = item.at[0]; clip.lon = item.at[1]; clip.city = placeText(item.place); }
      } else if (eid) {
        const r = await api(`/api/event/${encodeURIComponent(eid)}`);
        clip = clipOf(r); segs = r.segments; events = r.timestamp ? [{ timestamp: r.timestamp, kind: r.kind, reason: r.reason }] : [];
      } else if (from && to) {
        const r = await api(`/api/range?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`);
        segs = r.segments;
        if (segs.length) { const endT = parseT(segs[segs.length - 1].start); endT.setSeconds(endT.getSeconds() + 60); clip = { id: null, type: "trip", itemType: null, start: segs[0].start, end: `${ymd(endT)} ${hms(endT)}`, dur: segs.length * 60 }; }
      }
      if (on) setD({ clip, segs, events, item });
    })().catch(e => on && setErr(e));
    return () => { on = false; };
  }, [tid, eid, a, b, from, to]);
  const title = d?.clip ? (d.item ? itemTitle(d.item) : d.clip.itemType === "event" ? (d.clip.type === "sentry" ? "Sentry alert" : "Saved clip") : "Recording") : "Player";
  const mon = d?.clip ? d.clip.start.slice(0, 7) : null;
  useCrumb([["Footage", "#/drives"], ...(mon ? [[`${MO[+mon.slice(5) - 1]} ${mon.slice(0, 4)}`, `#/drives?month=${mon}`]] : []), [title]]);
  const back = e => { if (ROUTE.get().prev && ROUTE.get().prev !== "player") { e.preventDefault(); history.back(); } };
  if (err) return <Card><Text weight="semibold">Could not open this footage.</Text><Text style={muted}>{String(err.message)}</Text></Card>;
  if (!d) return <Spinner label="Opening…" style={{ marginTop: 40 }} />;
  const { clip, segs, events, item } = d;
  if (!clip || !segs.length) return <div style={{ display: "flex", alignItems: "center", gap: 12 }}><Button appearance="subtle" size="large" icon={<ArrowLeft20Regular />} as="a" href="#/drives" onClick={back} aria-label="Back to the list" />
    <div><Text className="display" size={600} weight="semibold" block>Nothing to play</Text><Text size={300} style={muted}>This footage is no longer on the PC.</Text></div></div>;
  const start = parseT(item ? item.start : clip.timestamp || clip.start), end = parseT(item ? item.end : clip.end);
  const day = dayLabel(ymd(start)), dayText = day.big === "Today" || day.big === "Yesterday" ? `${day.big}, ${day.rest}` : `${WD[start.getDay()]}, ${MO[start.getMonth()]} ${start.getDate()}`;
  const facts = item ? (item.type === "drive" ? [range12(start, end), milesText(item.miles)] : [range12(start, end), placeText(item.place)])
    : clip.itemType === "event" ? [t12(start), whyText(clip.reason), clip.street || clip.city || ""] : [range12(start, end)];
  const keepWhat = item?.type === "parked" ? "this recording" : clip.itemType === "event" ? "this clip" : "this drive";
  const marks = events.filter(e => e.timestamp).map(e => ({ t: (parseT(e.timestamp) - parseT(segs[0].start)) / 1000, kind: e.kind, label: whyText(e.reason) || e.kind }));
  (item?.saved || []).forEach(sv => { if (!marks.some(m => Math.abs(m.t - sv.pos) < 5)) marks.push({ t: sv.pos, kind: "saved", label: whyText(sv.reason) || "Saved moment" }); });
  const startAt = Math.max(0, Math.min(+params.get("t") || 0, segs.length * 60 - 1));
  return <>
    <div style={{ flex: "none", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
      <Button className="plback" appearance="subtle" size="large" icon={<ArrowLeft20Regular />} as="a" href="#/drives" onClick={back} aria-label="Back to the list" />
      <div style={{ minWidth: 0 }}><Text className="display" size={600} weight="semibold" block truncate>{title}</Text><Text size={300} style={muted}>{[dayText, ...facts].filter(Boolean).join(", ")}</Text></div>
      <span style={{ flex: 1 }} />
      {clip.id && <KeepButton id={clip.id} itemType={clip.itemType} current={clip.favorite} size="large" words={`Keep ${keepWhat}`} />}
    </div>
    <Stage key={`${tid || eid || from}-${a}-${b}`} clip={clip} segs={segs} marks={marks} startAt={startAt} />
  </>;
}

// ---------------------------------------------------------------- the stage: six videos, the timeline, the map
function Stage({ clip, segs, marks, startAt }) {
  const C = useColors();
  const P = useRef(null);
  if (!P.current) {
    const vids = {};
    CAMS.forEach(cam => { const v = document.createElement("video"); v.muted = true; v.playsInline = true; v.preload = "auto"; v.dataset.cam = cam; v.setAttribute("aria-label", `${CAM_NAMES[cam]} camera`); vids[cam] = v; });
    P.current = { segs, idx: 0, playing: false, vids, master: null, speed: 1, slots: { ...DEFAULT_SLOTS }, seeking: false, stall: 0, lastT: -1, onPos: () => {} };
  }
  const p = P.current;
  const [slots, setSlots] = useState(p.slots), [playing, setPlayingState] = useState(false), [speed, setSpeedState] = useState(1);
  const [pos, setPos] = useState(startAt), [scrub, setScrub] = useState(null), [idx, setIdx] = useState(0), [tick, setTick] = useState(0);
  const live = useStore(LIVE);
  const stageRef = useRef(), tiles = useRef({});
  const total = segs.length * 60;
  const wallAt = s => { const i = Math.max(0, Math.min(Math.floor(s / 60), segs.length - 1)), t = parseT(segs[i].start); t.setSeconds(t.getSeconds() + Math.floor(s - i * 60)); return t; };
  const posNow = () => p.idx * 60 + (p.master?.currentTime || 0);
  const encrypted = segs.every(s => s.encrypted);

  // ---- playback (same loading and sync logic as before)
  const setPlaying = on => { p.playing = on; setPlayingState(on); Object.values(p.vids).forEach(v => { if (v.src) on ? v.play().catch(() => {}) : v.pause(); }); };
  const onTime = () => { const x = posNow(); if (!p.seeking) setPos(x); p.onPos(x); syncCams(); };
  const syncCams = (force = false) => {
    const m = p.master; if (!m || m.seeking) return;
    const now = performance.now(), rate = p.speed;
    Object.values(p.vids).forEach(v => {
      if (v === m || !v.src || v.seeking || v.readyState < 2) return;
      const d = v.currentTime - m.currentTime, ad = Math.abs(d);
      if (force && ad > 0.05) { v.currentTime = m.currentTime; v.playbackRate = rate; }
      else if (ad > Math.max(1, rate * 0.75)) { if (now - (v._jumped || 0) > 2000) { v._jumped = now; v.currentTime = Math.min(m.currentTime + (p.playing ? rate * 0.25 : 0), (v.duration || 60) - 0.1); } v.playbackRate = rate; }
      else if (ad > 0.08 && p.playing) v.playbackRate = rate * (d > 0 ? 0.93 : 1.07);
      else v.playbackRate = rate;
      if (p.playing && v.paused && !v.ended) v.play().catch(() => {});
    });
  };
  const loadSegment = (i, offset = 0, autoplay = p.playing) => {
    if (i < 0 || i >= segs.length) { setPlaying(false); return; }
    p.idx = i; setIdx(i);
    const seg = segs[i]; p.master = null;
    for (const cam of CAMS) {
      const v = p.vids[cam], src = seg.cameras[cam];
      if (src) { if (!p.master) p.master = v; v.src = camSrc(cam, src); v.playbackRate = p.speed; } else { v.removeAttribute("src"); v.load(); }
    }
    const m = p.master; if (!m) { onTime(); return; }
    m.onloadedmetadata = () => { setTick(t => t + 1); const off = Math.min(offset, (m.duration || 60) - 0.1); Object.values(p.vids).forEach(v => { if (v.src) v.currentTime = off; }); if (autoplay) setPlaying(true); onTime(); };
    m.ontimeupdate = onTime;
    m.onended = () => { if (p.idx + 1 < segs.length) loadSegment(p.idx + 1, 0, true); else setPlaying(false); };
  };
  const seekTo = s => {
    s = Math.max(0, Math.min(s, total - 0.1));
    const i = Math.min(Math.floor(s / 60), segs.length - 1), off = s - i * 60;
    setPos(s);
    if (i === p.idx && p.master?.duration) { Object.values(p.vids).forEach(v => { if (v.src) v.currentTime = off; }); onTime(); } else loadSegment(i, off);
  };
  const stepFrame = dir => { setPlaying(false); const m = p.master; if (!m) return; const t = Math.max(0, Math.min(m.currentTime + dir / FPS, (m.duration || 60) - 0.01)); Object.values(p.vids).forEach(v => { if (v.src) v.currentTime = t; }); setTimeout(onTime, 80); };
  const setSpeed = s => { p.speed = s; setSpeedState(s); Object.values(p.vids).forEach(v => v.playbackRate = s); };
  const swapInto = cam => {
    if (cam === "front") p.slots = { ...DEFAULT_SLOTS };
    else { const from = SLOTS.find(s => p.slots[s] === cam); if (from === "big") return; p.slots = { ...p.slots, [from]: p.slots.big, big: cam }; }
    setSlots(p.slots); setTimeout(() => syncCams(true), 0);
  };
  // the videos live outside React; put each one in its tile whenever the arrangement changes (moving a playing video keeps it playing)
  useEffect(() => { SLOTS.forEach(s => { const tile = tiles.current[s], v = p.vids[slots[s]]; if (tile && v.parentElement !== tile) tile.insertBefore(v, tile.firstChild); }); }, [slots]);
  useEffect(() => {
    if (encrypted) return;
    loadSegment(Math.floor(startAt / 60), startAt % 60, false);
    const keys = e => {                                       // Space play/pause · arrows 10 seconds · , . one frame · 1-6 choose the big camera
      if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName) && e.target.type !== "range") return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const onSlider = e.target.getAttribute?.("role") === "slider" || e.target.type === "range";
      if (e.key === " ") { if (e.target.tagName === "BUTTON" || e.target.tagName === "A") return; e.preventDefault(); setPlaying(!p.playing); }
      else if (e.key === "ArrowRight" && !onSlider) { e.preventDefault(); seekTo(posNow() + 10); }
      else if (e.key === "ArrowLeft" && !onSlider) { e.preventDefault(); seekTo(posNow() - 10); }
      else if (e.key === ".") stepFrame(1); else if (e.key === ",") stepFrame(-1);
      else if (/^[1-6]$/.test(e.key)) swapInto(CAMS[+e.key - 1]);
    };
    document.addEventListener("keydown", keys);
    const watchdog = setInterval(() => {
      const m = p.master; if (!m || !p.playing || m.seeking) { p.stall = 0; return; }
      if (Math.abs(m.currentTime - p.lastT) < 0.01 && !m.ended) { p.stall++; if (p.stall === 2) Object.values(p.vids).forEach(v => { if (v.src) v.play().catch(() => {}); }); if (p.stall === 5) { p.stall = 0; loadSegment(p.idx, m.currentTime, true); } } else p.stall = 0;
      p.lastT = m.currentTime; syncCams();
    }, 1000);
    return () => { document.removeEventListener("keydown", keys); clearInterval(watchdog); if (document.fullscreenElement) document.exitFullscreen?.(); Object.values(p.vids).forEach(v => { v.pause(); v.removeAttribute("src"); v.load(); }); p.master = null; };
  }, []);   // eslint-disable-line

  const seg = segs[idx], bigV = p.vids[slots.big], ratio = bigV?.videoWidth ? `${bigV.videoWidth} / ${bigV.videoHeight}` : "1.6";
  const missing = cam => !(seg && seg.cameras && seg.cameras[cam]);
  const missText = upState(live).up && seg && Date.now() - parseT(seg.start) < 6 * 3600e3 ? "Uploading…" : "No footage";
  const shownPos = scrub ?? pos, clock = t12(wallAt(shownPos), true);
  const lab = { position: "absolute", left: 8, top: 8, background: "rgba(0,0,0,.7)", color: "#fff", zIndex: 2 };
  const fullScreen = () => { const st = stageRef.current; if (document.fullscreenElement) document.exitFullscreen?.(); else st.requestFullscreen?.().catch(() => {}); };
  if (encrypted) return <div style={{ flex: 1, display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px", gap: 20, minHeight: 0 }} className="plgrid">
    <Card style={{ padding: "28px 24px", gap: 4, alignItems: "center", textAlign: "center", alignSelf: "start" }}><Text className="display" size={500} weight="semibold">This footage is encrypted</Text><Text size={300} style={muted}>View it at dashcam.tesla.com with the original files.</Text></Card>
    <PlayerMap clip={clip} segs={segs} P={p} onSeek={() => {}} C={C} /></div>;
  return <div style={{ flex: 1, display: "grid", gridTemplateColumns: "minmax(0,1fr) 400px", gap: 20, minHeight: 0, alignItems: "start" }} className="plgrid">
    <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0 }}>
      <div ref={stageRef} className="stage" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div ref={el => tiles.current.big = el} className="tile big" style={{ position: "relative", aspectRatio: ratio, maxHeight: "calc(100vh - 330px)", minHeight: 220, borderRadius: T.borderRadiusXLarge, background: "#000", boxShadow: T.shadow8, overflow: "hidden" }}>
          <Badge style={lab} appearance="filled" shape="rounded" size="large">{CAM_SHORT[slots.big]}</Badge>
          {missing(slots.big) && <span className="miss">{missText}</span>}
          <Button className="fsbtn" appearance="subtle" icon={<FullScreenMaximize20Regular />} aria-label="Full screen" title="Full screen" onClick={fullScreen} style={{ position: "absolute", right: 8, top: 8, zIndex: 2, color: "#fff", background: "rgba(0,0,0,.5)" }} /></div>
        <div className="plstrip" style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 8 }}>{SLOTS.slice(1).map(s => <div key={s} ref={el => tiles.current[s] = el} className="tile" role="button" tabIndex={0} title="Click to make this camera big" aria-label={`Show the ${CAM_NAMES[slots[s]].toLowerCase()} camera big`}
          onClick={e => { swapInto(slots[s]); if (e.detail) e.currentTarget.blur(); }} onKeyDown={e => { if (e.key === "Enter") swapInto(slots[s]); }}
          style={{ position: "relative", aspectRatio: "1.6", borderRadius: T.borderRadiusLarge, background: "#222", overflow: "hidden", cursor: "pointer" }}>
          <Badge style={{ ...lab, left: 6, top: 6 }} appearance="filled" shape="rounded">{CAM_SHORT[slots[s]]}</Badge>{missing(slots[s]) && <span className="miss">{missText}</span>}</div>)}</div>
      </div>
      <Card className="plbar" style={{ flexDirection: "row", alignItems: "center", gap: 14, padding: "8px 14px", marginTop: 4 }}>
        <Button appearance="primary" shape="circular" size="large" icon={playing ? <Pause24Filled /> : <Play24Filled />} aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying(!playing)} />
        <Text className="plclock" size={300} weight="semibold" style={{ flex: "none", minWidth: 96, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{clock}</Text>
        <div className="plseek" style={{ flex: 1, position: "relative", display: "flex", minWidth: 0 }} onPointerUp={() => { if (scrub != null) { p.seeking = false; seekTo(scrub); setScrub(null); } }} onKeyUp={() => { if (scrub != null) { p.seeking = false; seekTo(scrub); setScrub(null); } }}>
          <Slider min={0} max={total} step={0.1} value={shownPos} aria-label="Playback position" aria-valuetext={`${clock}, ${Math.floor(shownPos / 60)} of ${Math.round(total / 60)} minutes`} style={{ flex: 1 }}
            onChange={(e, dd) => { p.seeking = true; setScrub(dd.value); }} />
          <div aria-hidden="true" style={{ position: "absolute", left: 10, right: 10, top: "50%", height: 0, pointerEvents: "none" }}>{marks.filter(m => m.t >= 0 && m.t <= total).map((m, i) => <span key={i} title={m.label} style={{ position: "absolute", left: `${m.t / total * 100}%`, top: -5, width: 10, height: 10, marginLeft: -5, borderRadius: "50%", background: m.kind === "sentry" ? C.AMBER : C.GREEN, border: "2px solid #fff", boxShadow: T.shadow2 }} />)}</div>
        </div>
        <Text className="plend" size={300} style={muted}>{t12(wallAt(total - 1))}</Text>
        <Menu checkedValues={{ speed: [String(speed)] }} onCheckedValueChange={(e, dd) => setSpeed(+dd.checkedItems[0])}>
          <MenuTrigger disableButtonEnhancement><Button appearance="outline" icon={<ChevronDown16Regular />} iconPosition="after" title="Playback speed">{speed}×</Button></MenuTrigger>
          <MenuPopover><MenuList>{SPEEDS.map(s => <MenuItemRadio key={s} name="speed" value={String(s)}>{s}×</MenuItemRadio>)}</MenuList></MenuPopover></Menu>
      </Card>
      <Text className="plhint" size={200} style={{ ...muted, padding: "0 4px" }}>Space plays and pauses · ← → skip 10 seconds · , . step a frame · 1–6 pick the big camera</Text>
    </div>
    <PlayerMap clip={clip} segs={segs} P={p} onSeek={seekTo} C={C} />
  </div>;
}

// ---------------------------------------------------------------- the map: where the car was while the footage plays, from the GPS in the video
const AP_WORDS = { fsd: "FSD", autosteer: "Autosteer", tacc: "Cruise control" };
const pmDist = (a, b) => { const R = 3958.8, r = Math.PI / 180, dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r; const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); };
function PlayerMap({ clip, segs, P, onSeek, C }) {
  const box = useRef(), M = useRef({}), carRef = useRef(), playedRef = useRef();
  const [st, setSt] = useState({ pts: [], miles: 0, done: false, cum: [] });
  const [hud, setHud] = useState(null);                       // {mph, gear, ap, i}
  const [follow, setFollow] = useState(true), [posX, setPosX] = useState(0), [status, setStatus] = useState("Reading location…");
  const total = segs.length * 60, W = 352, H = 96;
  const stRef = useRef(st); stRef.current = st;
  const followRef = useRef(true);
  useEffect(() => {
    let dead = false, token = {};
    const pts = [];
    api("/api/config").catch(() => ({})).then(async cfg => {
      if (dead || !box.current) return;
      const map = L.map(box.current, { zoomControl: true, attributionControl: true, keyboard: false });
      map.zoomControl.setPosition("topright"); map.attributionControl.setPrefix(false);
      streetLayer(cfg).addTo(map);
      map.setView(clip.lat && clip.lon ? [clip.lat, clip.lon] : [36.04, -115.03], clip.lat ? 15 : 10);
      const route = L.polyline([], { color: C.MAPLINE, weight: 5, opacity: 0.9, lineCap: "round" }).addTo(map);
      const played = L.polyline([], { color: C.BRAND, weight: 5, lineCap: "round", interactive: false }).addTo(map);
      const car = L.marker([0, 0], { icon: L.divIcon({ className: "pm-caricon", html: `<span class="pm-car" style="color:${C.BRAND}"><svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M12 2 20 21 12 16.5 4 21Z" fill="currentColor" stroke="#FFF" stroke-width="1.6" stroke-linejoin="round"/></svg></span>`, iconSize: [30, 30], iconAnchor: [15, 15] }), keyboard: false, interactive: false });
      map.on("dragstart", () => { followRef.current = false; setFollow(false); });
      route.on("click", e => {                                // jump the video to the nearest point of the route
        let best = null, bd = Infinity; const now = P.idx * 60 + (P.master?.currentTime || 0), tol = 1e-9;
        stRef.current.pts.forEach(q => { const d = (q.lat - e.latlng.lat) ** 2 + ((q.lon - e.latlng.lng) * Math.cos(q.lat * Math.PI / 180)) ** 2; if (d < bd - tol || (Math.abs(d - bd) <= tol && Math.abs(q.pos - now) < Math.abs(best.pos - now))) { if (d < bd) bd = d; best = q; } });
        if (best) { followRef.current = true; setFollow(true); onSeek(best.pos); }
      });
      M.current = { map, route, played, car, fitted: false };
      setTimeout(() => map.invalidateSize(), 50);
      // read the tracks in batches, starting with the part being played
      const keys = segs.map(s => s.key), B = 8, first = Math.floor(P.idx / B) * B;
      const starts = [...Array(Math.ceil(keys.length / B)).keys()].map(k => k * B).sort((x, y) => (x === first ? -1 : y === first ? 1 : x - y));
      for (const s of starts) {
        let res; try { res = await api(`/api/gps?keys=${encodeURIComponent(keys.slice(s, s + B).join(","))}`); } catch (e) { res = {}; }
        if (dead) return;
        keys.slice(s, s + B).forEach((k, j) => (res[k] || []).forEach(q => pts.push({ ...q, pos: (s + j) * 60 + q.t })));
        pts.sort((x, y) => x.pos - y.pos);
        if (pts.length) {
          const lines = [[]]; pts.forEach((q, i) => { if (i && q.pos - pts[i - 1].pos > 5) lines.push([]); lines[lines.length - 1].push([q.lat, q.lon]); });
          route.setLatLngs(lines);
          if (!M.current.fitted) { M.current.fitted = true; map.fitBounds(route.getBounds(), { padding: [28, 28], maxZoom: 16 }); }
          const cum = []; let m = 0; pts.forEach((q, i) => { if (i && q.pos - pts[i - 1].pos <= 5) m += pmDist(pts[i - 1], q); cum.push(m); });
          setSt({ pts: [...pts], miles: m, cum, done: false });
        }
      }
      if (pts.length) { map.fitBounds(route.getBounds(), { padding: [28, 28], maxZoom: 16 }); setSt(x => ({ ...x, done: true })); }
      else if (clip.lat && clip.lon) {                         // parked clips have no track, but Saved / Sentry clips have a location
        L.circleMarker([clip.lat, clip.lon], { radius: 9, color: "#FFF", weight: 3, fillColor: clip.type === "sentry" ? C.AMBER : C.GREEN, fillOpacity: 1 }).addTo(map);
        map.setView([clip.lat, clip.lon], 16); setStatus(`Where the car was parked${clip.city ? ` · ${clip.city}` : ""}`); setHud({ parked: true }); setSt(x => ({ ...x, done: true }));
      } else { setStatus(""); setSt(x => ({ ...x, done: true, none: true })); }
    });
    return () => { dead = true; if (M.current.map) M.current.map.remove(); M.current = {}; };
  }, []);   // eslint-disable-line
  // move the car to where it was at this moment of the video
  useEffect(() => {
    P.onPos = pos => {
      const { map, car, played } = M.current, pts = stRef.current.pts; if (!map || !pts.length) return;
      setPosX(Math.min(pos, total) / total);
      let lo = 0, hi = pts.length - 1;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (pts[mid].pos <= pos) lo = mid; else hi = mid - 1; }
      const a = pts[lo], b = pts[lo + 1], near = Math.abs(a.pos - pos) <= 5 || (b && b.pos - pos <= 5 && pos >= a.pos);
      if (!near || pos < pts[0].pos - 5) { if (car._map) car.remove(); setHud({ none: true }); return; }
      let lat = a.lat, lon = a.lon;
      if (b && pos > a.pos && b.pos - a.pos <= 5) { const f = (pos - a.pos) / (b.pos - a.pos); lat += (b.lat - a.lat) * f; lon += (b.lon - a.lon) * f; }
      if (!car._map) car.addTo(map);
      car.setLatLng([lat, lon]);
      const el = car.getElement()?.querySelector(".pm-car"); if (el) el.style.transform = `rotate(${a.hdg || 0}deg)`;
      if (followRef.current && !map.getBounds().pad(-0.2).contains([lat, lon])) map.panTo([lat, lon], { animate: true, duration: 0.6 });
      if (lo !== M.current.lastI) {                            // once a second is enough for the text and the played part of the route
        M.current.lastI = lo;
        const done = [[]]; for (let i = 0; i <= lo; i++) { if (i && pts[i].pos - pts[i - 1].pos > 5) done.push([]); done[done.length - 1].push([pts[i].lat, pts[i].lon]); }
        done[done.length - 1].push([lat, lon]); played.setLatLngs(done);
        setHud({ mph: a.mph, gear: a.gear, ap: a.ap, i: lo });
      }
    };
    return () => { P.onPos = () => {}; };
  }, [total]);   // eslint-disable-line
  useEffect(() => { if (st.pts.length) P.onPos(P.idx * 60 + (P.master?.currentTime || 0)); }, [st.pts.length]);   // eslint-disable-line
  const top = st.pts.reduce((a, q) => Math.max(a, q.mph || 0), 0), max = Math.max(top, 10) * 1.12;
  const chart = useMemo(() => {
    const x = pos => (pos / total * W).toFixed(1), y = v => (H - 1 - (v || 0) / max * (H - 4)).toFixed(1), runs = [[]];
    st.pts.forEach((q, i) => { if (i && q.pos - st.pts[i - 1].pos > 5) runs.push([]); runs[runs.length - 1].push(q); });
    return { ln: runs.filter(r => r.length).map(r => "M" + r.map(q => `${x(q.pos)} ${y(q.mph)}`).join("L")).join(""),
      ar: runs.filter(r => r.length).map(r => `M${x(r[0].pos)} ${H}` + r.map(q => `L${x(q.pos)} ${y(q.mph)}`).join("") + `L${x(r[r.length - 1].pos)} ${H}Z`).join("") };
  }, [st.pts, max, total]);
  const f = v => v.toFixed(v < 10 ? 1 : 0);
  const miles = st.done && st.miles >= 0.1 ? `${f(hud?.i >= 0 ? st.cum[hud.i] : 0)} of ${f(st.miles)} miles` : st.done ? status : "Reading location…";
  const hudBox = { position: "absolute", left: 12, top: 12, zIndex: 500, display: "flex", alignItems: "center", gap: 8, padding: "6px 10px 6px 14px", borderRadius: T.borderRadiusMedium, background: T.colorNeutralBackground1, boxShadow: T.shadow8 };
  return <Card style={{ padding: 0, gap: 0, alignSelf: "start", overflow: "hidden" }} className="plmap">
    <div className="plmapbox" style={{ position: "relative", height: 460 }}>
      <div ref={box} className="gray" style={{ position: "absolute", inset: 0 }} aria-hidden="true" />
      {hud && <div style={hudBox}>{hud.parked ? <Text className="display" size={500} weight="semibold">Parked</Text> : hud.none ? <Text size={300} style={muted}>No location here</Text>
        : <>{hud.gear === "R" ? <Text className="display" size={500} weight="semibold">Reversing</Text> : hud.gear === "P" ? <Text className="display" size={500} weight="semibold">Parked</Text> : <><Text className="display" size={700} weight="semibold">{Math.round(hud.mph)}</Text><Text size={300} style={muted}>mph</Text></>}
          {hud.gear && hud.gear !== "R" && hud.gear !== "P" && <Badge appearance="filled" color="informative" shape="rounded" size="large">{hud.gear}</Badge>}
          {AP_WORDS[hud.ap] && <Badge appearance="filled" color="brand" shape="rounded" size="large">{AP_WORDS[hud.ap]}</Badge>}</>}</div>}
      {st.none && <div style={{ position: "absolute", inset: 0, zIndex: 500, display: "grid", placeItems: "center", padding: 24, background: T.colorNeutralBackground1 }}><div style={{ textAlign: "center", maxWidth: 300 }}><Text size={400} weight="semibold" block>No location in this footage</Text><Text size={300} style={muted}>The car records its position in the video while driving, on software from December 2025 on. Footage recorded while parked, or before that update, has none.</Text></div></div>}
      {!follow && st.pts.length > 0 && <Button icon={<Target20Regular />} size="small" onClick={() => { followRef.current = true; setFollow(true); const { map, car } = M.current; if (car?._map) map.panTo(car.getLatLng()); }} style={{ position: "absolute", left: 12, bottom: 12, zIndex: 500, boxShadow: T.shadow4 }}>Follow the car</Button>}
    </div>
    {st.pts.length > 0 && <div style={{ padding: "14px 18px 12px", borderTop: `1px solid ${T.colorNeutralStroke2}` }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><Text size={400} weight="semibold">Speed</Text><Text size={300} style={muted}>Top {Math.round(top)} mph</Text></div>
      <svg viewBox={`0 0 ${W} ${H + 2}`} width="100%" height={H + 2} preserveAspectRatio="none" role="img" aria-label={`Speed during this drive, top speed ${Math.round(top)} mph. Click to jump to that moment.`} style={{ cursor: "pointer", display: "block" }}
        onClick={e => { const r = e.currentTarget.getBoundingClientRect(); onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * total); }}>
        <path d={chart.ar} fill={T.colorNeutralBackground3} /><path d={chart.ln} fill="none" stroke={T.colorNeutralForeground2} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <line x1={posX * W} x2={posX * W} y1="0" y2={H} stroke={T.colorBrandStroke1} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}><Text size={200} style={{ color: T.colorNeutralForeground3 }}>{t12(parseT(segs[0].start))}</Text><Text size={200} style={{ color: T.colorNeutralForeground3 }}>{miles}</Text><Text size={200} style={{ color: T.colorNeutralForeground3 }}>{t12(parseT(segs[segs.length - 1].start))}</Text></div>
    </div>}
    {!st.pts.length && <div style={{ padding: "10px 18px", borderTop: `1px solid ${T.colorNeutralStroke2}` }}><Text size={300} style={muted} role="status">{miles}</Text></div>}
  </Card>;
}
