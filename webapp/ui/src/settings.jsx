// Settings - is everything working? Anything that needs you, uploads / the Pi / storage in a line each, the few settings, and what happened lately.
import React, { useEffect, useState } from "react";
import { Text, Card, Button, Divider, Switch, Spinner, MessageBar, MessageBarBody, MessageBarTitle, MessageBarActions, RadioGroup, Radio } from "@fluentui/react-components";
import { CheckmarkCircle20Filled, Warning20Filled, Clock20Regular, ChevronRight20Regular, ArrowSync20Regular } from "@fluentui/react-icons";
import { api, post, LIVE, THEME, useStore, upState, fmtB, gbText, whenWords, durWords, plural, todayStr, parseT, mo3, toast, setDark, cap1 } from "./lib.js";
import { useCrumb } from "./shell.jsx";
import { T, useColors } from "./theme.js";
import { DESIGN, DESIGNS, DESIGN_ORDER, setDesign } from "./designs.js";

const muted = { color: T.colorNeutralForeground2 };
const NUM_WORDS = ["No", "One", "Two", "Three", "Four", "Five"];
const dismissed = k => { try { return localStorage.getItem("teslacam.hide." + k) || ""; } catch (e) { return ""; } };
export const dismiss = (k, stamp) => { try { localStorage.setItem("teslacam.hide." + k, stamp); } catch (e) {} toast("Hidden. It comes back if it happens again."); };
// a warning in one line; Details opens the explanation and the fix
export function Notice({ i, onHide }) {
  const [open, setOpen] = useState(false);
  return <MessageBar intent={i.key === "job" ? "error" : "warning"} layout={open ? "multiline" : "singleline"} style={{ padding: open ? "6px 16px 12px" : "2px 16px" }}>
    <MessageBarBody><MessageBarTitle>{i.title}</MessageBarTitle>{open && <><br />{i.body}{i.fix ? <> <b>Fix:</b> {i.fix}</> : null}</>}</MessageBarBody>
    <MessageBarActions>{open && i.cta && <Button size="small" appearance="primary" as="a" href={i.cta[1]}>{i.cta[0]}</Button>}
      <Button size="small" appearance="subtle" onClick={() => setOpen(!open)}>{open ? "Less" : "Details"}</Button>
      {!i.sticky && <Button size="small" appearance="subtle" onClick={onHide}>Hide</Button>}</MessageBarActions></MessageBar>;
}
// "Oct 31 – Nov 3, Nov 6 and Nov 7"
function dayRanges(days) {
  const d = days.map(s => parseT(s + " 12:00:00")), runs = [];
  d.forEach((x, i) => { if (i && Math.round((x - d[i - 1]) / 864e5) === 1) runs[runs.length - 1][1] = x; else runs.push([x, x]); });
  const f = x => `${mo3(x)} ${x.getDate()}`, parts = runs.map(([a, b]) => a === b ? f(a) : `${f(a)} – ${a.getMonth() === b.getMonth() ? b.getDate() : f(b)}`);
  return parts.length > 1 ? parts.slice(0, -1).join(", ") + " and " + parts[parts.length - 1] : parts[0] || "";
}
// everything that needs the person: the Pi page shows job / lost / quiet, Settings shows the rest
export function systemIssues(s, live) {
  const out = [], u = upState(live);
  const JOBS = { archive: ["The Pi is not saving drive footage", "The part of the Pi that copies drive footage off the car's drive stopped working"], sync: ["The Pi is not uploading", "The part of the Pi that uploads footage stopped working"] };
  if (s.job_failed) { const j = JOBS[s.job_failed.job] || [`The Pi's ${s.job_failed.job} job is failing`, `The Pi's ${s.job_failed.job} job stopped working`];
    out.push({ key: "job", stamp: s.job_failed.since, title: j[0], body: `${j[1]} ${whenWords(s.job_failed.since)} and has failed every time since. Saved and Sentry clips are not affected.`, fix: "run the Pi installer again (sudo bash ~/pi/install.sh) and read its last lines. It checks itself and says what is missing.", cta: ["See the Pi's log", "#/health"], sticky: true }); }
  if (s.lost.mb > 0 && dismissed("lost") < (s.lost.last || "")) out.push({ key: "lost", stamp: s.lost.last, title: `${gbText(s.lost.mb)} of drives never made it home`,
    body: `On ${dayRanges(s.lost.days)} the Pi's card filled up before the car got back to Wi-Fi, so it deleted its oldest footage to keep recording. The card holds about 2½ hours of driving.`, fix: "a 256 GB card holds about 10 hours.", cta: ["See what happened", "#/health"] });
  if (s.storage.days_left != null && s.storage.days_left < 14 && dismissed("full") < todayStr()) out.push({ key: "full", stamp: todayStr(), title: s.storage.days_left < 1 ? "The PC drive is almost full" : `The PC drive will be full in about ${plural(s.storage.days_left, "day")}`,
    body: `${s.storage.free_gb} GB is free and footage arrives at about ${Math.round(s.storage.gb_per_day)} GB a day. Drive footage is removed by itself after ${s.retention_days} days, except what you keep.`, cta: ["See storage", "#/storage"] });
  if (s.upload_problems >= 3 && dismissed("upload") < todayStr()) out.push({ key: "upload", stamp: todayStr(), title: "Uploads keep failing", body: `${s.upload_problems} uploads were cut short in the last 6 hours. One failed upload fixes itself; this many usually means the PC is asleep or the Wi-Fi is weak where the car is parked.`, cta: ["See what happened", "#/health"] });
  if (u.st && !u.fresh && u.age > 3 * 86400 && dismissed("quiet") < todayStr()) out.push({ key: "quiet", stamp: todayStr(), title: `The Pi has not checked in for ${Math.round(u.age / 86400)} days`, body: "It reports whenever the car is awake at home. If you have driven since, check that the Pi is still plugged into the car's USB port.", cta: ["See the Pi", "#/health"] });
  return out;
}

