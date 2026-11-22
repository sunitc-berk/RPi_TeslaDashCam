// Shared helpers: the API, dates and words, the live upload state, the Keep store, the still-frame grabber, the router.
import { useEffect, useState, useSyncExternalStore } from "react";

export const api = async (url, opts) => {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
};
export const post = (url, body) => api(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const media = p => p ? "/media/" + p.split("/").map(encodeURIComponent).join("/") : "";
export const pad = n => String(n).padStart(2, "0");
export const WD = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
export const MO = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const wd3 = d => WD[d.getDay()].slice(0, 3), mo3 = d => MO[d.getMonth()].slice(0, 3);
export const MINUS = "−";
export const CAMS = ["front", "back", "left_pillar", "right_pillar", "left_repeater", "right_repeater"];   // camera numbers 1-6
export const CAM_NAMES = { front: "Front", back: "Back", left_pillar: "Left pillar", right_pillar: "Right pillar", left_repeater: "Left repeater", right_repeater: "Right repeater" };
export const CAM_SHORT = { front: "Front", back: "Back", left_pillar: "Left pillar", right_pillar: "Right pillar", left_repeater: "Left rear", right_repeater: "Right rear" };
const WHY = {                                           // why the car saved a clip, in plain words
  sentry_aware_object_detection: "Something came close", sentry_aware_accel: "Bump or movement", sentry_locked_handle_pulled: "Door handle pulled",
  user_interaction_honk: "Honk", user_interaction_dashcam_icon_tapped: "Dashcam button", user_interaction_dashcam_panel_save: "Saved from the viewer",
  user_interaction_dashcam_launcher_action_tapped: "Dashcam button", vehicle_auto_emergency_braking: "Emergency braking",
};
export const whyText = r => WHY[r] || (r ? r.replace(/^(sentry_aware_|user_interaction_|vehicle_)/, "").replace(/_/g, " ") : "");

// ---------------------------------------------------------------- dates and formatting
export const parseT = s => s ? new Date(String(s).replace(" ", "T")) : null;          // "2026-11-02 05:39:00" -> local Date
export const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const hm = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : "";
export const hms = d => d ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` : "";
export const todayStr = () => ymd(new Date());
export const plural = (n, w, pl) => `${n} ${n === 1 ? w : pl || w + "s"}`;
export const addDays = (s, n) => { const d = parseT(s + " 12:00:00"); d.setDate(d.getDate() + n); return ymd(d); };
export const dayLong = s => { const d = parseT(s + " 12:00:00"); return `${WD[d.getDay()]}, ${MO[d.getMonth()]} ${d.getDate()}`; };   // Tuesday, November 3
export const dayMid = s => { const d = parseT(s + " 12:00:00"); return `${WD[d.getDay()]}, ${mo3(d)} ${d.getDate()}`; };            // Tuesday, Nov 3
export const fmtDur = s => { s = Math.round((s || 0) / 60); return s < 60 ? `${s} min` : `${Math.floor(s / 60)} h ${pad(s % 60)} m`; };
export const gbNum = b => (b || 0) / 1e9;
export const fmtGB1 = b => gbNum(b).toFixed(1) + " GB";
export const fmtB = b => b == null ? "–" : b >= 1e9 ? (b / 1e9).toFixed(b >= 1e11 ? 0 : 1) + " GB" : Math.round(b / 1e6) + " MB";
export const ago = s => s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 172800 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} days`;
// 12-hour clock ("1:02 pm", "1:02 – 1:17 pm")
export const t12 = (d, secs = false) => { if (!d) return ""; const h = d.getHours(); return `${h % 12 || 12}:${pad(d.getMinutes())}${secs ? ":" + pad(d.getSeconds()) : ""} ${h < 12 ? "am" : "pm"}`; };
export const range12 = (a, b) => { const A = t12(a), B = t12(b); return A.slice(-2) === B.slice(-2) ? `${A.slice(0, -3)} – ${B}` : `${A} – ${B}`; };
export const durWords = s => { const m = Math.max(1, Math.round((s || 0) / 60)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}`; };
export const milesText = v => `${v < 10 ? (+v).toFixed(1) : Math.round(v)} mi`;
export const gbText = mb => mb >= 1000 ? `${(mb / 1000).toFixed(mb >= 100000 ? 0 : 1)} GB` : `${Math.round(mb)} MB`;
export const signed = n => n == null ? "–" : (n < 0 ? MINUS + Math.abs(n) : String(n));
export const cap1 = s => s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
// "Today" / "Yesterday" / "Wednesday" (this week) / "October 10"
export function dayLabel(s) {
  const d = parseT(s + " 12:00:00"), n = Math.round((parseT(todayStr() + " 12:00:00") - d) / 864e5);
  const date = `${MO[d.getMonth()]} ${d.getDate()}${d.getFullYear() !== new Date().getFullYear() ? ", " + d.getFullYear() : ""}`;
  if (n === 0) return { big: "Today", rest: `${WD[d.getDay()]}, ${date}` };
  if (n === 1) return { big: "Yesterday", rest: `${WD[d.getDay()]}, ${date}` };
  if (n > 1 && n < 7) return { big: WD[d.getDay()], rest: date };
  return { big: date, rest: WD[d.getDay()] };
}
// "today at 1:17 pm" / "yesterday at ..." / "Saturday at ..." / "Nov 2 at ..."
export function whenWords(iso) {
  const d = new Date(iso); if (isNaN(d)) return "";
  const n = Math.round((parseT(todayStr() + " 12:00:00") - parseT(ymd(d) + " 12:00:00")) / 864e5);
  const day = n === 0 ? "today" : n === 1 ? "yesterday" : n > 1 && n < 7 ? WD[d.getDay()] : `${mo3(d)} ${d.getDate()}`;
  return `${day} at ${t12(d)}`;
}

// ---------------------------------------------------------------- items of the footage list
export function itemTitle(it) {
  if (it.type === "drive") {
    const f = it.frm?.name, t = it.to?.name;
    if (f && t) return f === t ? (it.frm.home ? "Loop from home" : `Around ${t}`) : `${f} → ${t}`;
    if (it.frm?.home) return "From home";
    if (it.to?.home) return "Back home";
    return t ? `To ${t}` : f ? `From ${f}` : "Drive";
  }
  if (it.type === "parked") return `Parked ${durWords(it.dur)}`;
  if (it.type === "sentry") return it.count > 1 ? `${it.count} Sentry alerts` : "Sentry alert";
  return "Saved clip";
}
export const placeText = pl => !pl || !pl.name ? "" : pl.home ? "at home" : `${pl.name}${pl.city && pl.city !== pl.name ? ", " + pl.city : ""}`;
export const itemHref = (it, t) => it.trip ? `#/player?trip=${encodeURIComponent(it.trip)}&a=${it.a}&b=${it.b}${t ? "&t=" + t : ""}` : `#/player?event=${encodeURIComponent(it.id)}`;
export function clipOf(r) {
  const isTrip = r.id?.startsWith("trip-") || r.item_type === "trip" || (!r.kind && r.duration_s != null && !r.timestamp);
  const type = r.type && ["trip", "parked", "saved", "sentry"].includes(r.type) ? r.type : isTrip ? (r.place === "home" ? "parked" : "trip") : r.kind;
  const start = r.start || r.timestamp, end = r.end || r.timestamp;
  let dur = r.duration_s;
  if (dur == null && start && end) dur = (parseT(end) - parseT(start)) / 1000;
  return { id: r.id, itemType: isTrip ? "trip" : "event", type, start, end, dur: dur || 0, favorite: !!r.favorite, encrypted: !!r.encrypted,
    city: r.city, street: r.street, reason: r.reason, lat: r.lat, lon: r.lon, timestamp: r.timestamp };
}

// ---------------------------------------------------------------- a tiny store: subscribe / set / useStore
export function makeStore(init) {
  let state = init; const subs = new Set();
  return {
    get: () => state,
    set: patch => { state = { ...state, ...(typeof patch === "function" ? patch(state) : patch) }; subs.forEach(f => f()); },
    sub: f => { subs.add(f); return () => subs.delete(f); },
  };
}
export const useStore = s => useSyncExternalStore(s.sub, s.get);

// ---------------------------------------------------------------- Keep (favorites): every copy of a clip on screen agrees
export const FAV = makeStore({});            // id -> true / false
export const isKept = (id, fallback) => { const v = FAV.get()[id]; return v == null ? !!fallback : v; };
export async function toggleKeep(id, itemType, current) {
  const on = !isKept(id, current);
  FAV.set({ [id]: on });                    // update right away, undo if the save fails
  try {
    if (on) await post("/api/favorites", { item_type: itemType, item_id: id });
    else await api(`/api/favorites/${itemType}/${encodeURIComponent(id)}`, { method: "DELETE" });
    toast(on ? "Kept. This footage will not be removed." : "No longer kept.");
    BUS.dispatchEvent(new CustomEvent("favchange", { detail: { id, on } }));
  } catch (e) { FAV.set({ [id]: !on }); toast("Could not save that. Try again.", "error"); }
}

// ---------------------------------------------------------------- messages to the person (the shell shows them)
export const BUS = new EventTarget();
export const toast = (text, intent = "success") => BUS.dispatchEvent(new CustomEvent("toast", { detail: { text, intent } }));

// ---------------------------------------------------------------- theme
export const THEME = makeStore({ dark: (() => { try { return localStorage.getItem("theme") === "dark"; } catch (e) { return false; } })() });
export function setDark(dark) { THEME.set({ dark }); try { localStorage.setItem("theme", dark ? "dark" : "light"); } catch (e) {} }

// ---------------------------------------------------------------- live upload status and the Pi's diagnostics (polled for every page)
export const LIVE = makeStore({ now: null, fetched: 0, diag: null, lostEvents: [], lastUploadProblem: null });
const staleAfter = st => st.state === "uploading" ? Math.max(180, (st.batch_bytes || 4e8) / Math.max(st.rate_bps || 1e6, 2e5) + 120) : 330;
export function upState(live = LIVE.get()) {               // {st, fresh, up, pct, bytes}
  const st = live.now?.status;
  if (!st) return { st: null, fresh: false, up: false };
  const age = (st.age_s || 0) + (Date.now() - live.fetched) / 1000;
  const fresh = age < staleAfter(st);
  const extra = st.rate_bps ? Math.min(st.batch_bytes || 0, st.rate_bps * ((Date.now() - live.fetched) / 1000 + (st.age_s || 0))) : 0;
  const bytes = Math.min(st.bytes_total || 0, (st.bytes_done || 0) + extra);
  return { st, fresh, up: fresh && st.state === "uploading", age, bytes, pct: st.bytes_total ? bytes / st.bytes_total * 100 : 0 };
}
export async function pollLive() {
  try { const now = await api("/api/live"); LIVE.set({ now, fetched: Date.now() }); } catch (e) { /* keep the last values */ }
}
export async function pollDiag() {
  try {
    const [diag, ev] = await Promise.all([api("/api/diag/summary?hours=48"), api("/api/diag/events?limit=400&problems_only=true")]);
    LIVE.set({ diag, lostEvents: ev.filter(e => e.title.startsWith("FOOTAGE LOST")), lastUploadProblem: ev.find(e => e.title.startsWith("UPLOAD PROBLEM"))?.time || null });
  } catch (e) { /* keep the last values */ }
}
export function parseLost(e) {                            // "FOOTAGE LOST: deleted 19 never-uploaded TRIP segments (876 MB) ..."
  const m = /deleted (\d+) never-uploaded (.+?) segments \((\d+) MB\)/.exec(e.title || "");
  return m ? { segs: +m[1], what: m[2], mb: +m[3], away: /TRIP/i.test(m[2]) } : { segs: 0, mb: 0, what: "" };
}
// the state shown at the foot of the navigation: upload state only (problems are on the Pi page)
export function pillState(live) {
  const u = upState(live);
  if (u.up) return { kind: "up", text: `Uploading ${Math.floor(u.pct)}%`, pct: u.pct, title: "Footage is uploading from the car" };
  const w = u.st?.waiting || {}, wb = (w.recent_bytes || 0) + (w.event_bytes || 0);
  if (u.st && wb >= 5e7) return { kind: "wait", text: `${fmtB(wb)} waiting`, title: "Footage on the Pi is waiting to upload" };
  return u.st ? { kind: "ok", text: "Up to date", title: "Everything on the Pi has been uploaded" } : { kind: "none", text: "No status", title: "The Pi has not reported yet" };
}
// one-line summary used on the Pi page ("Uploading 41%, 23.5 GB to go, Pi online 39.9 °C")
export function statusLine(live) {
  const u = upState(live);
  if (!u.st) return { lead: "No live status", rest: "Pi has not reported yet" };
  const temp = u.st.cpu_temp_c != null ? `${(+u.st.cpu_temp_c).toFixed(1)} °C` : "";
  if (u.up) return { lead: `Uploading ${Math.floor(u.pct)}%`, rest: `${fmtB(u.st.bytes_total - u.bytes)} to go, Pi online ${temp}` };
  if (!u.fresh) return { lead: "Pi away or asleep", rest: `last heard ${ago(u.age)} ago` };
  const w = u.st.waiting || {}, wb = (w.recent_bytes || 0) + (w.event_bytes || 0);
  return { lead: wb < 5e7 ? "All caught up" : `${fmtB(wb)} waiting`, rest: `Pi online ${temp}` };
}

// ---------------------------------------------------------------- pictures for the list: one frame of the front camera, read from the video
// in the browser when its row scrolls into view (a page full of <video> tags would open dozens of files and run out of players).
const STILLS = new Map(), stillQ = []; let stillBusy = 0;
function grabStill(src, at = 20) {
  return new Promise(done => {
    const v = document.createElement("video"); let over = false;
    const fin = url => { if (over) return; over = true; clearTimeout(timer); v.removeAttribute("src"); try { v.load(); } catch (e) {} done(url); };
    const timer = setTimeout(() => fin(""), 15000);
    const draw = (tries = 0) => {
      try {
        const w = 320, h = Math.round(w * v.videoHeight / v.videoWidth) || 180, c = document.createElement("canvas");
        c.width = w; c.height = h;
        const g = c.getContext("2d"); g.drawImage(v, 0, 0, w, h);
        const px = g.getImageData(0, 0, w, h).data; let sum = 0;
        for (let i = 0; i < px.length; i += 388) sum += px[i] + px[i + 1] + px[i + 2];
        if (!sum && tries < 8) { setTimeout(() => draw(tries + 1), 150); return; }   // the frame is not painted yet
        fin(c.toDataURL("image/jpeg", .74));
      } catch (e) { fin(""); }
    };
    v.muted = true; v.playsInline = true; v.preload = "metadata";
    v.onloadedmetadata = () => { v.currentTime = Math.min(at, (v.duration || at * 2) / 2); };
    v.onseeked = () => v.readyState >= 2 ? draw() : v.addEventListener("canplay", () => draw(), { once: true });
    v.onerror = () => fin("");
    v.src = src;
  });
}
function pumpStills() {
  while (stillBusy < 3 && stillQ.length) {
    const { src, cb } = stillQ.shift();
    if (STILLS.has(src)) { cb(STILLS.get(src)); continue; }
    stillBusy++;
    grabStill(src).then(url => { STILLS.set(src, url); cb(url); }).finally(() => { stillBusy--; pumpStills(); });
  }
}
const stillObserver = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(es => es.forEach(e => {
  if (e.isIntersecting) { stillObserver.unobserve(e.target); const r = e.target._still; if (r) { stillQ.push(r); pumpStills(); } }
}), { rootMargin: "300px" }) : null;
export function useStill(path) {                            // -> {ref, url}; url "" while loading, null if the browser could not read it
  const src = media(path);
  const [url, setUrl] = useState(() => (src && STILLS.get(src)) ?? "");
  const [el, setEl] = useState(null);
  useEffect(() => {
    if (!el || !src) return;
    if (STILLS.has(src)) { setUrl(STILLS.get(src) || null); return; }
    let alive = true;
    el._still = { src, cb: u => { if (alive) setUrl(u || null); } };
    if (stillObserver) stillObserver.observe(el); else { stillQ.push(el._still); pumpStills(); }
    return () => { alive = false; stillObserver?.unobserve(el); };
  }, [el, src]);
  return { ref: setEl, url };
}

// ---------------------------------------------------------------- the router (hash based, as before: #/drives?month=2026-11)
export const ROUTE = makeStore({ name: "drives", params: new URLSearchParams(), prev: null });
const OLD_PAGES = { overview: {}, search: {}, favorites: { show: "kept" }, map: { view: "map" } };
export const PAGE_NAMES = ["drives", "kept", "player", "status", "health", "storage", "system", "plates"];
function parseHash() {
  const h = location.hash.replace(/^#\/?/, ""), [name, q] = h.split("?");
  return { name: name || "drives", params: new URLSearchParams(q || "") };
}
export const hrefOf = (name, params = {}) => { const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null)).toString(); return `#/${name}${q ? "?" + q : ""}`; };
export function go(name, params = {}, replace = false) {
  const h = hrefOf(name, params);
  if (replace) { history.replaceState(null, "", h); readRoute(); } else location.hash = h;
}
export function setParams(params) {                       // update the URL without re-rendering the page
  const q = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== "" && v != null));
  history.replaceState(null, "", `#/${ROUTE.get().name}${q.toString() ? "?" + q : ""}`);
  ROUTE.set(s => ({ ...s, params: q }));
}
function readRoute() {
  const { name, params } = parseHash();
  if (OLD_PAGES[name]) { go("drives", OLD_PAGES[name], true); return; }   // links from before the redesign
  if (name === "drives" && params.get("show") === "kept" && !params.get("month") && !params.get("q")) { go("kept", {}, true); return; }
  const page = PAGE_NAMES.includes(name) ? name : "drives";
  ROUTE.set(s => ({ prev: s.name, name: page, params, key: (s.key || 0) + 1 }));
}
export function startRouter() {
  if (!location.hash) history.replaceState(null, "", "#/drives");
  window.addEventListener("hashchange", readRoute);
  readRoute();
}
