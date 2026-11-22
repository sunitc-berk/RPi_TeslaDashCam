// Plates: the licence-plate analysis runs on the GPU machine - progress and vitals, every vehicle they read (with labelling
// in the browser), the scorecard of reading methods against those labels, and the run history.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, Card, Badge, ProgressBar, Button, TabList, Tab, Dropdown, Option, Input, Spinner, Tooltip } from "@fluentui/react-components";
import { api, post, fmtDur, CAM_SHORT, CAMS, MO, setParams } from "./lib.js";
import { useCrumb, useShell } from "./shell.jsx";
import { T, useColors } from "./theme.js";
import { Lines, Bars, HBars, Ring, Area } from "./charts.jsx";

const muted = { color: T.colorNeutralForeground2 }, faint = { color: T.colorNeutralForeground3 }, tab = { fontVariantNumeric: "tabular-nums" }, RED = T.colorPaletteRedForeground1;
const Num = ({ v, u, size = 800, color }) => <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}><Text size={size} weight="semibold" style={{ color, ...tab, lineHeight: 1.1 }}>{v}</Text>{u && <Text size={400} style={muted}>{u}</Text>}</span>;
const STAGE_NAMES = { clips: "Reading clips", subset: "Sampling experiments", vlm: "Vision models", report: "Writing the report", enhance: "Enhancement experiment" };
const MODEL_SHORT = m => (m || "").replace(/:latest$/, "").replace(/^richardyoung\//, "");
const n0 = v => (v == null ? "–" : Math.round(v).toLocaleString());
const dur = s => s == null ? "–" : s < 60 ? `${Math.round(s)} s` : s < 3600 ? `${Math.floor(s / 60)} min${Math.round(s % 60) ? ` ${Math.round(s % 60)} s` : ""}` : fmtDur(s);
const BUCKETS = { day: "Day", twilight: "Twilight", night: "Night" };
const when = t => { const m = /(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(t.clip || ""); if (!m) return t.clip || ""; const h = +m[4], hh = h % 12 || 12; return `${MO[+m[2] - 1].slice(0, 3)} ${+m[3]}, ${hh}:${m[5]} ${h < 12 ? "am" : "pm"} +${Math.round(t.first_sec || 0)}s`; };
const media = (run, f) => `/plates-media/${encodeURIComponent(run)}/${encodeURIComponent(f)}`;
const Section = ({ title, sub, right, children }) => <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
  <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}><Text className="display" size={500} weight="semibold" style={{ whiteSpace: "nowrap" }}>{title}</Text>{sub && <Text size={300} style={muted}>{sub}</Text>}<span style={{ flex: 1 }} />{right}</div>
  {children}
</div>;

export function Plates({ params }) {
  useCrumb([["Plates"]]);
  const C0 = useColors(), sh = useShell() || {}, phone = !!sh.phone;
  const C = { ...C0, BRAND: C0.dark ? T.colorBrandForeground1 : C0.BRAND };   // the light accent is near-black in some designs: on a dark page the lines need the dark-mode brand
  const [runs, setRuns] = useState(null);
  const [run, setRun] = useState(params?.get("run") || "");
  const [view, setView] = useState(params?.get("tab") || "overview");
  const [st, setSt] = useState(null);
  const pickRun = r => { setRun(r); setParams({ tab: view, run: r }); };
  const pickView = v => { setView(v); setParams({ tab: v, run }); };

  useEffect(() => {
    const a = () => api("/api/plates/runs").then(r => { setRuns(r); if (!run && r.runs.length) { const live = r.runs.find(x => x.live) || r.runs.find(x => x.kind === "bench" && !x.name.endsWith("smoke")) || r.runs[0]; setRun(live.name); } }).catch(() => setRuns({ runs: [] }));
    a(); const i = setInterval(() => { if (!document.hidden) a(); }, 30000);
    return () => clearInterval(i);
  }, []);   // eslint-disable-line
  useEffect(() => {
    if (!run) return;
    const a = () => api(`/api/plates/status?run=${encodeURIComponent(run)}`).then(setSt).catch(() => setSt({ available: false }));
    a(); const i = setInterval(() => { if (!document.hidden) a(); }, 5000);
    return () => clearInterval(i);
  }, [run]);

  if (!runs) return null;
  const runInfo = (runs.runs || []).find(r => r.name === run);
  const noRuns = !runs.runs.length;

  const top = <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
    <TabList selectedValue={view} onTabSelect={(e, d) => pickView(d.value)} size={phone ? "small" : "medium"} aria-label="Section">
      <Tab value="overview">Overview</Tab><Tab value="vehicles">Vehicles</Tab><Tab value="scorecard">Scorecard</Tab><Tab value="runs">Runs</Tab>
    </TabList>
    <span style={{ flex: 1 }} />
    {!noRuns && <Dropdown size="small" value={run ? `${run}${runInfo?.live ? " · running" : ""}` : "run"} selectedOptions={[run]} onOptionSelect={(e, d) => pickRun(d.optionValue)} style={{ minWidth: 180 }} aria-label="Run">
      {runs.runs.filter(r => r.kind === "bench").map(r => <Option key={r.name} value={r.name} text={r.name}>{r.name}{r.live ? " · running" : ""}</Option>)}
    </Dropdown>}
  </div>;

  if (noRuns) return <>{top}<Card style={{ padding: "16px 20px", gap: 6 }}><Text className="display" size={600} weight="semibold" block>No analysis run yet</Text><Text size={300} style={muted}>The GPU machine writes each run into a folder under {runs.root}. Start one there and this page follows it.</Text></Card></>;
  if (!st) return top;

  return <>
    {top}
    {view === "overview" && <Overview st={st} run={run} runInfo={runInfo} runs={runs} C={C} phone={phone} />}
    {view === "vehicles" && <Vehicles run={run} st={st} C={C} phone={phone} params={params} />}
    {view === "scorecard" && <Scorecard run={run} st={st} C={C} phone={phone} />}
    {view === "runs" && <Runs runs={runs} pick={r => { pickRun(r); pickView("overview"); }} C={C} />}
  </>;
}

// ------------------------------------------------------------------------------------------------ overview
const STAGE_MIN = { clips: 50, subset: 14, vlm: 38, report: 9, enhance: 100 };
const RUN = "#0E8A4F";   // the run's own colour: progress ring and the stage in flight (green; done stages are the same green, solid)   // rough share of a run, for the stage bar's widths
const zone = (p, warn, bad) => p >= bad ? "bad" : p >= warn ? "warn" : "ok";
const kfmt = v => v == null ? "–" : v >= 10000 ? `${(v / 1000).toFixed(1)}k` : Math.round(v).toLocaleString();

// a log-scaled bar per step, so the small end of the funnel stays visible
// a bar with its percentage written inside the track: on the bar when the bar is long enough, just after it when not
function PctBar({ w, pct, color, opacity = 1, height = 20 }) {
  const onBar = w >= 30, label = pct == null ? null : `${pct < 1 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`;
  return <div style={{ position: "relative", height, borderRadius: height / 3, background: T.colorNeutralBackground3, overflow: "hidden" }}>
    <div style={{ width: `${w}%`, height: "100%", borderRadius: height / 3, background: color, opacity, transition: "width .6s" }} />
    {label && <Text size={100} weight="semibold" style={{ position: "absolute", top: 0, lineHeight: `${height}px`, ...tab, ...(onBar ? { right: `${100 - w}%`, marginRight: 7, color: "#fff" } : { left: `${w}%`, marginLeft: 7, color: T.colorNeutralForeground2 }) }}>{label}</Text>}
  </div>;
}

function Funnel({ steps, C }) {
  const top = Math.max(10, ...steps.map(s => s.v || 0));
  return <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
    {steps.map((s, i) => <div key={s.label} style={{ display: "grid", gridTemplateColumns: "118px 1fr auto", alignItems: "center", gap: 12 }}>
      <Text size={300} style={muted}>{s.label}</Text>
      <PctBar w={Math.max(4, Math.log10(Math.max(1, s.v || 0)) / Math.log10(top) * 100)} pct={s.pct} color={s.color || C.BRAND} opacity={s.color ? 1 : 1 - 0.12 * i} />
      <Text size={300} weight="semibold" style={{ ...tab, whiteSpace: "nowrap" }}>{kfmt(s.v)}{s.note && <Text size={200} style={faint}> {s.note}</Text>}</Text>
    </div>)}
  </div>;
}

function Overview({ st, run, runInfo, runs, C, phone }) {
  const [charts, setCharts] = useState(null), [tele, setTele] = useState(null);
  const ZONE = { ok: C.GREEN, warn: C.AMBER, bad: RED };
  useEffect(() => {
    const a = () => { api(`/api/plates/charts?run=${encodeURIComponent(run)}`).then(setCharts).catch(() => {}); api(`/api/plates/telemetry?run=${encodeURIComponent(run)}&points=${phone ? 120 : 240}`).then(setTele).catch(() => {}); };
    a(); const i = setInterval(() => { if (!document.hidden && runInfo?.live) a(); }, 60000);
    return () => clearInterval(i);
  }, [run, runInfo?.live, phone]);
  const prog = st.progress, stage = prog?.stages?.[prog.current];
  const allDone = prog && Object.values(prog.stages || {}).every(s => s.done >= s.total);
  const running = prog && prog.age_s < 180 && !allDone, finished = prog && allDone;
  // the gauges follow live.json, which the run's telemetry thread rewrites every second; the rest of the page every 5 s
  const [live, setLive] = useState(null);
  useEffect(() => {
    if (!running) { setLive(null); return; }
    const a = () => { if (!document.hidden) api(`/api/plates/live?run=${encodeURIComponent(run)}`).then(r => setLive(r.sample && r.age_s < 30 ? r.sample : null)).catch(() => {}); };
    a(); const i = setInterval(a, 1000);
    return () => clearInterval(i);
  }, [run, running]);
  const sys = live || prog?.system;
  const pct = runInfo?.pct ?? (stage ? Math.min(100, 100 * stage.done / Math.max(1, stage.total)) : 0);
  const clipsDone = st.clips?.done || 0, clipsAll = Object.values(st.clips || {}).reduce((a, b) => a + b, 0);
  const vlmAsked = (st.vlm || []).reduce((a, m) => a + m.asked, 0), vlmAns = (st.vlm || []).reduce((a, m) => a + m.answered, 0);
  const reads = Object.fromEntries((st.reads || []).map(r => [r.reader, r.n]));
  const meta = st.meta;

  let title, sub;
  if (!st.available) { title = "Nothing here yet"; sub = "No database in this run's folder yet."; }
  else if (finished) { title = "Run finished"; sub = `${n0(clipsDone)} clips · ${n0(st.tracks?.n)} vehicles · ${n0(st.tracks?.with_plate)} with a plate · ${fmtDur(prog.elapsed_s)} in all`; }
  else if (!running) { title = "Run stopped"; sub = prog ? `last heard ${fmtDur(prog.age_s)} ago in "${STAGE_NAMES[prog.current] || prog.current}" · resumes where it stopped when started again` : "No progress file yet."; }
  else { title = `${STAGE_NAMES[prog.current] || prog.current} · ${n0(stage?.done)} of ${n0(stage?.total)}`; sub = `${stage?.eta_s != null ? `about ${fmtDur(stage.eta_s)} left in this stage · ` : ""}${fmtDur(prog.elapsed_s)} so far${prog.started ? ` · started ${new Date((prog.started > 1e12 ? prog.started : prog.started * 1000)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : ""}`; }
  const ringColor = finished ? C.GREEN : running ? C.GREEN : T.colorNeutralForeground3;

  // the stage bar: green done, brand in progress (with a pale remainder), grey ahead
  const stagesArr = Object.entries(prog?.stages || {});
  const stageBar = stagesArr.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <div style={{ display: "flex", gap: 4 }}>{stagesArr.map(([k, s]) => { const d = s.total ? s.done / s.total : 0; return <div key={k} style={{ flex: STAGE_MIN[k] || 10, height: 12, borderRadius: 6, background: d >= 1 ? C.GREEN : d > 0 ? `linear-gradient(90deg, ${C.GREEN} ${d * 100}%, ${C.GREEN}33 ${d * 100}%)` : T.colorNeutralBackground3, transition: "background .6s" }} />; })}</div>
    <div style={{ display: "flex", gap: 4 }}>{stagesArr.map(([k, s]) => <Text key={k} size={100} style={{ ...faint, flex: STAGE_MIN[k] || 10, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{STAGE_NAMES[k] || k}{s.done >= s.total ? " ✓" : s.done > 0 ? ` · ${Math.round(100 * s.done / Math.max(1, s.total))}%` : ""}</Text>)}</div>
  </div>;

  // gauges: percent of capacity, coloured by zone
  const g = sys ? [
    ["CPU", sys.cpu_pct, `${Math.round(sys.cpu_pct ?? 0)}%`, zone(sys.cpu_pct, 70, 90), sys.cpu_temp_c != null ? `${Math.round(sys.cpu_temp_c)} °C` : ""],
    ["GPU", sys.gpu_util, `${Math.round(sys.gpu_util ?? 0)}%`, zone(sys.gpu_util, 85, 97), sys.gpu_power_w != null ? `${Math.round(sys.gpu_power_w)} W` : ""],
    ["VRAM", sys.vram_total_gb ? 100 * sys.vram_used_gb / sys.vram_total_gb : 0, `${Math.round(sys.vram_total_gb ? 100 * sys.vram_used_gb / sys.vram_total_gb : 0)}%`, zone(sys.vram_total_gb ? 100 * sys.vram_used_gb / sys.vram_total_gb : 0, 80, 92), sys.vram_total_gb ? `${sys.vram_used_gb?.toFixed(1)} / ${sys.vram_total_gb} GB` : ""],
    ["RAM", sys.ram_total_gb ? 100 * sys.ram_used_gb / sys.ram_total_gb : 0, `${Math.round(sys.ram_total_gb ? 100 * sys.ram_used_gb / sys.ram_total_gb : 0)}%`, zone(sys.ram_total_gb ? 100 * sys.ram_used_gb / sys.ram_total_gb : 0, 75, 90), sys.ram_total_gb ? `${Math.round(sys.ram_used_gb)} / ${Math.round(sys.ram_total_gb)} GB` : ""],
    ["GPU °C", sys.gpu_temp_c != null ? sys.gpu_temp_c / 90 * 100 : 0, sys.gpu_temp_c != null ? `${Math.round(sys.gpu_temp_c)}°` : "–", zone(sys.gpu_temp_c ?? 0, 75, 84), "of 90° max"],
  ] : [];
  const gauges = sys && <div title={live ? "updated every second" : "from the last progress update"} style={{ display: "flex", gap: phone ? 10 : 14, flexWrap: "wrap", justifyContent: phone ? "space-between" : "flex-end" }}>
    {g.map(([l, p, txt, z, subt]) => <div key={l} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}><Ring pct={p} color={ZONE[z]} size={phone ? 64 : 80} stroke={phone ? 6 : 8} label={txt} sub={l} />{!phone && <Text size={100} style={faint}>{subt}</Text>}</div>)}
  </div>;

  const head = <Card style={{ padding: phone ? "14px 16px" : "18px 22px", gap: 14 }}>
    <div style={{ display: "flex", gap: phone ? 14 : 26, alignItems: "center", flexWrap: phone ? "wrap" : "nowrap" }}>
      <Ring pct={pct} color={ringColor} size={phone ? 104 : 148} stroke={phone ? 10 : 14} label={`${Math.floor(pct)}%`} sub="of the run" />
      <div style={{ flex: 1, minWidth: 220, display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <Badge appearance={running ? "filled" : "outline"} color={running ? "success" : finished ? "brand" : "informative"} shape="rounded">{running ? "Running" : finished ? "Done" : "Idle"}</Badge>
          <Text className="display" size={phone ? 500 : 600} weight="semibold">{title}</Text></div>
        <Text size={200} style={muted}>{sub}{meta ? ` · ${meta.machine} · ${(meta.gpu || "").replace("NVIDIA GeForce ", "")}` : ""}{prog ? ` · progress ${prog.age_s < 60 ? "just updated" : `${fmtDur(prog.age_s)} old`}` : ""}</Text>
        {stageBar}
      </div>
      {!phone && gauges}
    </div>
    {phone && gauges}
    {st.errors?.length > 0 && <Text size={200} style={{ color: RED }}>{st.errors.length} clip error{st.errors.length > 1 ? "s" : ""} · latest: {st.errors[0].name} — {st.errors[0].err}</Text>}
  </Card>;

  const funnel = st.available && <Card style={{ padding: "16px 20px", gap: 12 }}>
    <div><Text size={400} weight="semibold" block>From footage to plates</Text><Text size={200} style={faint}>how much survives each step</Text></div>
    <Funnel C={C} steps={[{ label: "Clips", v: clipsDone, note: `of ${n0(clipsAll)}`, pct: clipsAll ? 100 * clipsDone / clipsAll : null },
      { label: "Frames", v: st.frames, note: "sampled", pct: clipsDone ? Math.min(100, 100 * (st.frames || 0) / (clipsDone * 120)) : null },
      { label: "Vehicles", v: st.tracks?.n, note: "tracked", pct: st.frames ? Math.min(100, 100 * (st.tracks?.n || 0) / st.frames) : null },
      { label: "With a plate", v: st.tracks?.with_plate, note: "of vehicles", color: C.BRAND, pct: st.tracks?.n ? 100 * (st.tracks.with_plate || 0) / st.tracks.n : null },
      { label: "Confident reads", v: reads.cct_s ?? reads.mobilevit, note: "of plates · cct reader", color: C.BRAND, pct: st.tracks?.with_plate ? Math.min(100, 100 * (reads.cct_s ?? reads.mobilevit ?? 0) / st.tracks.with_plate) : null },
      { label: "Vision answers", v: vlmAns, note: `of ${n0(vlmAsked)} asked`, color: C.BRAND, pct: vlmAsked ? 100 * vlmAns / vlmAsked : null },
      { label: "Labelled by you", v: st.labelled, note: "of plates", color: C.AMBER, pct: st.tracks?.with_plate ? 100 * (st.labelled || 0) / st.tracks.with_plate : null }]} />
    <Text size={100} style={faint}>bar length is on a log scale so the small end stays visible · the percentage is of the step before it (frames: of the ~120 per clip; vehicles: per frame)</Text>
    {(st.vlm || []).length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}><Text size={300} weight="semibold" style={{ whiteSpace: "nowrap" }}>Vision models</Text><Text size={200} style={faint}>plates answered, and time per plate</Text></div>
      {(st.vlm || []).slice().sort((a, b) => (b.answered / Math.max(1, b.asked)) - (a.answered / Math.max(1, a.asked))).map(m => { const share = m.asked ? m.answered / m.asked : 0, sec = m.avg_s;
        const speed = sec == null ? null : sec < 1 ? ["fast", C.GREEN] : sec < 10 ? ["steady", C.AMBER] : ["slow", RED];
        return <div key={m.model} style={{ display: "grid", gridTemplateColumns: "118px 1fr auto auto", alignItems: "center", gap: 10 }}>
          <Text size={200} style={muted} truncate>{MODEL_SHORT(m.model)}</Text>
          <PctBar w={Math.round(share * 100)} pct={share * 100} color={C.BRAND} height={16} />
          <Text size={200} style={{ ...tab, whiteSpace: "nowrap", minWidth: 86, textAlign: "right" }}><b>{n0(m.answered)}</b><span style={faint}> of {n0(m.asked)}</span></Text>
          <span title={speed ? `${sec} s per plate` : "no timing yet"} style={{ display: "inline-flex", alignItems: "center", gap: 5, minWidth: 74, justifyContent: "flex-end" }}><span style={{ width: 8, height: 8, borderRadius: 4, background: speed ? speed[1] : T.colorNeutralStroke1 }} /><Text size={200} style={{ ...tab, color: speed ? speed[1] : T.colorNeutralForeground3, whiteSpace: "nowrap" }}>{sec == null ? "–" : sec >= 10 ? `${Math.round(sec)} s` : `${sec} s`}</Text></span>
        </div>; })}
      <Text size={100} style={faint}>bar = share of plates answered · dot = speed per plate: green under 1 s, amber under 10 s, red slower</Text>
    </div>}
  </Card>;

  // the machine over the run: six smoothed areas, current value beside each
  const rows = tele?.rows || [], tl = rows.length ? [(rows[0].time || "").slice(11, 16), "now"] : null;
  const ser = k => rows.map(r => r[k]);
  const lastOf = k => { if (live && live[k] != null) return live[k]; const v = ser(k).filter(x => x != null); return v.length ? v[v.length - 1] : null; };
  const teleCard = rows.length > 2 && <Card style={{ padding: "16px 20px", gap: 12 }}>
    <div><Text size={400} weight="semibold" block>The machine, over the run</Text><Text size={200} style={faint}>{tele.samples.toLocaleString()} samples · one point every {tele.every_s >= 60 ? `${Math.round(tele.every_s / 60)} min` : `${tele.every_s} s`} · smoothed</Text></div>
    <div style={{ display: "grid", gridTemplateColumns: phone ? "1fr" : "repeat(3, 1fr)", gap: "14px 26px" }}>
      <Area id="gpu" title="GPU load" values={ser("gpu_util")} color="#F97066" yMax={100} labels={tl} value={`${Math.round(lastOf("gpu_util") ?? 0)} %`} />
      <Area id="cpu" title="CPU load" values={ser("cpu_pct")} color={T.colorPaletteBlueForeground2} yMax={100} labels={tl} value={`${Math.round(lastOf("cpu_pct") ?? 0)} %`} />
      <Area id="vram" title="VRAM" values={ser("vram_used_gb")} color={RED} yMax={sys?.vram_total_gb || undefined} labels={tl} value={`${(lastOf("vram_used_gb") ?? 0).toFixed(1)} GB`} />
      <Area id="ram" title="RAM" values={ser("ram_used_gb")} color={T.colorPaletteTealForeground2} yMax={sys?.ram_total_gb || undefined} labels={tl} value={`${(lastOf("ram_used_gb") ?? 0).toFixed(1)} GB`} />
      <Area id="temp" title="GPU temperature" values={ser("gpu_temp_c")} color={C.AMBER} yMax={90} labels={tl} value={`${Math.round(lastOf("gpu_temp_c") ?? 0)} °C`} />
      <Area id="pow" title="GPU power" values={ser("gpu_power_w")} color={C.GREEN} labels={tl} value={`${Math.round(lastOf("gpu_power_w") ?? 0)} W`} />
    </div>
  </Card>;

  // findings: this run against the others, then this run's distributions
  const ch = charts || {};
  const benchRuns = (runs?.runs || []).filter(r => r.kind === "bench" && r.tracks).slice().reverse();
  const widthOrder = ["<40", "40-60", "60-80", "80-110", "110-160", "160+"];
  const pw = widthOrder.map(b => ({ label: `${b}`, v: (ch.plate_width || []).find(x => x.bucket === b)?.n || 0 }));
  const cams = CAMS.map(c => { const rs = (ch.per_camera || []).filter(x => x.camera === c); const tr = rs.reduce((a, x) => a + x.tracks, 0), wp = rs.reduce((a, x) => a + x.with_plate, 0); return { label: CAM_SHORT[c], v: wp, text: `${n0(wp)} of ${n0(tr)}` }; }).sort((a, b) => b.v - a.v);
  const stages = (st.timings || []).filter(t => t.s > 0).slice(0, 8).map(t => ({ label: t.stage.replace(/^read_/, "read "), v: t.s, text: dur(t.s) }));
  const exps = ch.experiments || {};
  const sampling = ["fps1", "fps2", "fps4", "fps8", "keyframes"].filter(m => exps.sampling?.[m]).map(m => ({ mode: m, ...exps.sampling[m] }));
  const found = st.available && <Card style={{ padding: "16px 20px", gap: 16 }}>
    <div><Text size={400} weight="semibold" block>Findings</Text><Text size={200} style={faint}>this run against earlier ones, then what this run saw</Text></div>
    <div style={{ display: "grid", gridTemplateColumns: phone ? "1fr" : "repeat(3, 1fr)", gap: "18px 28px" }}>
      {benchRuns.length > 0 && <HBars title="Vehicles with a plate, per run" items={benchRuns.map(r => ({ label: r.name, v: r.with_plate, color: r.name === run ? C.BRAND : T.colorNeutralForeground3, text: `${n0(r.with_plate)} · ${n0(r.clips_done)} clips` }))} />}
      <Bars title="Plate size" sub="widest box per vehicle, px" items={pw} color={C.BRAND} />
      <HBars title="Plates per camera" items={cams} color={C.BRAND} />
      {stages.length > 0 && <HBars title="Where the time goes" sub="per stage" items={stages} color={C.OTHER} />}
      {sampling.length > 0 && <Bars title="Sampling experiment" sub="confident reads per mode" items={sampling.map(s => ({ label: s.mode, v: s.reads }))} color={C.OTHER} />}
      {sampling.length > 0 && <Bars title="Sampling experiment" sub="seconds per mode" items={sampling.map(s => ({ label: s.mode, v: Math.round(s.seconds) }))} color={C.OTHER} />}
    </div>
  </Card>;

  return <>{head}<div style={{ display: "grid", gridTemplateColumns: phone ? "1fr" : "minmax(0, 1fr) minmax(0, 1.5fr)", gap: 16, alignItems: "start" }}>{funnel}{teleCard}</div>{found}</>;
}

// ------------------------------------------------------------------------------------------------ vehicles
function Vehicles({ run, st, C, phone, params }) {
  const per = phone ? 24 : 48;
  const [f, setF] = useState({ camera: "", bucket: "", min_pw: 0, q: "", labelled: "", sort: "newest", color: "" });
  const [page, setPage] = useState(0), [data, setData] = useState(null), [pick, setPick] = useState(params?.get("track") ? +params.get("track") : null);
  const qs = useMemo(() => new URLSearchParams({ run, ...Object.fromEntries(Object.entries(f).filter(([, v]) => v !== "" && v !== 0)), limit: per, offset: page * per }).toString(), [run, f, page, per]);
  useEffect(() => {
    const b = () => api(`/api/plates/tracks?${qs}`).then(setData).catch(() => {});
    b(); const i = setInterval(() => { if (!document.hidden && page === 0 && f.sort === "newest") b(); }, 15000);
    return () => clearInterval(i);
  }, [qs]);   // eslint-disable-line
  const set = k => v => { setF(x => ({ ...x, [k]: v })); setPage(0); };
  const items = data?.items || [];
  const onLabel = (id, truth, state) => setData(d => d ? { ...d, items: d.items.map(t => t.id === id ? { ...t, truth, truth_state: state } : t), labelled: d.labelled } : d);

  const sel = (label, k, opts) => <Dropdown size="small" value={opts.find(o => o[0] === f[k])?.[1] || label} selectedOptions={[f[k]]} onOptionSelect={(e, d) => set(k)(d.optionValue)} style={{ minWidth: phone ? 120 : 140 }} aria-label={label}>
    {opts.map(([v, l]) => <Option key={v} value={v} text={l}>{l}</Option>)}</Dropdown>;
  const filters = <div className="plfilters" style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
    {sel("Any camera", "camera", [["", "Any camera"], ...CAMS.map(c => [c, CAM_SHORT[c]])])}
    {sel("Any light", "bucket", [["", "Any light"], ["day", "Day"], ["twilight", "Twilight"], ["night", "Night"]])}
    {sel("Any size", "min_pw", [[0, "Any size"], [40, "Plate ≥ 40 px"], [60, "≥ 60 px"], [80, "≥ 80 px"], [110, "≥ 110 px"]])}
    {sel("Labelled or not", "labelled", [["", "Labelled or not"], ["yes", "Labelled"], ["no", "Not labelled"]])}
    {sel("Newest first", "sort", [["newest", "Newest first"], ["oldest", "Oldest first"], ["biggest", "Biggest plate"], ["smallest", "Smallest plate"], ["sharpest", "Sharpest"], ["clip", "By clip time"]])}
    <Input size="small" placeholder="Plate text…" value={f.q} onChange={(e, d) => set("q")(d.value)} style={{ width: phone ? "100%" : 150 }} aria-label="Search plate text" />
  </div>;

  const readLine = t => {
    const parts = [];
    for (const [k, v] of Object.entries(t.fast || {})) if (v) parts.push([k, v.text, v.format_ok, v.score]);
    for (const [k, v] of Object.entries(t.vlm || {})) if (v && v !== "ERR") parts.push([MODEL_SHORT(k), v, null, null]);
    return parts;
  };
  const grid = <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${phone ? 150 : 210}px, 1fr))`, gap: 12 }}>
    {items.map(t => <Card key={t.id} className="plcard" onClick={() => { setPick(t.id); setParams({ tab: "vehicles", run, track: t.id }); }} style={{ padding: 0, gap: 0, overflow: "hidden", cursor: "pointer", outline: pick === t.id ? `2px solid ${C.BRAND}` : undefined }}>
      <div style={{ position: "relative", background: "#111", aspectRatio: "4 / 3" }}>
        <img src={media(run, t.best_context)} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        <img src={media(run, t.best_crop)} alt="" loading="lazy" style={{ position: "absolute", left: 6, bottom: 6, width: "46%", borderRadius: 4, boxShadow: T.shadow8, border: "2px solid rgba(255,255,255,.9)" }} />
        <span style={{ position: "absolute", right: 6, top: 6, display: "flex", gap: 4 }}>{t.truth && <Badge appearance="filled" color="success" shape="rounded" size="small">{t.truth_state ? `${t.truth_state} ` : ""}{t.truth}</Badge>}{!t.truth && t.state_vote && <Badge appearance="tint" color="brand" shape="rounded" size="small">{t.state_vote.state}{t.state_vote.of > 1 ? ` ·${t.state_vote.votes}/${t.state_vote.of}` : ""}</Badge>}<Badge appearance="filled" color="informative" shape="rounded" size="small">{CAM_SHORT?.[t.camera] || t.camera}</Badge></span>
      </div>
      <div style={{ padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        <Text size={200} style={faint} block truncate>{when(t)} · {t.bucket} · plate {t.best_plate_w}px{t.sharp_best != null ? ` · sharp ${Math.round(t.sharp_best)}` : ""}</Text>
        {readLine(t).length ? readLine(t).slice(0, 3).map(([k, v, ok]) => <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><Text size={200} style={muted} truncate>{k}</Text><Text size={300} weight="semibold" style={{ ...tab, color: t.truth ? (v === t.truth ? C.GREEN : RED) : ok === false ? C.AMBER : undefined }}>{v}</Text></div>)
          : <Text size={200} style={muted}>plate found, no read yet</Text>}
      </div>
    </Card>)}
  </div>;

  return <>
    {pick != null && <Detail run={run} id={pick} C={C} phone={phone} onClose={() => { setPick(null); setParams({ tab: "vehicles", run }); }} onMove={id => { setPick(id); setParams({ tab: "vehicles", run, track: id }); }} onLabel={onLabel} />}
    <Section title="Vehicles" sub={data ? `${n0(data.total)} with a plate${data.labelled ? ` · ${n0(data.labelled)} labelled` : ""} · tap one to label it` : ""}
      right={<><Button appearance="subtle" size="small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Previous</Button><Button appearance="subtle" size="small" disabled={!data || (page + 1) * per >= (data.total || 0)} onClick={() => setPage(p => p + 1)}>Next</Button></>}>
      {filters}
      {data ? (items.length ? grid : <Text size={300} style={muted}>No vehicles match.</Text>) : <Spinner size="small" />}
    </Section>
  </>;
}

// one vehicle in full: pictures, every read, the vision models, and the label box
function Detail({ run, id, C, phone, onClose, onMove, onLabel }) {
  const [t, setT] = useState(null), [truth, setTruth] = useState(""), [saving, setSaving] = useState(false), [prep, setPrep] = useState("pad_up"), [crop, setCrop] = useState(null);
  const inp = useRef(null);
  useEffect(() => { setT(null); api(`/api/plates/track/${id}?run=${encodeURIComponent(run)}`).then(d => { setT(d); setTruth(d.truth ? `${d.truth_state ? d.truth_state + " " : ""}${d.truth}` : ""); setCrop(null); setTimeout(() => inp.current?.focus(), 50); }).catch(() => {}); }, [id, run]);
  useEffect(() => { const el = document.getElementById("pldetail"); if (el && !phone) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [id]);   // eslint-disable-line
  if (!t) return <Card id="pldetail" style={{ padding: 16 }}><Spinner size="small" label="Loading vehicle…" /></Card>;
  const save = async (val, next) => {
    const v = (val ?? truth).toUpperCase().replace(/[^A-Z0-9? ]/g, "").trim();
    setSaving(true);
    try { const r = await post("/api/plates/label", { run, track_id: id, truth: v }); setTruth(r.truth ? `${r.state ? r.state + " " : ""}${r.truth}` : ""); setT(x => ({ ...x, truth: r.truth || null, truth_state: r.state || null })); onLabel(id, r.truth || null, r.state || null); if (next && t.next_id) onMove(t.next_id); }
    catch (e) { /* the grid will show the old value */ }
    setSaving(false);
  };
  const frames = {};   // sec -> reader -> best read for the chosen prep
  for (const r of t.reads) if (r.prep === prep && r.detector === "alpr_v9t") { const f = frames[r.sec] = frames[r.sec] || { sec: r.sec, pw: r.pw }; if (!f[r.reader] || (r.conf || 0) > (f[r.reader].conf || 0)) f[r.reader] = r; }
  const readers = [...new Set(t.reads.map(r => r.reader))].sort(), secs = Object.values(frames).sort((a, b) => a.sec - b.sec);
  const preps = [...new Set(t.reads.map(r => r.prep))];
  const plateTruth = (truth || "").replace(/^[A-Z]{2} /, "");
  const col = txt => plateTruth ? (txt === plateTruth ? C.GREEN : txt ? RED : undefined) : undefined;
  const stCol = st => t.truth_state ? (st === t.truth_state ? C.GREEN : st ? RED : undefined) : undefined;
  const confText = c => c == null ? "" : `${Math.round(c * 100)}`;
  const kept = t.crops || [], mainCrop = crop || (kept[0]?.file) || t.best_crop;
  const boxes = t.boxes || [], bsec = boxes.map(b => `${b.sec}s`);
  const fastLine = Object.entries(t.fast || {}).filter(([, v]) => v);
  return <Card id="pldetail" style={{ padding: 16, gap: 12 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
      <Text size={400} weight="semibold">{when(t)} · {CAM_SHORT[t.camera] || t.camera} · {t.bucket}</Text>
      <Text size={200} style={faint}>#{t.id}</Text><span style={{ flex: 1 }} />
      <Button appearance="subtle" size="small" disabled={!t.prev_id} onClick={() => onMove(t.prev_id)}>← Previous</Button>
      <Button appearance="subtle" size="small" disabled={!t.next_id} onClick={() => onMove(t.next_id)}>Next →</Button>
      <Button appearance="subtle" size="small" onClick={onClose}>Close</Button>
    </div>
    <div className="two" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.1fr) minmax(280px,1fr)", gap: 16, alignItems: "start" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <img src={media(run, t.best_context)} alt="" style={{ width: "100%", borderRadius: 10, display: "block" }} />
        <Text size={200} style={muted}>{t.clip} · seen in {t.n_frames} frames ({Math.round(t.first_sec)}–{Math.round(t.last_sec)} s) · vehicle up to {t.max_w}px wide{t.cls ? ` · ${t.cls}` : ""}{t.color ? ` · ${t.color}` : ""}{t.entry_side ? ` · entered on the ${t.entry_side}, left on the ${t.exit_side}` : ""}{t.mean_dw != null ? ` · ${t.mean_dw > 0.5 ? "approaching" : t.mean_dw < -0.5 ? "receding" : "steady"}` : ""}</Text>
        {boxes.length > 1 && <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <Lines title="Plate sharpness" sub="per frame" height={60} labels={bsec} series={[{ name: "sharpness", color: C.BRAND, values: boxes.map(b => b.sharpness) }]} />
          <Lines title="Plate width" sub="px per frame" height={60} labels={bsec} series={[{ name: "px", color: C.OTHER, values: boxes.map(b => b.pw) }]} />
        </div>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <img src={media(run, mainCrop)} alt="" style={{ width: "100%", borderRadius: 8, display: "block", imageRendering: "auto" }} />
        {kept.length > 1 && <div style={{ display: "flex", gap: 6, overflowX: "auto" }}>{kept.map(k => <div key={k.file} onClick={() => setCrop(k.file)} style={{ flex: "none", width: 92, cursor: "pointer", outline: (crop || kept[0].file) === k.file ? `2px solid ${C.BRAND}` : `1px solid ${T.colorNeutralStroke2}`, borderRadius: 6, overflow: "hidden" }}>
          <img src={media(run, k.file)} alt="" style={{ width: "100%", display: "block" }} /><Text size={100} style={{ ...faint, padding: "0 4px" }} block truncate>{k.sec}s · {k.pw}px · sharp {Math.round(k.sharp)}</Text></div>)}</div>}
        <Text size={200} style={muted}>plate box {t.best_plate_w}px, detector {Math.round((t.best_det_conf || 0) * 100)}%{t.sharp_best != null ? ` · sharpness ${Math.round(t.sharp_best)}` : ""}{t.n_plate_frames ? ` · plate seen in ${t.n_plate_frames} frames` : ""}</Text>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "10px 12px", borderRadius: 8, background: T.colorNeutralBackground3 }}>
          <Text size={300} weight="semibold">True plate</Text>
          <Input ref={inp} size="medium" value={truth} onChange={(e, d) => setTruth(d.value.toUpperCase())} onKeyDown={e => { if (e.key === "Enter") save(undefined, true); }} placeholder="NV 593ZKU · Enter = save & next" style={{ width: 210, ...tab, fontWeight: 600, letterSpacing: 1 }} aria-label="True plate, state first" />
          <Button appearance="primary" size="small" disabled={saving} onClick={() => save(undefined, false)}>Save</Button>
          <Button appearance="secondary" size="small" disabled={saving} onClick={() => save("?", true)}>Unreadable</Button>
          {t.truth && <Button appearance="subtle" size="small" disabled={saving} onClick={() => save("", false)}>Clear</Button>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 14px" }}>
          {fastLine.map(([k, v]) => <React.Fragment key={k}><Text size={300} style={muted}>{k}</Text><Text size={400} weight="semibold" style={{ ...tab, color: col(v.text) ?? (v.format_ok === false ? C.AMBER : undefined) }}>{v.text}<Text size={200} style={faint}> · vote {v.score}{(t.format_states?.[k] || []).length ? ` · pattern fits ${t.format_states[k].join(" / ")}` : ""}</Text></Text></React.Fragment>)}
          {(t.vlm || []).map(m => <React.Fragment key={m.model}><Text size={300} style={muted}>{MODEL_SHORT(m.model)}</Text>
            <Tooltip content={m.raw || ""} relationship="description"><Text size={400} weight="semibold" style={{ ...tab }}>{m.state && <span style={{ color: stCol(m.state), marginRight: 6 }}>{m.state}</span>}<span style={{ color: col(m.text) }}>{m.text}</span><Text size={200} style={faint}> · {m.seconds} s{m.tok_s ? ` · ${m.tok_s} tok/s` : ""}{m.think_off ? " · thinking off" : ""}</Text></Text></Tooltip></React.Fragment>)}
          {(t.state_vote || t.state_clip) && <><Text size={300} style={muted}>state</Text><Text size={300}>{t.state_vote ? <><b style={{ color: stCol(t.state_vote.state) }}>{t.state_vote.state}</b> <span style={faint}>{t.state_vote.votes} of {t.state_vote.of} models</span></> : <span style={faint}>no model named one</span>}{t.state_clip ? <span style={faint}> · plate design looks like <b style={{ color: stCol(t.state_clip) }}>{t.state_clip}</b> ({Math.round((t.state_clip_p || 0) * 100)}%)</span> : null}</Text></>}
        </div>
      </div>
    </div>
    {secs.length > 0 && <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}><Text size={300} weight="semibold">Every read</Text><Text size={200} style={faint}>one row per frame · number is the reader's confidence</Text><span style={{ flex: 1 }} />
        <TabList size="small" selectedValue={prep} onTabSelect={(e, d) => setPrep(d.value)} aria-label="Crop preparation">{preps.map(p => <Tab key={p} value={p}>{p.replace(/_/g, " ")}</Tab>)}</TabList></div>
      <div style={{ overflowX: "auto" }}><table style={{ borderCollapse: "collapse", minWidth: 360 }}><tbody>
        <tr><th style={{ textAlign: "left", padding: "2px 8px", fontSize: 12, color: T.colorNeutralForeground2 }}>frame</th><th style={{ textAlign: "right", padding: "2px 8px", fontSize: 12, color: T.colorNeutralForeground2 }}>px</th>{readers.map(r => <th key={r} style={{ textAlign: "left", padding: "2px 8px", fontSize: 12, color: T.colorNeutralForeground2 }}>{r}</th>)}</tr>
        {secs.map(f => <tr key={f.sec}><td style={{ padding: "2px 8px", fontSize: 13, ...tab, borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{f.sec}s</td><td style={{ padding: "2px 8px", fontSize: 13, ...tab, textAlign: "right", borderTop: `1px solid ${T.colorNeutralStroke2}`, color: T.colorNeutralForeground3 }}>{f.pw}</td>
          {readers.map(r => { const x = f[r]; return <td key={r} style={{ padding: "2px 8px", fontSize: 13, ...tab, borderTop: `1px solid ${T.colorNeutralStroke2}`, color: x ? col(x.text) : undefined, opacity: x && (x.conf || 0) < 0.5 ? .55 : 1 }}>{x ? <>{x.text || "·"} <span style={{ color: T.colorNeutralForeground3, fontSize: 11 }}>{confText(x.conf)}{x.ms ? ` · ${Math.round(x.ms)}ms` : ""}</span></> : ""}</td>; })}</tr>)}
      </tbody></table></div>
    </div>}
  </Card>;
}

// ------------------------------------------------------------------------------------------------ scorecard
function Scorecard({ run, st, C, phone }) {
  const [sc, setSc] = useState(null), [fam, setFam] = useState("all");
  useEffect(() => { setSc(null); api(`/api/plates/scorecard?run=${encodeURIComponent(run)}`).then(setSc).catch(() => setSc({ methods: [], labelled: 0 })); }, [run, st.labelled]);
  if (!sc) return <Spinner size="small" />;
  const famOf = m => m.method.startsWith("vlm") ? "vision" : m.method.startsWith("enhance") ? "enhance" : "fast";
  const rows = sc.methods.filter(m => fam === "all" || famOf(m) === fam);
  const bar = (pct, color) => <div style={{ display: "flex", alignItems: "center", gap: 8 }}><div style={{ flex: 1, height: 8, background: T.colorNeutralBackground3, borderRadius: 4, overflow: "hidden", minWidth: 40 }}><div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 4 }} /></div><Text size={200} style={{ ...tab, width: 38, textAlign: "right" }}>{Math.round(pct)}%</Text></div>;
  const th = (s, right) => <th style={{ textAlign: right ? "right" : "left", padding: "4px 8px", fontSize: 12, fontWeight: 600, color: T.colorNeutralForeground2, whiteSpace: "nowrap" }}>{s}</th>;
  const td = (c, right, extra) => <td style={{ padding: "5px 8px", fontSize: 13, ...tab, textAlign: right ? "right" : "left", borderTop: `1px solid ${T.colorNeutralStroke2}`, whiteSpace: "nowrap", ...extra }}>{c}</td>;
  return <Section title="Scorecard" sub={sc.labelled ? `every method against the ${n0(sc.labelled)} plates you have labelled · best first` : "label some vehicles first (Vehicles tab) and every method gets scored here"}
    right={<><TabList size="small" selectedValue={fam} onTabSelect={(e, d) => setFam(d.value)} aria-label="Method family"><Tab value="all">All</Tab><Tab value="fast">Fast readers</Tab><Tab value="vision">Vision models</Tab><Tab value="enhance">Enhancement</Tab></TabList>
      {sc.labelled > 0 && <Button appearance="subtle" size="small" as="a" href={`/api/plates/labels.csv?run=${encodeURIComponent(run)}`}>Download labels</Button>}</>}>
    {sc.labelled > 0 && <Card style={{ padding: "8px 8px", overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: phone ? 560 : 720 }}><tbody>
        <tr>{th("method")}{th("reader")}{th("n", true)}<th style={{ textAlign: "left", padding: "4px 8px", fontSize: 12, fontWeight: 600, color: T.colorNeutralForeground2, width: "20%" }}>exact</th><th style={{ textAlign: "left", padding: "4px 8px", fontSize: 12, fontWeight: 600, color: T.colorNeutralForeground2, width: "16%" }}>within 1 char</th>{th("answered", true)}{th("state right", true)}{th("time / plate", true)}</tr>
        {rows.map((m, i) => { const so = m.method.startsWith("state/"); return <tr key={i}>
          {td(m.method)}{td(m.reader.replace(/:latest$/, ""), false, { color: T.colorNeutralForeground2 })}{td(m.n, true)}
          <td style={{ padding: "5px 8px", borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{so ? <Text size={200} style={faint}>state only</Text> : bar(m.exact_pct, C.GREEN)}</td>
          <td style={{ padding: "5px 8px", borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{so ? "" : bar(m.within1_pct, C.BRAND)}</td>
          {td(so ? "–" : `${Math.round(m.answered_pct)}%`, true)}{td(m.state_pct == null ? "–" : `${Math.round(m.state_pct)}% of ${m.state_n}`, true)}{td(m.ms == null ? "–" : m.ms >= 1000 ? `${(m.ms / 1000).toFixed(1)} s` : `${Math.round(m.ms)} ms`, true)}
        </tr>; })}
        {!rows.length && <tr><td colSpan={7} style={{ padding: 10 }}><Text size={300} style={muted}>Nothing in this family yet.</Text></td></tr>}
      </tbody></table>
    </Card>}
    <Text size={200} style={faint}>exact = the read matches the label character for character · within 1 = one character wrong, missing or extra · answered = gave a plate rather than "?" · state right = the state it named matches the label, over the {sc.state_labelled || 0} labels that carry a state (type it first in the label box: NV 593ZKU) · time = for that one read on the GPU machine, where recorded</Text>
  </Section>;
}

// ------------------------------------------------------------------------------------------------ runs
function Runs({ runs, pick, C }) {
  return <Section title="Runs" sub={`in ${runs.root}`}>
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(min(100%,320px), 1fr))", gap: 12 }}>
      {runs.runs.map(r => { const v = r.run?.versions ? (() => { try { return JSON.parse(r.run.versions); } catch (e) { return {}; } })() : {}; return <Card key={r.name} style={{ padding: "14px 16px", gap: 6, cursor: r.kind === "bench" ? "pointer" : undefined }} onClick={() => r.kind === "bench" && pick(r.name)}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}><Text size={400} weight="semibold">{r.name}</Text><Badge appearance={r.live ? "filled" : "outline"} color={r.live ? "success" : "informative"} shape="rounded" size="small">{r.live ? "running" : r.kind}</Badge>{r.v2 && <Badge appearance="tint" color="brand" shape="rounded" size="small">full data</Badge>}<span style={{ flex: 1 }} />{r.pct != null && <Text size={300} weight="semibold" style={tab}>{Math.round(r.pct)}%</Text>}</div>
        {r.run && <Text size={200} style={muted} block>{r.run.started}{r.run.finished ? ` → ${r.run.finished}` : ""} · {r.run.machine} · {(r.run.gpu || "").replace("NVIDIA GeForce ", "")}{r.run.driver ? ` · driver ${r.run.driver}` : ""} · code {r.run.code_hash}</Text>}
        {!r.run && r.elapsed_s != null && <Text size={200} style={muted} block>{fmtDur(r.elapsed_s)} of work · last update {fmtDur(r.age_s)} ago</Text>}
        {r.kind === "bench" && <Text size={300} block>{n0(r.clips_done)} / {n0(r.clips)} clips · {n0(r.tracks)} vehicles · {n0(r.with_plate)} with a plate · {n0(r.labelled)} labelled</Text>}
        {r.kind === "enhance" && <Text size={300} block>{n0(r.matched)} of {n0(r.tracks)} vehicles found again · results feed the scorecard</Text>}
        {Object.keys(v).length > 0 && <Text size={200} style={faint} block truncate>{Object.entries(v).filter(([, x]) => x).map(([k, x]) => `${k} ${x}`).join(" · ")}</Text>}
        {r.run?.notes && <Text size={200} style={faint} block>{r.run.notes}</Text>}
      </Card>; })}
    </div>
  </Section>;
}
