// Pi - is footage flowing, what happened, is the hardware well. The pipeline (car -> Pi -> Wi-Fi -> PC) carries the live
// numbers; the timeline shows the last day; four vitals; the board facts in a footer; the log folded away.
// This is the only page that shows the footage-lost warnings.
import React, { useEffect, useMemo, useState } from "react";
import { Text, Card, Badge, Button, Divider, Switch, TabList, Tab, Spinner } from "@fluentui/react-components";
import { ChevronDown16Regular, ChevronUp16Regular, VehicleCar24Regular, DeveloperBoard24Regular, Desktop24Regular, Wifi124Regular, UsbPlug24Regular } from "@fluentui/react-icons";
import { api, LIVE, useStore, upState, parseLost, hm, ymd, wd3, mo3, signed, plural, pad, parseT, fmtB, ago } from "./lib.js";
import { useCrumb } from "./shell.jsx";
import { T, useColors } from "./theme.js";
import { systemIssues, dismiss, Notice } from "./settings.jsx";

const muted = { color: T.colorNeutralForeground2 }, faint = { color: T.colorNeutralForeground3 };
const PERIODS = [[24, "24 h"], [48, "2 days"], [168, "7 days"]];
const DIAG_TYPES = ["FOOTAGE LOST", "WI-FI SETTINGS WERE MISSING", "HOME FOOTAGE PAUSED", "HOME FOOTAGE RESUMED", "UPLOAD PROBLEM", "UPLOAD PAUSED", "PC UNREACHABLE", "PC REACHABLE", "POWER/HEAT", "LOW SD", "SD SPACE OK", "RECOVERY", "RECONNECTED", "OFFLINE", "POWER-UP", "CAR USB", "SUPPORT BUNDLE", "HEALED", "HOT", "COOLED"];
const diagType = t => DIAG_TYPES.find(k => t.startsWith(k)) || t.split(/[:\-—(]/)[0].trim();
const diagMsg = (t, ty) => t.slice(ty.length).replace(/^\s*[:\-—]\s*/, "").trim();
const pdate = t => { const d = new Date(t); return `${wd3(d)} ${hm(d)}`; };
const CARD_GB = 40;                                            // the Pi keeps at most this much footage waiting (teslacam-archive cap)

// ---------------------------------------------------------------- data shaping
function buckets(m, start, end, n = 144) {
  const size = (end - start) / n, out = Array.from({ length: n }, (_, i) => ({ t: start + (i + .5) * size, v: {}, n: 0, home: 0 }));
  m.forEach(r => {
    const t = Date.parse(r.time); if (isNaN(t) || t < start || t > end) return;
    const b = out[Math.min(n - 1, Math.floor((t - start) / size))]; b.n++; if (r.wifi_connected) b.home++;
    for (const k of ["cpu_temp_c", "cpu_usage_pct", "recent_on_pi_gb"]) if (r[k] != null) (b.v[k] = b.v[k] || []).push(+r[k]);
    if (r.wifi_connected && r.wifi_dbm != null) (b.v.wifi = b.v.wifi || []).push(+r.wifi_dbm);
  });
  out.forEach(b => { for (const k in b.v) b.v[k] = b.v[k].reduce((a, x) => a + x, 0) / b.v[k].length; });
  return out;
}
// a smooth line across the whole period: gaps (the Pi asleep) are bridged, then the line is averaged and curved
function smoothPath(bs, key, lo, hi, H, W = 960) {
  const v = bs.map(b => b.v[key]), n = v.length, first = v.findIndex(x => x != null);
  if (first < 0) return { d: "", area: "", last: null };
  let lastI = first; for (let i = 0; i < n; i++) if (v[i] != null) lastI = i;
  for (let i = first; i <= lastI; i++) if (v[i] == null) { let j = i; while (v[j] == null) j++; for (let k = i; k < j; k++) v[k] = v[i - 1] + (v[j] - v[i - 1]) * (k - i + 1) / (j - i + 1); i = j; }
  for (let i = 0; i < first; i++) v[i] = v[first]; for (let i = lastI + 1; i < n; i++) v[i] = v[lastI];
  const sm = v.map((_, i) => { let a = 0, c = 0; for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) { a += v[j]; c++; } return a / c; });
  const P = sm.map((x, i) => [(i + .5) / n * W, H - (Math.max(lo, Math.min(hi, x)) - lo) / (hi - lo) * H]);
  let d = `M${P[0][0].toFixed(1)},${P[0][1].toFixed(1)}`;
  for (let i = 0; i < P.length - 1; i++) { const p0 = P[Math.max(0, i - 1)], p1 = P[i], p2 = P[i + 1], p3 = P[Math.min(P.length - 1, i + 2)];
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)} ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)} ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`; }
  return { d, area: `${d}L${P[P.length - 1][0].toFixed(1)},${H}L${P[0][0].toFixed(1)},${H}Z`, last: P[lastI] };
}
const lastVal = (m, k) => { for (let i = m.length - 1; i >= 0; i--) if (m[i][k] != null) return m[i][k]; return null; };
const Dot = ({ c, s = 10 }) => <span style={{ width: s, height: s, borderRadius: "50%", background: c, flex: "none", display: "inline-block" }} />;

export function Pi() {
  useCrumb([["Pi"]]);
  const C = useColors(), live = useStore(LIVE);
  const [hours, setHours] = useState(24), [data, setData] = useState(null), [sys, setSys] = useState(null), [sum, setSum] = useState(null), [, bump] = useState(0);
  useEffect(() => { let on = true; setData(null); Promise.all([api(`/api/metrics?hours=${hours}`), api("/api/diag/events?limit=1000"), api("/api/syncs?limit=400").catch(() => [])]).then(([m, ev, sy]) => on && setData({ m, ev, sy })).catch(() => on && setData({ m: [], ev: [], sy: [] })); return () => { on = false; }; }, [hours]);
  useEffect(() => { api("/api/system").then(setSys).catch(() => {}); api("/api/summary").then(setSum).catch(() => {}); }, []);
  const u = upState(live), st = live.now?.status || {}, per = PERIODS.find(p => p[0] === hours)[1];
  const issues = sys ? systemIssues(sys, live).filter(i => ["job", "lost", "quiet"].includes(i.key)) : [];
  const good = (ok, text) => [ok === true ? C.GREEN : ok === false ? C.AMBER : T.colorNeutralForeground4, text];
  const stateColor = s => s[0] === C.AMBER ? C.AMBER : s[0] === C.GREEN ? C.GREEN : T.colorNeutralForeground3;
  if (!data) return <Spinner label="Reading the Pi's history…" style={{ marginTop: 40 }} />;
  const { m, ev, sy } = data, end = Date.now(), start = end - hours * 3600e3, bs = buckets(m, start, end), last = m[m.length - 1] || null;
  const inP = e => { const t = Date.parse(e.time); return t >= start && t <= end; };
  const lostEv = ev.filter(e => e.title.startsWith("FOOTAGE LOST") && inP(e)), powerUps = ev.filter(e => e.title.startsWith("POWER-UP") && inP(e));
  const syP = sy.filter(x => { const t = parseT(x.time.slice(0, 19)); return t >= start && t <= end; });
  const f1 = v => v == null ? "–" : (+v).toFixed(1);

  // ---- the pipeline: car -> Pi -> Wi-Fi -> PC, with what each part is doing right now
  const w = st.waiting || {}, waitingGB = ((w.recent_bytes || 0) + (w.event_bytes || 0)) / 1e9;
  const sdFree = lastVal(m, "sd_free_gb"), camUsed = lastVal(m, "cam_used_pct");
  const usb = u.fresh ? st.car_usb : null, carAwake = usb === "configured";
  const dbm = u.fresh && st.wifi_dbm != null ? +st.wifi_dbm : null, rate = u.up && st.rate_bps ? st.rate_bps / 1e6 : null;
  const left = u.up && rate ? Math.max(0, ((st.bytes_total || 0) - u.bytes) / (rate * 1e6)) : null;
  const pcFree = sum?.pc_disk_free_gb, pcFoot = sum?.gb;
  const lastSync = sy[0] ? parseT(sy[0].time.slice(0, 19)) : null;
  let headline, sub, mood;
  if (!st.state) { headline = "No word from the Pi yet"; sub = "It reports every 2 minutes whenever the car is awake at home."; mood = null; }
  else if (!u.fresh) { headline = "The Pi is away or asleep"; sub = `Last heard ${ago(u.age)} ago${waitingGB >= 0.05 ? ` with ${f1(waitingGB)} GB waiting to upload` : ", nothing waiting"}. It picks up by itself when the car is next awake at home.`; mood = waitingGB > CARD_GB * 0.8 ? false : null; }
  else if (u.up) { headline = rate != null && rate < 4 ? "Footage is flowing, slowly" : "Footage is flowing"; sub = `Uploading at ${rate ? rate.toFixed(1) : "–"} MB/s · ${fmtB((st.bytes_total || 0) - u.bytes)} to go${left != null ? ` · about ${left < 3600 ? `${Math.max(1, Math.round(left / 60))} min` : `${(left / 3600).toFixed(1)} h`}` : ""}`; mood = !(rate != null && rate < 4); }
  else if (waitingGB >= 0.05) { headline = `${f1(waitingGB)} GB waiting on the Pi`; sub = "The next upload starts within 2 minutes while the car is awake at home."; mood = waitingGB > CARD_GB * 0.8 ? false : null; }
  else { headline = "Everything is on the PC"; sub = lastSync ? `Nothing waiting. Last upload ${wd3(lastSync)} ${hm(lastSync)}, ${sy[0].mb >= 1000 ? (sy[0].mb / 1000).toFixed(1) + " GB" : sy[0].mb + " MB"}.` : "Nothing waiting."; mood = true; }
  const cardPct = Math.min(100, Math.round(waitingGB / CARD_GB * 100));
  const nodes = [
    { icon: VehicleCar24Regular, name: "Car", big: carAwake ? "Recording" : usb == null ? "–" : "Asleep", lines: [carAwake ? "awake, writing to the Pi" : usb == null ? "no recent reading" : "not using the drive", camUsed != null ? `dashcam drive ${Math.round(camUsed)}% full` : ""], state: good(usb == null ? null : carAwake, usb == null ? "Unknown" : carAwake ? "Connected" : "Idle") },
    { icon: DeveloperBoard24Regular, name: "Pi", big: `${f1(waitingGB)} GB`, lines: ["waiting to upload", `card ${cardPct}% of its ${CARD_GB} GB${sdFree != null ? ` · ${f1(sdFree)} GB free` : ""}`], ring: cardPct, state: good(cardPct < 80 ? true : false, cardPct < 50 ? "Room" : cardPct < 80 ? "Filling" : "Nearly full") },
    { icon: Desktop24Regular, name: "PC", big: pcFoot != null ? `${Math.round(pcFoot).toLocaleString()} GB` : "–", lines: ["of footage on this PC", pcFree != null ? `${pcFree >= 1000 ? (pcFree / 1000).toFixed(1) + " TB" : Math.round(pcFree) + " GB"} free` : ""], state: good(pcFree == null ? null : pcFree > 100, pcFree == null ? "–" : pcFree > 100 ? "Room" : "Low space") },
  ];
  const links = [
    { icon: UsbPlug24Regular, label: "USB", value: carAwake ? "connected" : usb == null ? "–" : "not in use", on: carAwake, flow: carAwake },
    { icon: Wifi124Regular, label: "Wi-Fi", value: dbm != null ? `${signed(Math.round(dbm))} dBm${rate ? ` · ${rate.toFixed(1)} MB/s` : ""}` : u.fresh ? "not connected" : "away", on: dbm != null, flow: !!u.up, good: dbm == null ? null : dbm >= -67 },
  ];

  // ---- the timeline: where the Pi was, when uploads ran, what went wrong
  const W = 960, lanes = { pi: [0, 22], up: [34, 56], ev: [68, 84] }, H = 100;
  const x = t => Math.max(0, Math.min(W, (t - start) / (end - start) * W));
  const piBands = []; let cur = null;
  bs.forEach((b, i) => { const kind = b.n === 0 ? "off" : b.home / b.n >= .5 ? "home" : "away"; if (cur && cur.kind === kind) cur.to = i + 1; else { cur = { kind, from: i, to: i + 1 }; piBands.push(cur); } });
  const ups = syP.map(s => { const t = parseT(s.time.slice(0, 19)).getTime(); return { a: x(t - (s.duration_s || 0) * 1000), b: x(t), ok: s.success, mb: s.mb, rate: s.mb_per_s }; });
  const hourTicks = []; { const step = hours <= 24 ? 3 : hours <= 48 ? 6 : 24; const d = new Date(start); d.setMinutes(0, 0, 0); if (step >= 24) d.setHours(0); else d.setHours(Math.ceil(d.getHours() / step) * step); for (let t = +d; t < end; t += step * 3600e3) hourTicks.push([x(t), step >= 24 ? `${wd3(new Date(t))} ${new Date(t).getDate()}` : hm(new Date(t))]); }
  const homeMin = bs.filter(b => b.n && b.home / b.n >= .5).length / bs.length * hours * 60, awayMin = bs.filter(b => b.n && b.home / b.n < .5).length / bs.length * hours * 60;
  const movedGB = syP.reduce((a, s) => a + s.mb, 0) / 1000, cut = syP.filter(s => !s.success).length, lostGB = lostEv.reduce((a, e) => a + parseLost(e).mb, 0) / 1000;
  const hrs = mins => mins < 60 ? `${Math.round(mins)} min` : `${(mins / 60).toFixed(mins < 600 ? 1 : 0)} h`;
  const summary = [[`Home ${hrs(homeMin)}`, C.GREEN], [`away ${hrs(awayMin)}`, C.OTHER], [`${plural(syP.length, "upload")}, ${movedGB.toFixed(1)} GB${cut ? `, ${cut} cut short` : ""}`, C.BRAND],
    [lostEv.length ? `${lostGB.toFixed(1)} GB of footage lost` : "no footage lost", lostEv.length ? C.AMBER : C.GREEN], [`${plural(powerUps.length, "power-up")}`, T.colorNeutralForeground3]];

  // ---- vitals
  const temps = m.filter(r => r.cpu_temp_c != null), nowT = temps.length ? temps[temps.length - 1].cpu_temp_c : null, hot = temps.length ? temps.reduce((a, r) => r.cpu_temp_c > a.cpu_temp_c ? r : a) : null;
  const vT = temps.map(r => +r.cpu_temp_c), vW = m.filter(r => r.wifi_connected && r.wifi_dbm != null).map(r => +r.wifi_dbm), vC = m.filter(r => r.cpu_usage_pct != null).map(r => +r.cpu_usage_pct);
  const online = Math.round(bs.filter(b => b.n && b.home).length / bs.length * 100), avgW = vW.length ? Math.round(vW.reduce((a, b) => a + b) / vW.length) : null;
  const cpuNow = lastVal(m, "cpu_usage_pct"), mem = lastVal(m, "memory_used_pct"), uv = m.filter(r => r.under_voltage_now).length, thr = m.filter(r => r.throttled_now).length;
  const okSy = syP.filter(s => s.success), avgRate = okSy.length ? okSy.reduce((a, s) => a + s.mb_per_s, 0) / okSy.length : syP.length ? syP.reduce((a, s) => a + s.mb_per_s, 0) / syP.length : null;
  const wNow = dbm ?? (vW.length ? vW[vW.length - 1] : null);
  const Z = { ok: C.GREEN, warn: C.AMBER, bad: C.AMBER, mid: T.colorNeutralForeground4 };
  const vitals = [
    { title: "Temperature", big: nowT != null ? `${Math.round(nowT)}°` : "–", state: good(nowT == null ? null : nowT < 65, nowT == null ? "–" : nowT < 65 ? "Cool" : nowT < 75 ? "Warm" : "Hot"),
      gauge: { value: nowT, min: 20, max: 90, unit: "°", zones: [[20, 65, "ok", "cool"], [65, 75, "warn", "warm"], [75, 90, "bad", "hot"]] }, sub: vT.length ? `${Math.round(Math.min(...vT))}° to ${Math.round(Math.max(...vT))}° · hottest ${hot ? pdate(Date.parse(hot.time)) : ""}` : "no readings", spark: ["cpu_temp_c", [20, 80], [65, 75]] },
    { title: "Wi-Fi", big: wNow != null ? `${signed(Math.round(wNow))} dBm` : "–", state: wNow == null ? good(null, u.fresh ? "Not connected" : "Away") : good(wNow >= -67, wNow >= -67 ? "Strong" : wNow >= -75 ? "Fair" : "Weak"),
      gauge: { value: wNow, min: -90, max: -30, unit: " dBm", zones: [[-90, -75, "bad", "weak"], [-75, -67, "mid", "fair"], [-67, -30, "ok", "strong"]] }, sub: vW.length ? `on home Wi-Fi ${online}% of ${per} · average ${signed(avgW)}` : `no home Wi-Fi in ${per}`, spark: ["wifi", [-95, -25], [-75]] },
    { title: "Processor", big: cpuNow != null ? `${Math.round(cpuNow)}%` : "–", state: good(uv || thr ? false : cpuNow == null ? null : cpuNow < 60, uv ? "Low voltage" : thr ? "Throttled" : cpuNow == null ? "–" : cpuNow < 25 ? "Idle" : cpuNow < 60 ? "Busy" : "Heavy"),
      gauge: { value: cpuNow, min: 0, max: 100, unit: "%", zones: [[0, 25, "ok", "idle"], [25, 60, "mid", "busy"], [60, 100, "bad", "heavy"]] }, sub: `${vC.length ? `peak ${Math.round(Math.max(...vC))}%` : "no readings"}${mem != null ? ` · memory ${Math.round(mem)}%` : ""}`, spark: ["cpu_usage_pct", [0, Math.max(20, Math.ceil(Math.max(0, ...vC) / 10) * 10)], []] },
    { title: "Upload speed", big: rate != null ? `${rate.toFixed(1)} MB/s` : avgRate != null ? `${avgRate.toFixed(1)} MB/s` : "–", state: rate != null ? good(rate >= 8, rate >= 8 ? "Uploading" : "Uploading slowly") : avgRate == null ? good(null, "No uploads") : good(avgRate >= 8, avgRate >= 8 ? "Normal" : "Slow"),
      gauge: { value: rate ?? avgRate, min: 0, max: 15, unit: " MB/s", zones: [[0, 4, "bad", "slow"], [4, 8, "mid", "fair"], [8, 15, "ok", "normal"]] }, sub: syP.length ? `${rate != null ? `average ${(avgRate || 0).toFixed(1)} · ` : ""}${movedGB.toFixed(1)} GB in ${plural(syP.length, "upload")}` : `nothing uploaded in ${per}`, bars: syP.slice().reverse().slice(-48) },
  ];
  const Spark = ({ k, range, marks }) => { const h = 48, p = smoothPath(bs, k, range[0], range[1], h), y = v => h - (v - range[0]) / (range[1] - range[0]) * h;
    return <svg viewBox={`0 0 960 ${h}`} preserveAspectRatio="none" aria-hidden="true" style={{ width: "100%", height: h, display: "block" }}>
      {marks.map(v => <line key={v} x1="0" x2="960" y1={y(v)} y2={y(v)} stroke={C.AMBER} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />)}
      <path d={p.area} fill={C.BRAND} opacity=".10" /><path d={p.d} fill="none" stroke={C.BRAND} strokeWidth="2" vectorEffect="non-scaling-stroke" /></svg>; };
  const Gauge = ({ g }) => { const span = g.max - g.min, pos = g.value == null ? null : Math.max(0, Math.min(100, (g.value - g.min) / span * 100));
    return <div aria-label={g.value == null ? "no reading" : `${g.value}${g.unit} on a scale from ${g.min} to ${g.max}`} style={{ margin: "6px 0 2px" }}>
      <div style={{ position: "relative", height: 22 }}>
        <div style={{ position: "absolute", left: 0, right: 0, top: 7, height: 8, borderRadius: 4, overflow: "hidden", display: "flex" }}>{g.zones.map(([a, b, kind]) => <span key={a} style={{ width: `${(b - a) / span * 100}%`, background: Z[kind], opacity: kind === "mid" ? .35 : .55 }} />)}</div>
        {pos != null && <span style={{ position: "absolute", left: `${pos}%`, top: 1, width: 6, height: 20, marginLeft: -3, borderRadius: 3, background: T.colorNeutralForeground1, boxShadow: `0 0 0 2px ${T.colorNeutralBackground1}` }} />}</div>
      <div style={{ display: "flex", position: "relative", height: 14 }}>{g.zones.map(([a, b, kind, label]) => <Text key={a} size={200} style={{ width: `${(b - a) / span * 100}%`, textAlign: "center", color: kind === "mid" ? T.colorNeutralForeground3 : Z[kind], whiteSpace: "nowrap", overflow: "hidden" }}>{label}</Text>)}</div></div>; };
  const stateBadge = st => <Badge appearance="tint" shape="rounded" size="large" color={st[0] === C.GREEN ? "success" : st[0] === C.AMBER ? "warning" : "informative"} style={{ fontWeight: 600 }}>{st[1]}</Badge>;
  const Bars = ({ bars }) => { const h = 48, top = Math.max(5, ...bars.map(b => b.mb_per_s || 0)) * 1.1;
    return <div aria-hidden="true" style={{ height: h, display: "flex", alignItems: "flex-end", gap: 2 }}>{bars.length ? bars.map((b, i) => <span key={i} style={{ flex: 1, height: Math.max(2, (b.mb_per_s || 0) / top * h), background: b.success ? C.BRAND : C.AMBER, borderRadius: "2px 2px 0 0" }} />) : <span style={{ flex: 1, borderTop: `1px dashed ${T.colorNeutralStroke1}` }} />}</div>; };

  // ---- the board, in one line
  const sw = st.software, when = iso => { const d = new Date(iso); return isNaN(d) ? "" : `${mo3(d)} ${d.getDate()}, ${hm(d)}`; };
  const restarted = last && last.uptime_s != null ? new Date(Date.parse(last.time) - last.uptime_s * 1000) : null;
  const about = [st.model ? st.model.replace(/^Raspberry Pi /, "Pi ").replace(/ Rev.*/, "") : null, st.os || null, sw ? `software ${sw.version} installed ${when(sw.installed_at)}` : "software version not reported yet (run the installer once)",
    restarted ? `restarted ${wd3(restarted)} ${hm(restarted)}` : null, last ? `last reading ${pdate(Date.parse(last.time))}` : null, `${m.length.toLocaleString()} readings in ${per}`].filter(Boolean);

  const ring = (pct, size = 54, stroke = 6) => { const r = (size - stroke) / 2, c = 2 * Math.PI * r; return <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true" style={{ flex: "none" }}>
    <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={T.colorNeutralStroke2} strokeWidth={stroke} /><circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={pct >= 80 ? C.AMBER : C.BRAND} strokeWidth={stroke} strokeDasharray={`${c * pct / 100} ${c}`} strokeLinecap="round" transform={`rotate(-90 ${size / 2} ${size / 2})`} /></svg>; };
  const Node = ({ n }) => <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", gap: 14, alignItems: "center", padding: "14px 16px", borderRadius: T.borderRadiusLarge, background: T.colorNeutralBackground1, border: `1px solid ${T.colorNeutralStroke2}` }}>
    {n.ring != null ? ring(n.ring) : <span style={{ width: 54, height: 54, borderRadius: "50%", display: "grid", placeItems: "center", background: T.colorNeutralBackground3, color: T.colorNeutralForeground2, flex: "none" }}><n.icon /></span>}
    <div style={{ minWidth: 0 }}><div style={{ display: "flex", alignItems: "center", gap: 8 }}><Text className="micro" size={200} style={muted}>{n.name}</Text><Text size={200} weight="semibold" style={{ color: stateColor(n.state) }}>{n.state[1]}</Text></div>
      <Text className="display" size={600} weight="semibold" block style={{ lineHeight: 1.15, whiteSpace: "nowrap" }}>{n.big}</Text>
      {n.lines.filter(Boolean).map(l => <Text key={l} size={200} style={muted} block truncate>{l}</Text>)}</div></div>;
  const Link = ({ l }) => <div style={{ flex: "0 0 150px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "0 8px" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 6, color: l.on ? (l.good === false ? C.AMBER : T.colorNeutralForeground2) : T.colorNeutralForeground4 }}><l.icon /><Text size={200} weight="semibold" style={{ color: "inherit" }}>{l.label}</Text></div>
    <div className={l.flow ? "flow on" : "flow"} style={{ width: "100%", height: 4, borderRadius: 2, backgroundColor: l.on ? (l.good === false ? C.AMBER : C.GREEN) : T.colorNeutralStroke1, opacity: l.on ? 1 : .6 }} />
    <Text size={200} style={{ ...muted, whiteSpace: "nowrap" }}>{l.value}</Text></div>;
  return <>
    <div style={{ display: "flex", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
      <TabList selectedValue={hours} onTabSelect={(e, d) => setHours(d.value)} aria-label="Period">{PERIODS.map(([h, l]) => <Tab key={h} value={h}>{l}</Tab>)}</TabList>
      <span style={{ flex: 1 }} /><Text size={200} style={faint}>{st.state ? `Pi reported ${ago(u.age)} ago` : "no report yet"}</Text></div>
    {issues.map(i => <Notice key={i.key} i={i} onHide={() => { dismiss(i.key, i.stamp); bump(x => x + 1); }} />)}

    <Card className="featured" style={{ padding: "22px 24px 20px", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap" }}><Dot c={mood === true ? C.GREEN : mood === false ? C.AMBER : T.colorNeutralForeground4} s={12} />
        <Text as="h1" className="display" size={800} weight="semibold" style={{ margin: 0, lineHeight: 1.1 }}>{headline}</Text></div>
      <Text size={400} style={{ ...muted, marginTop: -8 }}>{sub}</Text>
      <div className="pipeline" style={{ display: "flex", alignItems: "center", gap: 0 }}><Node n={nodes[0]} /><Link l={links[0]} /><Node n={nodes[1]} /><Link l={links[1]} /><Node n={nodes[2]} /></div>
    </Card>

    <Card style={{ padding: "18px 22px 14px", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}><Text className="display" size={500} weight="semibold">The last {per}</Text>
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>{summary.map(([t, c]) => <span key={t} style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot c={c} s={8} /><Text size={200} style={muted}>{t}</Text></span>)}</div></div>
      <div className="tlwrap"><div className="tl" style={{ display: "grid", gridTemplateColumns: "72px 1fr", gap: "0 12px", alignItems: "stretch" }}>
        <div style={{ position: "relative", height: H }}>{[["Pi", lanes.pi], ["Uploads", lanes.up], ["Events", lanes.ev]].map(([l, [a, b]]) => <Text key={l} size={200} style={{ ...faint, position: "absolute", top: `${(a + b) / 2 / H * 100}%`, transform: "translateY(-50%)", right: 0 }}>{l}</Text>)}</div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={`Timeline of the last ${per}: ${summary.map(s => s[0]).join(", ")}.`} style={{ width: "100%", height: H, display: "block" }}>
          {piBands.map((b, i) => b.kind === "off" ? null : <rect key={i} x={b.from / bs.length * W} y={lanes.pi[0]} width={(b.to - b.from) / bs.length * W} height={lanes.pi[1] - lanes.pi[0]} rx="3" fill={b.kind === "home" ? C.GREEN : C.OTHER} opacity={b.kind === "home" ? .85 : .9} />)}
          <line x1="0" x2={W} y1={lanes.up[1]} y2={lanes.up[1]} stroke={T.colorNeutralStroke2} vectorEffect="non-scaling-stroke" />
          {ups.map((s, i) => <rect key={i} x={s.a} y={lanes.up[0]} width={Math.max(2, s.b - s.a)} height={lanes.up[1] - lanes.up[0]} rx="2" fill={s.ok ? C.BRAND : C.AMBER}><title>{`${s.ok ? "Upload" : "Upload, cut short"} · ${s.mb >= 1000 ? (s.mb / 1000).toFixed(1) + " GB" : s.mb + " MB"} · ${s.rate} MB/s`}</title></rect>)}
          {powerUps.map((e, i) => <circle key={"p" + i} cx={x(Date.parse(e.time))} cy={(lanes.ev[0] + lanes.ev[1]) / 2} r="3.5" fill={T.colorNeutralForeground3}><title>{`Power-up · ${pdate(Date.parse(e.time))}`}</title></circle>)}
          {lostEv.map((e, i) => <rect key={"l" + i} x={x(Date.parse(e.time)) - 2} y={lanes.ev[0]} width="4" height={lanes.ev[1] - lanes.ev[0]} rx="1" fill={C.AMBER}><title>{`Footage lost · ${pdate(Date.parse(e.time))} · ${parseLost(e).mb} MB`}</title></rect>)}
          {hourTicks.map(([px, l], i) => <g key={i}><line x1={px} x2={px} y1="0" y2={H - 12} stroke={T.colorNeutralStroke2} strokeDasharray="2 4" vectorEffect="non-scaling-stroke" /></g>)}
          <line x1={W - 1} x2={W - 1} y1="0" y2={H - 12} stroke={C.BRAND} strokeWidth="2" vectorEffect="non-scaling-stroke" />
        </svg>
        <span /><div style={{ position: "relative", height: 16 }}>{hourTicks.map(([px, l], i) => <Text key={i} size={200} style={{ ...faint, position: "absolute", left: `${px / W * 100}%`, transform: "translateX(-50%)", whiteSpace: "nowrap" }}>{l}</Text>)}<Text size={200} weight="semibold" style={{ position: "absolute", right: 0, color: C.BRAND }}>now</Text></div>
      </div></div>
    </Card>

    <div className="vitals" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,230px),1fr))", gap: 16 }}>
      {vitals.map(v => <Card key={v.title} style={{ padding: "16px 20px", gap: 4 }}>
        <Text size={300} weight="semibold">{v.title}</Text>
        <div className="vbig" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}><Text className="display" size={800} weight="semibold" style={{ lineHeight: 1.1, whiteSpace: "nowrap" }}>{v.big}</Text>{stateBadge(v.state)}</div>
        <Gauge g={v.gauge} />
        <Text className="vsub" size={200} style={muted} block truncate>{v.sub}</Text>
        {v.spark ? <Spark k={v.spark[0]} range={v.spark[1]} marks={v.spark[2]} /> : <Bars bars={v.bars} />}
      </Card>)}
    </div>
    <Text size={200} style={{ ...faint, padding: "0 4px" }}>{about.join(" · ")}</Text>
    <Diag ev={ev} C={C} />
  </>;
}

// the diagnostics log, folded away; grouped so runs of the same entry on one day become one row
function Diag({ ev, C }) {
  const [open, setOpen] = useState(false), [problems, setProblems] = useState(true), [limit, setLimit] = useState(40), [openG, setOpenG] = useState({});
  const groups = useMemo(() => {
    const rows = ev.filter(e => !problems || e.kind === "bad" || e.kind === "warn"), g = [];
    rows.forEach(e => { const ty = diagType(e.title), day = ymd(new Date(e.time)), l = g[g.length - 1]; if (l && l.ty === ty && l.day === day) l.items.push(e); else g.push({ ty, day, items: [e], kind: e.kind }); });
    return g;
  }, [ev, problems]);
  const probs = ev.filter(e => (e.kind === "bad" || e.kind === "warn") && Date.now() - Date.parse(e.time) < 86400e3).length;
  const level = k => k === "bad" ? ["Critical", "danger"] : k === "warn" ? ["Warning", "warning"] : ["Info", "informative"];
  let curDay = null;
  return <Card style={{ padding: "14px 22px", gap: 12 }}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
      <Button appearance="subtle" icon={open ? <ChevronUp16Regular /> : <ChevronDown16Regular />} iconPosition="after" onClick={() => setOpen(!open)} style={{ padding: 0 }}><Text className="display" size={500} weight="semibold">The Pi's log</Text></Button>
      <div style={{ display: "flex", alignItems: "center", gap: 16 }}><Text size={200} style={faint}>{probs ? `${plural(probs, "problem")} in the last 24 h` : "no problems in the last 24 h"}</Text>{open && <Switch label="Problems only" labelPosition="before" checked={problems} onChange={(e, d) => setProblems(d.checked)} />}</div></div>
    {open && (groups.length ? <div style={{ display: "flex", flexDirection: "column" }}>{groups.slice(0, limit).map((g, gi) => {
      const n = g.items.length, t1 = hm(new Date(g.items[n - 1].time)), t2 = hm(new Date(g.items[0].time)), [ln, lc] = level(g.kind), key = g.items[0].time, isOpen = openG[key] ?? false;
      let head = null;
      if (g.day !== curDay) { curDay = g.day; const dd = new Date(g.items[0].time); head = <div style={{ padding: "12px 0 4px" }}><Text size={300} weight="semibold" style={faint}>{wd3(dd)} {mo3(dd)} {dd.getDate()}</Text></div>; }
      let msg, extra = null;
      if (g.ty === "FOOTAGE LOST") {
        const ps = g.items.map(parseLost), segs = ps.reduce((a, p) => a + p.segs, 0), mb = ps.reduce((a, p) => a + p.mb, 0);
        msg = <><b>Footage lost{n > 1 ? ` × ${n}` : ""}</b> — {segs} never-uploaded segments ({mb >= 1000 ? (mb / 1000).toFixed(1) + " GB" : mb + " MB"}) deleted to make room on the SD card</>;
        if (n > 1) extra = <><Button size="small" appearance="outline" icon={isOpen ? <ChevronUp16Regular /> : <ChevronDown16Regular />} iconPosition="after" onClick={() => setOpenG({ ...openG, [key]: !isOpen })} style={{ marginLeft: "auto" }}>{isOpen ? "Hide" : `Show ${n}`}</Button>
          {isOpen && <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 6 }}>{g.items.map((e, i) => <Badge key={i} appearance="outline" shape="rounded">{hm(new Date(e.time))} · {ps[i].segs} seg · {ps[i].mb.toLocaleString()} MB</Badge>)}</div>}</>;
      } else {
        const m0 = diagMsg(g.items[0].title, g.ty);
        msg = <><b>{g.ty.charAt(0) + g.ty.slice(1).toLowerCase()}{n > 1 ? ` × ${n}` : ""}</b>{m0 ? ` — ${m0}` : ""}</>;
        if (g.items[0].details && n === 1 && (g.kind === "bad" || g.kind === "warn")) extra = <details style={{ gridColumn: "1 / -1" }}><summary style={{ cursor: "pointer" }}><Text size={200} style={faint}>Details</Text></summary><Text size={200} style={{ ...muted, whiteSpace: "pre-wrap" }}>{g.items[0].details}</Text></details>;
      }
      return <React.Fragment key={key}>{head}<Divider /><div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12, padding: "8px 0" }}>
        <Text size={300} style={{ ...faint, flex: "0 0 96px", fontVariantNumeric: "tabular-nums" }}>{n > 1 && t1 !== t2 ? `${t1}–${t2}` : t2}</Text>
        <Badge appearance="tint" color={lc} shape="rounded" style={{ flex: "0 0 auto", minWidth: 72, justifyContent: "center" }}>{ln}</Badge>
        <Text size={300} style={{ flex: "1 1 300px" }}>{msg}</Text>{extra}</div></React.Fragment>;
    })}{groups.length > limit && <Button appearance="outline" onClick={() => setLimit(limit + 40)} style={{ alignSelf: "flex-start", marginTop: 10 }}>Show older entries</Button>}</div>
      : <Text size={300} style={muted}>{problems ? "No problems in the log." : "No diagnostics received from the Pi yet."}</Text>)}
  </Card>;
}
