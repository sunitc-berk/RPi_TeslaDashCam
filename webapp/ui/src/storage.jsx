// Storage - the PC drive as a ring (what the footage is, what is free, when it fills), footage per day, and a few key numbers.
import React, { useEffect, useState } from "react";
import { Text, Card, Divider, Spinner } from "@fluentui/react-components";
import { api, todayStr, addDays, parseT, mo3, plural, fmtGB1 } from "./lib.js";
import { useCrumb } from "./shell.jsx";
import { T, useColors } from "./theme.js";
const phone = () => document.documentElement.dataset.phone === "1";   // a phone column is too narrow for "Nov 10"

const muted = { color: T.colorNeutralForeground2 };
const Num = ({ v, u, size = 800 }) => <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}><Text size={size} weight="semibold" style={{ fontVariantNumeric: "tabular-nums" }}>{v}</Text>{u && <Text size={400} style={muted}>{u}</Text>}</span>;
const Dot = ({ c, s = 11 }) => <span style={{ display: "inline-block", width: s, height: s, borderRadius: "50%", flex: "none", background: c }} />;
// sizes: 777 GB, 73.4 GB, 1.2 TB - no more digits than mean anything
const sz = v => v >= 1000 ? [(v / 1000).toFixed(1), "TB"] : [v >= 100 ? String(Math.round(v)) : v.toFixed(1), "GB"];
const szt = v => sz(v).join(" ");