export function Settings() {
  useCrumb([["Settings"]]);
  const C = useColors(), live = useStore(LIVE), { dark } = useStore(THEME), { id: design } = useStore(DESIGN);
  const [s, setS] = useState(null), [, bump] = useState(0), [scanning, setScanning] = useState(false);
  const load = () => api("/api/system").then(setS).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!s) return <Spinner label="Checking…" style={{ marginTop: 40 }} />;
  const u = upState(live), st = u.st, w = st?.waiting || {}, wb = (w.recent_bytes || 0) + (w.event_bytes || 0), lu = s.last_upload;
  const issues = systemIssues(s, live).filter(i => i.key !== "lost");
  const upl = u.up ? ["up", `Uploading now, ${Math.floor(u.pct)}% done, ${fmtB(st.bytes_total - u.bytes)} to go.`]
    : wb >= 5e7 ? ["wait", u.fresh ? `${fmtB(wb)} waiting to upload.` : `${fmtB(wb)} is still on the Pi. It continues when the car is next awake at home.`]
    : lu ? ["ok", `Up to date. Last upload ${whenWords(lu.time)}, ${gbText(lu.mb)} in ${durWords(lu.duration_s)}.`] : ["none", "Nothing has been uploaded yet."];
  const temp = u.fresh && st.cpu_temp_c != null ? +st.cpu_temp_c : null, dbm = u.fresh ? st.wifi_dbm : null;
  const facts = [temp != null ? `${temp < 60 ? "cool" : temp < 75 ? "warm" : "hot"} (${Math.round(temp)} °C)` : "", dbm != null ? `${dbm >= -60 ? "strong" : dbm >= -72 ? "fair" : "weak"} Wi-Fi` : ""].filter(Boolean).join(", ");
  const pi = !st ? ["none", "The Pi has not reported yet."] : u.fresh ? ["ok", `Online in the car.${facts ? ` ${cap1(facts)}.` : ""}`] : ["sleep", `Asleep with the car, or away from home. Last heard ${whenWords(new Date(Date.now() - u.age * 1000).toISOString())}.`];
  const dl = s.storage.days_left;
  const sto = [dl != null && dl < 14 ? "wait" : "ok", `${Math.round(s.storage.footage_gb).toLocaleString()} GB of footage on this PC. ` + (dl == null ? `${s.storage.free_gb} GB free.` : dl >= 14 ? `Room for about ${Math.round(dl / 7)} more weeks.` : dl < 1 ? "Almost full." : `Room for about ${plural(dl, "more day", "more days")}.`)];
  const Ic = ({ kind }) => kind === "ok" || kind === "up" ? <CheckmarkCircle20Filled style={{ color: kind === "up" ? T.colorBrandForeground1 : C.GREEN, flex: "none" }} /> : kind === "wait" ? <Warning20Filled style={{ color: C.AMBER, flex: "none" }} /> : <Clock20Regular style={{ color: T.colorNeutralForeground3, flex: "none" }} />;
  const n = issues.length;
  const row = { display: "flex", alignItems: "center", gap: 16, padding: "14px 18px" };
  return <div style={{ maxWidth: 860, width: "100%", margin: "4px auto 0", display: "flex", flexDirection: "column", gap: 16 }}>
    <div className="featured"><Text as="h1" className="display" size={800} weight="semibold" block style={{ margin: 0 }}>{n === 0 ? "Everything is working" : n === 1 ? "One thing needs you" : `${NUM_WORDS[n] || n} things need you`}</Text>
      <Text size={400} style={muted}>{n ? "Everything else is working." : "Footage uploads by itself whenever the car is awake at home."}{live.fetched ? ` Checked ${Math.max(0, Math.round((Date.now() - live.fetched) / 60000)) < 1 ? "just now" : `${Math.round((Date.now() - live.fetched) / 60000)} min ago`}.` : ""}</Text></div>
    {issues.map(i => <Notice key={i.key} i={i} onHide={() => { dismiss(i.key, i.stamp); bump(x => x + 1); }} />)}
    <Card style={{ padding: 0, gap: 0 }}>{[["Uploads", "#/status", upl], ["Raspberry Pi", "#/health", pi], ["Storage", "#/storage", sto]].map(([name, href, [kind, text]], i) => <React.Fragment key={name}>{i > 0 && <Divider />}
      <a href={href} style={{ ...row, padding: "16px 18px", color: "inherit", textDecoration: "none" }}><Ic kind={kind} /><Text size={400} weight="semibold" style={{ flex: "0 0 140px" }}>{name}</Text><Text size={300} style={{ flex: 1, ...muted }}>{text}</Text><ChevronRight20Regular style={{ color: T.colorNeutralForeground3, flex: "none" }} /></a></React.Fragment>)}</Card>
    <Text size={400} weight="semibold" style={{ marginTop: 8 }}>Settings</Text>
    <Card style={{ padding: 0, gap: 0 }}>
      <div style={row}><div style={{ flex: 1, display: "flex", flexDirection: "column" }}><Text size={400} weight="semibold">Name drives by place</Text><Text size={300} style={muted}>{s.place_names ? "The start and end of each drive are looked up once with OpenStreetMap and remembered. Your home is never sent." : "Drives show as “From home” or “Back home”. Turning this on sends the start and end point of each drive (never your home) to OpenStreetMap’s free look-up service, once per place, to get a street name."}</Text></div>
        <Switch label={s.place_names ? "On" : "Off"} labelPosition="before" checked={!!s.place_names} onChange={async (e, d) => { try { const r = await post("/api/settings", { place_names: d.checked }); setS({ ...s, place_names: r.place_names }); toast(r.place_names ? "Place names are on. Names appear over the next few minutes." : "Place names are off."); } catch (err) { toast("Could not change that setting.", "error"); } }} /></div><Divider />
      <div style={{ ...row, alignItems: "flex-start" }}><div style={{ flex: 1, display: "flex", flexDirection: "column" }}><Text size={400} weight="semibold">Look</Text><Text size={300} style={muted}>The design system the dashboard is drawn in. Lovable is the default.</Text></div>
        <RadioGroup layout="horizontal" value={design} onChange={(e, d) => setDesign(d.value)} aria-label="Look">{["house", ...DESIGN_ORDER].map(k => <Radio key={k} value={k} label={DESIGNS[k].name} />)}</RadioGroup></div><Divider />
      <div style={row}><div style={{ flex: 1, display: "flex", flexDirection: "column" }}><Text size={400} weight="semibold">Dark mode</Text><Text size={300} style={muted}>Use dark colours across the dashboard.</Text></div><Switch label={dark ? "On" : "Off"} labelPosition="before" checked={dark} onChange={(e, d) => setDark(d.checked)} /></div><Divider />
      <div style={row}><div style={{ flex: 1, display: "flex", flexDirection: "column" }}><Text size={400} weight="semibold">Rescan footage</Text><Text size={300} style={muted}>The dashboard looks for new footage every few minutes. Use this after copying or deleting files by hand.</Text></div>
        <Button icon={<ArrowSync20Regular />} disabled={scanning} onClick={async () => { setScanning(true); try { await api("/api/reindex", { method: "POST" }); } catch (err) {} setTimeout(() => { setScanning(false); load(); toast("Rescanned."); }, 2500); }}>{scanning ? "Scanning…" : "Rescan now"}</Button></div></Card>
    {s.lately?.length > 0 && <><Text size={400} weight="semibold" style={{ marginTop: 8 }}>Lately</Text>
      <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 4px" }}>{s.lately.map((x, i) => { const text = x.kind === "upload" ? `Uploaded ${plural(x.files, "file")} (${gbText(x.mb)}) of ${x.what === "events" ? "Saved and Sentry clips" : "drive footage"}` : x.kind === "wake" ? "The Pi woke up with the car" : x.kind === "lost" ? `Deleted ${gbText(x.mb)} of drive footage that had not uploaded yet (card full)` : "An upload was cut short and picked up again by itself";
        return <div key={i} style={{ display: "flex", gap: 12 }}><Text size={300} style={{ flex: "0 0 150px", color: T.colorNeutralForeground3 }}>{cap1(whenWords(x.time)).replace(" at ", " ")}</Text><Text size={300}>{text}</Text></div>; })}</div></>}
  </div>;
}
