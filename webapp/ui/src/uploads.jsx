// Uploads - live view of the Pi -> PC upload; refreshes every 3 s in place.
import React, { useEffect, useState } from "react";
import { Text, Card, Badge, Button, Divider, ProgressBar, Table, TableHeader, TableRow, TableHeaderCell, TableBody, TableCell, Spinner } from "@fluentui/react-components";
import { WifiWarning20Regular, Wifi120Regular, VehicleCar20Regular, Temperature20Regular, CheckmarkCircle16Filled, Warning16Filled } from "@fluentui/react-icons";
import { api, LIVE, useStore, upState, pollLive, ago, fmtB, fmtGB1, fmtDur, hm, hms, parseT, mo3, MO, CAM_SHORT, signed, t12 } from "./lib.js";
import { useCrumb } from "./shell.jsx";
import { T, useColors } from "./theme.js";

const muted = { color: T.colorNeutralForeground2 }, faint = { color: T.colorNeutralForeground3 };
const CAM_FROM_NAME = n => { const m = /(front|back|left_pillar|right_pillar|left_repeater|right_repeater)/.exec(n || ""); return m ? CAM_SHORT[m[1]] : "Clip"; };
const Num = ({ v, u, size = 800, color }) => <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}><Text size={size} weight="semibold" style={{ color, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{v}</Text>{u && <Text size={400} style={muted}>{u}</Text>}</span>;
const H2 = ({ children, sub }) => <div><Text className="display" size={500} weight="semibold" block>{children}</Text>{sub && <Text size={300} style={muted}>{sub}</Text>}</div>;

export function Uploads() {
  useCrumb([["Uploads"]]);
  const live = useStore(LIVE), C = useColors(), u = upState(live), st = u.st;
  const [syncs, setSyncs] = useState(null), [all, setAll] = useState(false);
  useEffect(() => {
    pollLive();
    const a = setInterval(() => { if (!document.hidden) pollLive(); }, 3000);
    const past = () => api("/api/syncs?limit=100").then(setSyncs).catch(() => {});
    past(); const b = setInterval(() => { if (!document.hidden) past(); }, 60000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  const recv = (live.now?.receiving || []).filter(r => r.age_s < 120);
  const liveBadge = <Badge appearance={u.fresh ? "filled" : "outline"} color={u.fresh ? "success" : "informative"} shape="rounded">{u.fresh ? "Live" : st ? "Pi away" : "Waiting"}</Badge>;
  const liveText = <Text size={200} style={faint}>{st ? `Pi updated ${ago(u.age)} ago · refreshes every 3 s` : "No report from the Pi yet · refreshes every 3 s"}</Text>;
  // ---- the upload now. The card keeps one height whatever is happening, so nothing jumps while files land.
  const run = live.now?.run, L15 = live.now?.last15 || { bytes: 0, files: 0 };
  let head;
  if (!u.up) {
    let title, sub;
    if (!st) { title = "No live status from the Pi yet"; sub = "The Pi reports here every 2 minutes while it's home."; }
    else if (!u.fresh) { title = "Pi is away or asleep"; sub = `Last heard from ${ago(u.age)} ago${st.state === "uploading" ? ", in the middle of an upload; it continues by itself when the Pi is back" : ""}.`; }
    else if (st.state === "staging") { title = "Copying clips from the car to the Pi"; sub = st.note || ""; }
    else if (st.state === "stopped") { title = "Upload paused"; sub = st.note || "It continues on the next run, within 2 minutes."; }
    else { const w = st.waiting || {}, wb = (w.recent_bytes || 0) + (w.event_bytes || 0); title = wb < 5e7 ? "All caught up" : `${fmtB(wb)} waiting on the Pi`; sub = wb < 5e7 ? "Everything recorded so far is on this PC." : "The next upload starts within 2 minutes."; }
    head = <div style={{ height: 150, display: "flex", flexDirection: "column", justifyContent: "center", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>{liveBadge}{liveText}</div>
      <Text className="display" size={600} weight="semibold" block style={{ marginTop: 6 }}>{title}</Text><Text size={300} style={muted}>{sub}</Text></div>;
  } else {
    // progress follows what has actually landed on the PC; the Pi's own count only moves when a whole batch is verified
    const bytes = Math.max(u.bytes, run?.bytes || 0), files = Math.max(st.files_done || 0, run?.files || 0), total = st.bytes_total || 1;
    const pct = Math.min(100, Math.floor(bytes / total * 100)), b = st.batch || 1, nb = st.batches || 1;
    const elapsed = (st.elapsed_s || 0) + (st.age_s || 0) + (Date.now() - live.fetched) / 1000;
    const rate = st.rate_bps || (elapsed > 20 && bytes > 0 ? bytes / elapsed : null);
    const left = rate ? Math.max(0, (total - bytes) / rate) : null;
    const clipT = n => { const m = /(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)/.exec(n || ""); return m ? [`${MO[+m[2] - 1].slice(0, 3)} ${+m[3]}`, t12(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]))] : null; };
    const f1 = clipT(st.batch_first), f2 = clipT(st.batch_last);
    const nw = { whiteSpace: "nowrap" };
    const kpi = (l, v, un) => <span style={{ display: "flex", alignItems: "baseline", gap: 5, flex: "none", ...nw }}><Text size={300} style={{ ...muted, ...nw }}>{l}</Text><Text size={400} weight="semibold" style={{ fontVariantNumeric: "tabular-nums", ...nw }}>{v}</Text>{un && <Text size={300} style={{ ...muted, ...nw }}>{un}</Text>}</span>;
    head = <div style={{ height: 150, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "nowrap", overflow: "hidden" }}><Badge appearance="tint" color="brand" shape="rounded" size="large">Uploading {st.kind === "events" ? "Saved and Sentry clips" : "recent footage"}</Badge>{liveBadge}{liveText}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 18, flexWrap: "nowrap" }}><Num v={pct} u="%" size={1000} color={T.colorBrandForeground1} />
        <div style={{ minWidth: 0 }}><Text size={400} weight="semibold" block style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{files.toLocaleString()} of {(st.files_total || 0).toLocaleString()} files</Text><Text size={300} style={{ ...muted, whiteSpace: "nowrap" }}>{fmtGB1(bytes)} of {fmtGB1(total)}, {fmtGB1(Math.max(0, total - bytes))} to go</Text></div>
        <span style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 18 }}>{kpi("Speed", rate ? (rate / 1e6).toFixed(1) : "–", "MB/s")}{kpi("Time left", left == null ? "–" : left < 60 ? "< 1" : left < 5400 ? `≈ ${Math.round(left / 60)}` : `≈ ${(left / 3600).toFixed(1)}`, left == null ? "" : left < 5400 ? "min" : "h")}{kpi("Running", Math.round(elapsed / 60), "min")}</div></div>
      <div><ProgressBar value={pct / 100} thickness="large" />
        <Text size={300} truncate block style={{ ...muted, marginTop: 8, whiteSpace: "nowrap" }}>Batch {b} of {nb} · {st.batch_files || 0} files · {fmtB(st.batch_bytes)}{f1 ? ` · footage from ${f1[0]}, ${f1[1]}${f2 ? ` to ${f2[1]}` : ""}` : ""}</Text></div></div>;
  }
  // ---- the running list: what is being received now, then what has landed, newest first. Eight fixed rows.
  const clipWords = name => {                                   // "2026-11-12_14-11-25-left_pillar.mp4" -> {cam, when: "2:11:25 pm", day: "Nov 12"}
    const m = /(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(name || "");
    return { cam: CAM_FROM_NAME(name), when: m ? t12(new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]), true) : name, day: m ? `${MO[+m[2] - 1].slice(0, 3)} ${+m[3]}` : "" };
  };
  const ROWS = 8, rows = [];
  recv.slice(0, 2).forEach(r => rows.push({ key: "r" + r.name, ...clipWords(r.name), status: "receiving", size: r.size }));
  (live.now?.latest || []).forEach(a => { if (rows.length < ROWS) { const n = a.path.split("/").pop(); rows.push({ key: a.path, ...clipWords(n), status: "arrived", at: hms(new Date(a.t * 1000)), size: a.size }); } });
  const w = st?.waiting || {};
  const rec = u.up && st.kind === "recent" ? st.bytes_total - u.bytes : w.recent_bytes, ev = u.up && st.kind === "events" ? st.bytes_total - u.bytes : w.event_bytes;
  // ---- the Pi, in three lines
  const dbm = u.fresh ? st?.wifi_dbm : null, wq = dbm == null ? [null, u.fresh ? "Not connected" : "No recent reading"] : dbm >= -67 ? [true, "Strong signal"] : dbm >= -75 ? [false, "Fair signal"] : [false, "Weak signal"];
  const usb = u.fresh ? st?.car_usb : null, car = usb == null ? ["–", "No recent reading", null] : usb === "configured" ? ["Connected", "Using the USB drive", true] : ["Not in use", "The car isn't using the drive", false];
  const tc = u.fresh ? st?.cpu_temp_c : null, tq = tc == null ? [null, "No recent reading"] : tc >= 75 ? [false, "Hot · above 75°"] : tc >= 65 ? [false, "Warm · above 65°"] : [true, "Normal · warm at 65°"];
  const piRow = (Ic, l, v, s, good) => <div key={l} style={{ display: "flex", alignItems: "center", gap: 12, padding: "7px 0" }}><Ic style={{ color: T.colorNeutralForeground3, flex: "none" }} />
    <Text className="micro" size={300} style={{ ...muted, flex: "0 0 96px" }}>{l}</Text><Text size={400} weight="semibold" style={{ flex: "0 0 auto", minWidth: 90 }}>{v}</Text><Text size={200} style={{ color: good === true ? C.GREEN : good === false ? C.AMBER : T.colorNeutralForeground3, flex: 1, textAlign: "right" }}>{s}</Text></div>;
  return <>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.5fr) minmax(300px,1fr)", gap: 16, alignItems: "start" }} className="two">
      <Card className="featured" style={{ padding: "18px 22px", gap: 0 }}>
        {head}
        <Divider style={{ margin: "12px 0 8px" }} />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}><Text size={300} weight="semibold">Files</Text><Text size={200} style={faint}>{L15.files} file{L15.files === 1 ? "" : "s"}, {fmtB(L15.bytes)} in the last 15 min</Text></div>
        <div style={{ height: ROWS * 32, overflow: "hidden", marginTop: 4 }}>
          {rows.length ? rows.map(r => <div key={r.key} style={{ height: 32, display: "flex", alignItems: "center", gap: 10, whiteSpace: "nowrap" }}>
            <span style={{ width: 16, display: "grid", placeItems: "center", flex: "none" }}>{r.status === "receiving" ? <Spinner size="extra-tiny" /> : <CheckmarkCircle16Filled style={{ color: C.GREEN }} />}</span>
            <Badge appearance="tint" color={r.status === "receiving" ? "brand" : "informative"} shape="rounded" style={{ flex: "0 0 96px", justifyContent: "center" }}>{r.cam}</Badge>
            <Text size={300} style={{ flex: "0 0 104px", fontVariantNumeric: "tabular-nums" }}>{r.when}</Text><Text size={200} style={{ ...faint, flex: "0 0 48px" }}>{r.day}</Text>
            <Text size={200} style={{ ...faint, flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{r.status === "receiving" ? "receiving now" : `arrived ${r.at}`}</Text>
            <Text size={300} style={{ ...muted, flex: "0 0 60px", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{fmtB(r.size)}</Text></div>)
            : <Text size={300} style={{ ...muted, lineHeight: "32px" }}>Nothing has arrived in the last hour.</Text>}
        </div>
      </Card>
      <Card className="kpi" style={{ padding: "16px 22px", gap: 0 }}>
        <Text className="display" size={500} weight="semibold">Raspberry Pi</Text>
        <div style={{ marginTop: 4 }}>{piRow(dbm == null || dbm >= -67 ? Wifi120Regular : WifiWarning20Regular, "Wi-Fi", dbm == null ? "–" : `${signed(Math.round(dbm))} dBm`, wq[1], wq[0])}
          {piRow(VehicleCar20Regular, "Car", car[0], car[1], car[2])}{piRow(Temperature20Regular, "Temperature", tc == null ? "–" : `${(+tc).toFixed(1)} °C`, tq[1], tq[0])}</div>
        <Divider style={{ margin: "8px 0 12px" }} />
        <Text className="display" size={500} weight="semibold">Waiting on the Pi</Text>
        <div style={{ display: "flex", gap: 28, marginTop: 6, flexWrap: "wrap" }}>
          <div><Num v={rec == null ? "–" : rec >= 1e9 ? (rec / 1e9).toFixed(1) : Math.round(rec / 1e6)} u={rec != null && rec < 1e9 ? "MB" : "GB"} size={800} /><Text size={200} style={muted}>recent footage on the SD card</Text></div>
          <div><Num v={ev == null ? "–" : ev >= 1e9 ? (ev / 1e9).toFixed(1) : Math.round(ev / 1e6)} u={ev != null && ev < 1e9 ? "MB" : "GB"} size={800} /><Text size={200} style={muted}>Saved and Sentry clips</Text></div></div>
      </Card>
    </div>
    <Activity live={live} syncs={syncs} all={all} setAll={setAll} C={C} />
  </>;
}

// the last hour minute by minute, the last 41 uploads, and the table of uploads
function Activity({ live, syncs, all, setAll, C }) {
  const Ln = live.now, H = 150;
  const Ylines = ({ top, fmt }) => [[top, fmt(top)], [top / 2, fmt(top / 2)]].map(([v, l]) => <span key={v} style={{ position: "absolute", left: 0, right: 0, bottom: v / top * H, borderTop: `1px solid ${T.colorNeutralStroke2}` }}><Text size={200} style={{ position: "absolute", right: "100%", top: -10, marginRight: 8, whiteSpace: "nowrap", color: T.colorNeutralForeground3 }}>{l}</Text></span>);
  let hour = null;
  if (Ln) {
    const end = Math.floor(Ln.server_time / 60) * 60, mins = Array.from({ length: 60 }, (_, i) => end - (59 - i) * 60);
    const by = Object.fromEntries(Ln.per_min.map(r => [r.t, r])), mb = mins.map(t => (by[t]?.bytes || 0) / 1e6);
    const top = Math.max(200, Math.ceil(Math.max(...mb) * 1.1 / 100) * 100), avg = Ln.per_min.filter(r => r.t >= end - 300).reduce((a, r) => a + r.bytes, 0) / 300;
    const lab = t => hm(new Date(t * 1000)), nz = mb.filter(x => x > 0), firstI = mb.findIndex(x => x > 0);
    const aria = nz.length ? `MB per minute, ${lab(mins[0])}–${lab(end)}: ${firstI > 0 ? `none until ${lab(mins[firstI])}, then ` : ""}${Math.round(Math.min(...nz))}–${Math.round(Math.max(...nz))}; 5-minute average ${(avg / 1e6).toFixed(1)} MB/s` : `No footage arrived between ${lab(mins[0])} and ${lab(end)}`;
    hour = <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10 }}><div><Text size={400} weight="semibold" block>Arriving on this PC</Text><Text size={200} style={muted}>MB per minute, last hour</Text></div><span style={{ display: "flex", alignItems: "baseline", gap: 5 }}><Text className="display" size={500} weight="semibold">{(avg / 1e6).toFixed(1)}</Text><Text size={200} style={muted}>MB/s, 5-min average</Text></span></div>
      <div style={{ paddingLeft: 44, paddingBottom: 22 }}><div role="img" aria-label={aria} style={{ position: "relative", height: H, display: "flex", alignItems: "flex-end", gap: 2, borderBottom: `2px solid ${T.colorNeutralStroke1}` }}>
        <Ylines top={top} fmt={v => `${v}`} />
        {avg > 0 && <span style={{ position: "absolute", left: 0, right: 0, bottom: Math.min(H, avg * 60 / 1e6 / top * H), borderTop: `2px dashed ${T.colorBrandStroke1}`, zIndex: 2 }} />}
        {mb.map((m, i) => <span key={i} title={`${lab(mins[i])} · ${Math.round(m)} MB${i === 59 ? " (this minute, so far)" : ""}`} style={{ flex: 1, height: Math.max(m > 0 ? 2 : 0, Math.min(H, m / top * H)), background: i === 59 ? C.BRAND : C.TRIP, borderRadius: "2px 2px 0 0" }} />)}
        <div style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 5, display: "flex", justifyContent: "space-between" }}>{[0, 15, 30, 45, 59].map(i => <Text key={i} size={200} style={faint}>{lab(mins[i])}</Text>)}</div></div></div></div>;
  }
  let past = null, table = null;
  if (syncs) {
    const t = s => parseT(s.time.slice(0, 19)), day = syncs.filter(s => Date.now() - t(s) < 86400e3), inc = day.filter(s => !s.success).length;
    const last = syncs.slice(0, 41).reverse(), top = Math.max(1500, Math.ceil(Math.max(0, ...last.map(s => s.mb)) / 500) * 500), gb = v => (v / 1000).toFixed(1);
    const xl = last.map((s, i) => i % 10 === 0 || i === last.length - 1 ? s : null).filter(Boolean).map((s, k) => { const d = t(s); return k === 0 ? `${mo3(d)} ${d.getDate()} ${hm(d)}` : hm(d); });
    past = <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, marginBottom: 10, flexWrap: "wrap" }}><div><Text size={400} weight="semibold" block>Past uploads</Text><Text size={200} style={muted}>Size of the last {last.length} uploads</Text></div>
        <div style={{ display: "flex", gap: 8 }}><Badge appearance="tint" color="informative" shape="rounded">{day.length} today</Badge><Badge appearance="tint" color="informative" shape="rounded">{fmtGB1(day.reduce((a, s) => a + s.mb * 1e6, 0))} moved</Badge>{inc > 0 && <Badge appearance="tint" color="warning" shape="rounded">{inc} incomplete</Badge>}</div></div>
      {last.length > 0 ? <div style={{ paddingLeft: 52, paddingBottom: 22 }}><div role="img" aria-label={`Size of the last ${last.length} uploads, oldest first; ${last.filter(s => !s.success).length} incomplete. The table below lists them.`} style={{ position: "relative", height: H, display: "flex", alignItems: "flex-end", gap: 3, borderBottom: `2px solid ${T.colorNeutralStroke1}` }}>
        <Ylines top={top} fmt={v => `${gb(v)} GB`} />
        {last.map((s, i) => <span key={i} title={`${s.success ? "Done" : "Incomplete"} · ${fmtB(s.mb * 1e6)}`} style={{ flex: 1, height: Math.max(2, Math.min(H, s.mb / top * H)), background: s.success ? C.TRIP : C.AMBER, borderRadius: "2px 2px 0 0" }} />)}
        <div style={{ position: "absolute", left: 0, right: 0, top: "100%", marginTop: 5, display: "flex", justifyContent: "space-between" }}>{xl.map((x, i) => <Text key={i} size={200} style={faint}>{x}</Text>)}</div></div></div>
        : <Text size={300} style={muted}>No uploads recorded yet.</Text>}</div>;
    const shownRows = all ? syncs : syncs.slice(0, 6);
    table = <>
      <Table size="small" aria-label="Past uploads"><TableHeader><TableRow>{["Started", "Type", "Files", "Size", "Duration", "Speed", "Result"].map(h => <TableHeaderCell key={h}>{h}</TableHeaderCell>)}</TableRow></TableHeader>
        <TableBody>{shownRows.map((s, i) => { const d = t(s); return <TableRow key={i}><TableCell>{mo3(d)} {d.getDate()} · {hms(d)}</TableCell><TableCell>{s.kind === "events" ? "Saved and Sentry" : s.kind === "recent" ? "Recent footage" : s.kind}</TableCell>
          <TableCell>{s.files}</TableCell><TableCell>{fmtB(s.mb * 1e6)}</TableCell><TableCell>{fmtDur(s.duration_s || 0)}</TableCell><TableCell>{s.mb_per_s} MB/s</TableCell>
          <TableCell>{s.success ? <Badge appearance="tint" color="success" shape="rounded" icon={<CheckmarkCircle16Filled />}>Done</Badge> : <Badge appearance="tint" color="warning" shape="rounded" icon={<Warning16Filled />}>Incomplete</Badge>}</TableCell></TableRow>; })}</TableBody></Table>
      {syncs.length > 6 && !all && <Button appearance="outline" size="small" onClick={() => setAll(true)} style={{ alignSelf: "flex-start" }}>Show all {syncs.length} uploads</Button>}</>;
  }
  return <Card style={{ padding: "18px 22px", gap: 14 }}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,380px),1fr))", gap: 28 }}>{hour || <Spinner size="small" />}{past}</div>
    {table}
  </Card>;
}