export function Storage() {
  useCrumb([["Storage"]]);
  const C = useColors();
  const [d, setD] = useState(null);
  useEffect(() => { Promise.all([api("/api/storage"), api("/api/summary")]).then(([s, sum]) => setD({ s, sum })).catch(() => setD({ err: true })); }, []);
  if (!d) return <Spinner label="Measuring…" style={{ marginTop: 40 }} />;
  if (d.err) return <Card><Text weight="semibold">Could not read the storage figures.</Text></Card>;
  const { s, sum } = d, k = sum.by_kind || {}, footGB = sum.gb || 0, freeGB = sum.pc_disk_free_gb || 0;
  const tripsGB = k.recent?.gb || 0, sentryGB = k.sentry?.gb || 0, savedGB = k.saved?.gb || 0;
  const byDay = {};
  s.by_day.forEach(r => { if (!r.d) return; const x = byDay[r.d] = byDay[r.d] || { recent: 0, saved: 0, sentry: 0 }; x[r.kind] = (x[r.kind] || 0) + (r.b || 0) / 1e9; });
  const daysAll = Object.keys(byDay).sort(), today = todayStr(), days = Array.from({ length: 10 }, (_, i) => addDays(today, i - 9));
  const tot = x => byDay[x] ? byDay[x].recent + byDay[x].saved + byDay[x].sentry : 0;
  const histDays = daysAll.length ? Math.round((parseT(today + " 12:00:00") - parseT(daysAll[0] + " 12:00:00")) / 864e5) + 1 : 0;
  const avg = days.reduce((a, x) => a + tot(x), 0) / 10, fd = x => { const q = parseT(x + " 12:00:00"); return `${mo3(q)} ${q.getDate()}`; };
  const removedGB = s.removed.reduce((a, r) => a + (r.b || 0), 0) / 1e9;
  const totalGB = sum.pc_disk_total_gb || footGB + freeGB, otherGB = Math.max(0, totalGB - freeGB - footGB);
  // When does the drive fill? Footage arrives at the 10-day average; once the oldest drive footage is 30 days old,
  // the cleanup removes about a day of drives for every day added, so only Sentry and saved clips keep growing.
  const keepDays = s.keep_days || 30, tripAvg = days.reduce((a, x) => a + (byDay[x]?.recent || 0), 0) / 10;
  const est = (() => { if (!(histDays >= 3 && avg > 0)) return null; let free = freeGB; for (let i = 1; i <= 730; i++) { free -= avg; if (histDays + i > keepDays) free += tripAvg; if (free <= 0) return i; } return Infinity; })();
  const estWords = est == null ? "" : est === Infinity ? "not for 2 years or more" : est < 14 ? `in about ${plural(est, "day")}` : est < 60 ? `in about ${plural(Math.round(est / 7), "week")}` : `in about ${plural(Math.round(est / 30.4), "month")}`;
  const fullDate = est != null && est !== Infinity ? (() => { const q = new Date(); q.setDate(q.getDate() + est); return `${mo3(q)} ${q.getDate()}${q.getFullYear() !== new Date().getFullYear() ? ", " + q.getFullYear() : ""}`; })() : "";
  const parts = [["Trips", tripsGB, C.TRIP, "Includes footage recorded while parked"], ["Sentry clips", sentryGB, C.AMBER], ["Saved clips", savedGB, C.GREEN],
    ...(otherGB / totalGB > 0.01 ? [["Other files", otherGB, C.OTHER, "Everything on this drive that is not dashcam footage"]] : []), ["Free", freeGB, C.FREE]];
  const R = 86, CIRC = 2 * Math.PI * R, ringTot = parts.reduce((a, p) => a + p[1], 0) || 1; let off = 0;
  const allDays = daysAll.map(x => [x, tot(x)]), busiest = allDays.reduce((a, x) => x[1] > a[1] ? x : a, ["", 0]), enc = sum.encrypted_files || 0;
  const maxD = Math.max(...days.map(tot), avg), top = Math.max(50, Math.ceil((maxD * 1.12) / 50) * 50), H = 300, px = v => v / top * H;
  const peak = days.reduce((a, x) => tot(x) > tot(a) ? x : a, days[0]);
  const numbers = [["Average a day", String(Math.round(avg)), "GB", "over the last 10 days"], ["Busiest day", ...(busiest[0] ? [...sz(busiest[1]), fd(busiest[0])] : ["–", "", ""])],
    ["Removed by cleanup", ...sz(removedGB), s.removed.length ? `older than ${keepDays} days` : "nothing removed yet", s.removed.map(r => `${r.d ? fd(r.d) : ""}: ${plural(r.n, "file")}, ${fmtGB1(r.b || 0)}`).join("\n")],
    ...(enc ? [["Encrypted files", enc.toLocaleString(), "", "cannot be played here"]] : [])];
  return <div style={{ display: "grid", gridTemplateColumns: "minmax(300px,400px) minmax(0,1fr)", gap: 20, alignItems: "start" }} className="two">
    <Card style={{ padding: "20px 24px", gap: 0 }} aria-label="This PC's drive"><Text className="display" size={500} weight="semibold">This PC’s drive</Text>
      <div style={{ position: "relative", display: "grid", placeItems: "center", margin: "14px 0 8px" }}><svg viewBox="0 0 220 220" width="250" height="250" role="img" aria-label={parts.map(p => `${p[0]} ${szt(p[1])}`).join(", ")}>
        {parts.map(([l, v, c]) => { const len = v / ringTot * CIRC, vis = Math.max(len - 2, v > 0 ? 1 : 0), el = vis ? <circle key={l} cx="110" cy="110" r={R} fill="none" stroke={c} strokeWidth="26" strokeDasharray={`${vis.toFixed(2)} ${(CIRC - vis).toFixed(2)}`} strokeDashoffset={(-off).toFixed(2)} transform="rotate(-90 110 110)" /> : null; off += len; return el; })}</svg>
        <div style={{ position: "absolute", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center" }}><Num v={sz(footGB)[0]} u={sz(footGB)[1]} /><Text size={200} style={muted}>of {szt(totalGB)} used<br />by footage</Text></div></div>
      {parts.map(([l, v, c, tip], i) => <React.Fragment key={l}>{i > 0 && <Divider />}<div title={tip} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0" }}><Dot c={c} /><Text size={300} style={{ flex: 1 }}>{l}</Text><Text size={300} weight="semibold">{szt(v)}</Text></div></React.Fragment>)}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 10, paddingTop: 14, borderTop: `2px solid ${T.colorNeutralStroke1}`, flexWrap: "wrap" }}>
        {est == null ? <Text size={300} style={muted}>An estimate of when the drive fills needs 3 days of footage.</Text>
          : <><Text size={300} style={muted}>Drive full</Text><Text className="display" size={500} weight="semibold" style={est < 14 ? { color: T.colorBrandForeground1 } : null}>{estWords}</Text>{fullDate && <Text size={300} style={muted}>around {fullDate}</Text>}</>}</div></Card>
    <div style={{ display: "flex", flexDirection: "column", gap: 20, minWidth: 0 }}>
      <Card style={{ padding: "20px 24px", gap: 12 }} aria-label="Footage on the PC by day">
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}><Text className="display" size={500} weight="semibold">Footage by day</Text>
          <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>{[["Trips", C.TRIP], ["Sentry", C.AMBER], ["Saved", C.GREEN]].map(([l, c]) => <span key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 12, height: 12, borderRadius: 2, background: c }} /><Text size={200}>{l}</Text></span>)}
            {avg > 0 && <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 20, borderTop: `2px dashed ${T.colorBrandStroke1}` }} /><Text size={200}>Average, {Math.round(avg)} GB a day</Text></span>}</div></div>
        <div style={{ paddingLeft: 56, paddingBottom: 30 }}><div role="img" aria-label={`Footage per day, ${fd(days[0])} to ${fd(today)}: peak ${Math.round(tot(peak))} GB on ${fd(peak)}, average about ${Math.round(avg)} GB a day.`} style={{ position: "relative", height: H, display: "grid", gridTemplateColumns: "repeat(10,1fr)", gap: 16, borderBottom: `2px solid ${T.colorNeutralStroke1}` }}>
          {[[top, `${top} GB`], [top * .6, Math.round(top * .6)], [top * .2, Math.round(top * .2)]].map(([v, l]) => <span key={v} style={{ position: "absolute", left: 0, right: 0, bottom: px(v), borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{Math.abs(v - avg) / top >= .07 && <Text size={200} style={{ position: "absolute", right: "100%", top: -10, marginRight: 10, whiteSpace: "nowrap", color: T.colorNeutralForeground3 }}>{l}</Text>}</span>)}
          {avg > 0 && <span style={{ position: "absolute", left: 0, right: 0, bottom: px(avg), borderTop: `2px dashed ${T.colorBrandStroke1}`, zIndex: 2 }}><Text size={200} weight="semibold" style={{ position: "absolute", right: "100%", top: -10, marginRight: 10, color: T.colorBrandForeground1 }}>{Math.round(avg)}</Text></span>}
          {days.map(x => { const b = byDay[x] || { recent: 0, saved: 0, sentry: 0 }, t = tot(x), label = t <= 0.005 ? "—" : x === today ? `${Math.round(t)} so far` : Math.round(t);
            return <div key={x} title={`${fd(x)}: trips ${Math.round(b.recent)} GB, saved ${Math.round(b.saved)} GB, Sentry ${Math.round(b.sentry)} GB`} style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <Text size={300} weight={x === peak && t > 0 ? "semibold" : "regular"} style={{ position: "absolute", left: -8, right: -8, bottom: px(t) + 4, textAlign: "center", zIndex: 3, whiteSpace: "nowrap", color: t <= 0.005 ? T.colorNeutralForeground3 : undefined }}>{label}</Text>
              {b.sentry > 0.005 && <span style={{ height: Math.max(1, px(b.sentry)), background: C.AMBER, borderRadius: "3px 3px 0 0", marginBottom: 2 }} />}{b.saved > 0.005 && <span style={{ height: Math.max(1, px(b.saved)), background: C.GREEN, borderRadius: "3px 3px 0 0", marginBottom: 2 }} />}
              {b.recent > 0.005 && <span style={{ height: Math.max(1, px(b.recent)), background: C.TRIP, borderRadius: b.sentry > 0.005 || b.saved > 0.005 ? 0 : "3px 3px 0 0" }} />}
              <Text size={200} style={{ position: "absolute", left: -10, right: -10, top: "100%", marginTop: 8, textAlign: "center", color: x === today ? T.colorNeutralForeground1 : T.colorNeutralForeground2, fontWeight: x === today ? 600 : 400 }}>{phone() && x !== days[0] && !x.endsWith("-01") ? String(+x.slice(8)) : fd(x)}</Text></div>; })}</div></div></Card>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 16 }}>{numbers.map(([l, v, u, sub, tip]) => <Card key={l} title={tip} className="kpi" style={{ padding: "16px 20px", gap: 2 }}><Text className="micro" size={300} style={muted}>{l}</Text><Num v={v} u={u} size={700} /><Text size={200} style={muted}>{sub}</Text></Card>)}</div>
    </div></div>;
}
