// Plates: the licence-plate analysis runs on the GPU machine - progress and vitals, every vehicle they read (with labelling
// in the browser), the scorecard of reading methods against those labels, and the run history.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, Card, Badge, ProgressBar, Button, TabList, Tab, Dropdown, Option, Input, Spinner, Tooltip } from "@fluentui/react-components";
import { api, post, fmtDur, CAM_SHORT, CAMS, MO, setParams } from "./lib.js";
import { useCrumb, useShell } from "./shell.jsx";
import { T, useColors } from "./theme.js";
import { Lines, Bars, HBars, Dots } from "./charts.jsx";

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
    {view === "overview" && <Overview st={st} run={run} runInfo={runInfo} C={C} phone={phone} />}
    {view === "vehicles" && <Vehicles run={run} st={st} C={C} phone={phone} params={params} />}
    {view === "scorecard" && <Scorecard run={run} st={st} C={C} phone={phone} />}
    {view === "runs" && <Runs runs={runs} pick={r => { pickRun(r); pickView("overview"); }} C={C} />}
  </>;
}

// ------------------------------------------------------------------------------------------------ overview
function Overview({ st, run, runInfo, C, phone }) {
  const [charts, setCharts] = useState(null), [tele, setTele] = useState(null);
  useEffect(() => {
    const a = () => { api(`/api/plates/charts?run=${encodeURIComponent(run)}`).then(setCharts).catch(() => {}); api(`/api/plates/telemetry?run=${encodeURIComponent(run)}&points=${phone ? 120 : 240}`).then(setTele).catch(() => {}); };
    a(); const i = setInterval(() => { if (!document.hidden && runInfo?.live) a(); }, 60000);
    return () => clearInterval(i);
  }, [run, runInfo?.live, phone]);
  const prog = st.progress, stage = prog?.stages?.[prog.current], sys = prog?.system;
  const allDone = prog && Object.values(prog.stages || {}).every(s => s.done >= s.total);
  const running = prog && prog.age_s < 180 && !allDone;
  const finished = prog && allDone;
  const pct = runInfo?.pct ?? (stage ? Math.min(100, 100 * stage.done / Math.max(1, stage.total)) : 0);
  const clipsDone = st.clips?.done || 0, clipsAll = Object.values(st.clips || {}).reduce((a, b) => a + b, 0);
  const vlmAsked = (st.vlm || []).reduce((a, m) => a + m.asked, 0), vlmAns = (st.vlm || []).reduce((a, m) => a + m.answered, 0);
  const reads = Object.fromEntries((st.reads || []).map(r => [r.reader, r.n]));
  const kpi = (l, v, u) => <div style={{ minWidth: 0 }}><Text size={300} style={muted} block>{l}</Text><Num v={v} u={u} size={600} /></div>;

  let title, sub;
  if (!st.available) { title = "Nothing here yet"; sub = `No database in this run's folder yet.`; }
  else if (finished) { title = "Run finished"; sub = `${n0(clipsDone)} clips, ${n0(st.tracks?.n)} vehicles, ${n0(st.tracks?.with_plate)} with a plate · ${fmtDur(prog.elapsed_s)} in all`; }
  else if (!running) { title = "Run stopped"; sub = prog ? `Last heard ${fmtDur(prog.age_s)} ago in "${STAGE_NAMES[prog.current] || prog.current}" · it resumes where it stopped when started again` : "No progress file yet."; }
  else { title = STAGE_NAMES[prog.current] || prog.current; sub = stage?.eta_s != null ? `${n0(stage.done)} of ${n0(stage.total)} in this stage · about ${fmtDur(stage.eta_s)} left in it · ${fmtDur(prog.elapsed_s)} so far` : `${n0(stage?.done)} of ${n0(stage?.total)}`; }
  const badge = <Badge appearance={running ? "filled" : "outline"} color={running ? "success" : finished ? "brand" : "informative"} shape="rounded">{running ? "Running" : finished ? "Done" : "Idle"}</Badge>;
  const meta = st.meta;

  const head = <Card style={{ padding: "16px 20px", gap: 12 }}>
    <div className="uplive" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{badge}
      <Text size={200} style={faint}>{meta ? `${meta.machine} · ${(meta.gpu || "").replace("NVIDIA GeForce ", "")} · driver ${meta.driver || "?"} · code ${meta.code_hash}` : "GPU machine"} · refreshes every 5 s{prog ? ` · progress file ${prog.age_s < 60 ? "just updated" : `${fmtDur(prog.age_s)} old`}` : ""}</Text></div>
    <div className="upnums" style={{ display: "flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
      <Num v={Math.floor(pct)} u="%" size={1000} color={T.colorBrandForeground1} />
      <div style={{ minWidth: 0, flex: 1 }}><Text className="display" size={600} weight="semibold" block>{title}</Text><Text size={300} style={muted} block>{sub}</Text></div>
    </div>
    <ProgressBar value={pct / 100} thickness="large" />
    {prog?.stages && <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>{Object.entries(prog.stages).map(([k, s]) => <Text key={k} size={200} style={s.done >= s.total ? faint : muted}><b>{STAGE_NAMES[k] || k}</b> {n0(s.done)}/{n0(s.total)}{s.done < s.total && s.eta_s != null ? ` · ${fmtDur(s.eta_s)} left` : s.done >= s.total ? " ✓" : ""}</Text>)}</div>}
    {st.available && <div className="upkpis" style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 4 }}>
      {kpi("Clips", `${n0(clipsDone)} / ${n0(clipsAll)}`)}{kpi("Frames", n0(st.frames))}{kpi("Vehicles", n0(st.tracks?.n))}{kpi("With a plate", n0(st.tracks?.with_plate))}
      {kpi("Plate boxes", n0(st.plate_boxes))}{kpi("Confident reads", n0(reads.cct_s ?? reads.mobilevit), "cct")}{kpi("Vision answers", `${n0(vlmAns)} / ${n0(vlmAsked)}`)}{kpi("Labelled", n0(st.labelled))}
    </div>}
    {st.errors?.length > 0 && <Text size={200} style={{ color: RED }}>{st.errors.length} clip error{st.errors.length > 1 ? "s" : ""} · latest: {st.errors[0].name} — {st.errors[0].err}</Text>}
  </Card>;

  const tile = (t, big, sub, state) => ({ t, big, sub, state });
  const vit = sys ? [
    tile("CPU", sys.cpu_pct != null ? `${Math.round(sys.cpu_pct)} %` : "–", sys.cpu_temp_c != null ? `${Math.round(sys.cpu_temp_c)} °C` : "temperature not exposed by this board", sys.cpu_pct > 90 ? "hot" : "ok"),
    tile("GPU", sys.gpu_util != null ? `${Math.round(sys.gpu_util)} %` : "–", `${sys.gpu_temp_c != null ? `${Math.round(sys.gpu_temp_c)} °C` : ""}${sys.gpu_power_w != null ? ` · ${Math.round(sys.gpu_power_w)} W` : ""}${sys.gpu_clock_mhz ? ` · ${Math.round(sys.gpu_clock_mhz)} MHz` : ""}`, sys.gpu_temp_c > 83 ? "hot" : "ok"),
    tile("VRAM", sys.vram_used_gb != null ? `${sys.vram_used_gb.toFixed(1)} GB` : "–", sys.vram_total_gb ? `of ${sys.vram_total_gb} GB` : "", sys.vram_total_gb && sys.vram_used_gb / sys.vram_total_gb > 0.92 ? "hot" : "ok"),
    tile("RAM", sys.ram_used_gb != null ? `${sys.ram_used_gb} GB` : "–", sys.ram_total_gb ? `of ${sys.ram_total_gb} GB` : "", "ok"),
    tile("Disk", sys.disk_read_mbs != null ? `${sys.disk_read_mbs} / ${sys.disk_write_mbs}` : "–", `read / write MB/s${sys.disk_c_free_gb != null ? ` · ${Math.round(sys.disk_c_free_gb)} GB free on C:` : ""}`, "ok"),
    tile("Network", sys.net_rx_mbs != null ? `${sys.net_rx_mbs} / ${sys.net_tx_mbs}` : "–", "in / out MB/s (clips come over the wire from this PC)", "ok"),
  ] : [];
  const machine = sys && <div className="vitals" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,170px),1fr))", gap: 12 }}>
    {vit.map(v => <Card key={v.t} style={{ padding: "12px 16px", gap: 2 }}>
      <Text size={300} weight="semibold">{v.t}</Text>
      <div className="vbig"><Text className="display" size={700} weight="semibold" style={{ lineHeight: 1.1, whiteSpace: "nowrap", color: v.state === "hot" ? RED : undefined }}>{v.big}</Text></div>
      <Text className="vsub" size={200} style={muted} block truncate>{v.sub}</Text>
    </Card>)}
  </div>;

  // ---- telemetry over the run
  const rows = tele?.rows || [], tl = rows.map(r => (r.time || "").slice(11, 16));
  const ser = (k, name, color) => ({ name, color, values: rows.map(r => r[k]) });
  const teleCharts = rows.length > 2 && <Card style={{ padding: "14px 16px", gap: 14 }}>
    <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}><Text size={400} weight="semibold">Machine over the run</Text><Text size={200} style={faint}>{tele.samples.toLocaleString()} samples, one point every {tele.every_s >= 60 ? `${Math.round(tele.every_s / 60)} min` : `${tele.every_s} s`}</Text></div>
    <div style={{ display: "grid", gridTemplateColumns: phone ? "1fr" : "repeat(auto-fit, minmax(300px, 1fr))", gap: "14px 24px" }}>
      <Lines title="Load" unit="%" yMax={100} labels={tl} series={[ser("gpu_util", "GPU", C.BRAND), ser("cpu_pct", "CPU", C.OTHER)]} />
      <Lines title="Memory" unit=" GB" labels={tl} series={[ser("vram_used_gb", "VRAM", C.BRAND), ser("ram_used_gb", "RAM", C.OTHER)]} />
      <Lines title="GPU temperature" unit="°" yMax={90} labels={tl} series={[ser("gpu_temp_c", "GPU °C", C.AMBER)]} />
      <Lines title="GPU power" unit=" W" labels={tl} series={[ser("gpu_power_w", "W", C.BRAND)]} />
      <Lines title="Footage arriving" unit=" MB/s" labels={tl} series={[ser("net_rx_mbs", "network in", C.BRAND), ser("disk_read_mbs", "disk read", C.OTHER)]} />
    </div>
  </Card>;

  // ---- what the run found
  const ch = charts || {};
  const widthOrder = ["<40", "40-60", "60-80", "80-110", "110-160", "160+"];
  const pw = widthOrder.map(b => ({ label: `${b} px`, v: (ch.plate_width || []).find(x => x.bucket === b)?.n || 0 }));
  const cams = CAMS.map(c => { const rs = (ch.per_camera || []).filter(x => x.camera === c); const tr = rs.reduce((a, x) => a + x.tracks, 0), wp = rs.reduce((a, x) => a + x.with_plate, 0); return { label: CAM_SHORT[c], v: wp, text: `${n0(wp)} of ${n0(tr)}` }; });
  const stages = (st.timings || []).filter(t => t.s > 0).slice(0, 10).map(t => ({ label: t.stage.replace(/^read_/, "read "), v: t.s, text: `${dur(t.s)} · ${t.ms_each} ms each` }));
  const thr = (ch.throughput || []).map(t => ({ label: (t.slot || "").slice(11, 16), v: t.clips }));
  const motion = (ch.motion || []).map(m => ({ label: m.state, v: m.clips, text: `${m.clips} clips · ${n0(m.tracks)} vehicles` }));
  const colors = (ch.colors || []).slice(0, 8).map(c => ({ label: c.color, v: c.n, color: { white: "#d8d8d8", silver: "#a8a8a8", black: "#333", red: "#c8403a", blue: "#3a6fc8", green: "#3f9a5a", yellow: "#d9b23a", orange: "#d9803a", purple: "#8a4fc8", grey: "#888" }[c.color] || C.OTHER }));
  const dots = (ch.sharp_vs_width || []).map(p => ({ x: p.pw, y: p.sharp }));
  const exps = ch.experiments || {};
  const sampling = ["fps1", "fps2", "fps4", "fps8", "keyframes"].filter(m => exps.sampling?.[m]).map(m => ({ mode: m, ...exps.sampling[m] }));
  const dets = Object.entries(exps.detector || {});
  const found = st.available && <Card style={{ padding: "14px 16px", gap: 16 }}>
    <Text size={400} weight="semibold">What the run found</Text>
    <div style={{ display: "grid", gridTemplateColumns: phone ? "1fr" : "repeat(auto-fit, minmax(280px, 1fr))", gap: "18px 28px" }}>
      <Bars title="Plate size" sub="widest box per vehicle" items={pw} color={C.BRAND} />
      <HBars title="Plates per camera" sub="vehicles with a readable-sized plate, of all vehicles seen" items={cams} color={C.BRAND} />
      {stages.length > 0 && <HBars title="Where the time goes" sub="per stage, whole run" items={stages} color={C.OTHER} />}
      {thr.length > 1 && <Bars title="Clips finished" sub="per 10 minutes" items={thr.slice(-24)} color={C.BRAND} />}
      {motion.length > 0 && <HBars title="Car moving or parked" sub="from frame-to-frame motion" items={motion} color={C.OTHER} />}
      {colors.length > 0 && <HBars title="Vehicle colours" items={colors} />}
      {dots.length > 5 && <Dots title="Sharpness against plate size" sub="each dot a vehicle" points={dots} xLabel="plate px" yLabel="sharpness" color={C.BRAND} />}
    </div>
    {(sampling.length > 0 || dets.length > 0) && <div style={{ display: "grid", gridTemplateColumns: phone ? "1fr" : "repeat(auto-fit, minmax(300px, 1fr))", gap: "18px 28px" }}>
      {sampling.length > 0 && <div><Text size={300} weight="semibold" block>Sampling rate experiment</Text><Text size={200} style={faint} block>{sampling[0].clips} clips: frames decoded, time, distinct confident reads</Text>
        <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 6 }}><tbody>
          <tr>{["mode", "frames", "seconds", "vehicles", "reads"].map(h => <th key={h} style={{ textAlign: h === "mode" ? "left" : "right", fontWeight: 600, padding: "2px 6px", fontSize: 12, color: T.colorNeutralForeground2 }}>{h}</th>)}</tr>
          {sampling.map(s => <tr key={s.mode}>{[s.mode, n0(s.frames), n0(s.seconds), n0(s.vehicles), n0(s.reads)].map((v, i) => <td key={i} style={{ textAlign: i ? "right" : "left", padding: "2px 6px", fontSize: 13, ...tab, borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{v}</td>)}</tr>)}
        </tbody></table></div>}
      {dets.length > 0 && <div><Text size={300} weight="semibold" block>Vehicle detector experiment</Text><Text size={200} style={faint} block>vehicles found by width (scaled to 1448 px), and time</Text>
        <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 6 }}><tbody>
          <tr>{["detector", "seconds", "<60", "60-120", "120-250", "≥250"].map(h => <th key={h} style={{ textAlign: h === "detector" ? "left" : "right", fontWeight: 600, padding: "2px 6px", fontSize: 12, color: T.colorNeutralForeground2 }}>{h}</th>)}</tr>
          {dets.map(([k, d]) => <tr key={k}>{[k, n0(d.seconds), n0(d.by_width["<60"]), n0(d.by_width["60-120"]), n0(d.by_width["120-250"]), n0(d.by_width[">=250"])].map((v, i) => <td key={i} style={{ textAlign: i ? "right" : "left", padding: "2px 6px", fontSize: 13, ...tab, borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{v}</td>)}</tr>)}
        </tbody></table></div>}
    </div>}
  </Card>;

  const models = st.available && <Card style={{ padding: "12px 16px", gap: 8 }}>
    <Text size={300} weight="semibold">Readers</Text>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
      {(st.reads || []).map(r => <Text key={r.reader} size={300}><b>{r.reader}</b> <span style={muted}>{n0(r.n)} confident</span></Text>)}
      {(st.vlm || []).map(m => <Text key={m.model} size={300}><b>{MODEL_SHORT(m.model)}</b> <span style={muted}>{n0(m.answered)} of {n0(m.asked)} read{m.avg_s ? ` · ${m.avg_s} s each` : ""}{m.tok_s ? ` · ${m.tok_s} tok/s` : ""}</span></Text>)}
      {!(st.reads || []).length && !(st.vlm || []).length && <Text size={300} style={muted}>Nothing read yet.</Text>}
    </div>
  </Card>;

  return <>{head}{machine}{models}{teleCharts}{found}</>;
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
  const onLabel = (id, truth) => setData(d => d ? { ...d, items: d.items.map(t => t.id === id ? { ...t, truth } : t), labelled: d.labelled } : d);

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
        <span style={{ position: "absolute", right: 6, top: 6, display: "flex", gap: 4 }}>{t.truth && <Badge appearance="filled" color="success" shape="rounded" size="small">{t.truth}</Badge>}<Badge appearance="filled" color="informative" shape="rounded" size="small">{CAM_SHORT?.[t.camera] || t.camera}</Badge></span>
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
  useEffect(() => { setT(null); api(`/api/plates/track/${id}?run=${encodeURIComponent(run)}`).then(d => { setT(d); setTruth(d.truth || ""); setCrop(null); setTimeout(() => inp.current?.focus(), 50); }).catch(() => {}); }, [id, run]);
  useEffect(() => { const el = document.getElementById("pldetail"); if (el && !phone) el.scrollIntoView({ block: "nearest", behavior: "smooth" }); }, [id]);   // eslint-disable-line
  if (!t) return <Card id="pldetail" style={{ padding: 16 }}><Spinner size="small" label="Loading vehicle…" /></Card>;
  const save = async (val, next) => {
    const v = (val ?? truth).toUpperCase().replace(/[^A-Z0-9?]/g, "");
    setSaving(true);
    try { await post("/api/plates/label", { run, track_id: id, truth: v }); setTruth(v); onLabel(id, v || null); if (next && t.next_id) onMove(t.next_id); }
    catch (e) { /* the grid will show the old value */ }
    setSaving(false);
  };
  const frames = {};   // sec -> reader -> best read for the chosen prep
  for (const r of t.reads) if (r.prep === prep && r.detector === "alpr_v9t") { const f = frames[r.sec] = frames[r.sec] || { sec: r.sec, pw: r.pw }; if (!f[r.reader] || (r.conf || 0) > (f[r.reader].conf || 0)) f[r.reader] = r; }
  const readers = [...new Set(t.reads.map(r => r.reader))].sort(), secs = Object.values(frames).sort((a, b) => a.sec - b.sec);
  const preps = [...new Set(t.reads.map(r => r.prep))];
  const col = txt => truth ? (txt === truth ? C.GREEN : txt ? RED : undefined) : undefined;
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
          <Input ref={inp} size="medium" value={truth} onChange={(e, d) => setTruth(d.value.toUpperCase())} onKeyDown={e => { if (e.key === "Enter") save(undefined, true); }} placeholder="type it, Enter = save & next" style={{ width: 170, ...tab, fontWeight: 600, letterSpacing: 1 }} aria-label="True plate" />
          <Button appearance="primary" size="small" disabled={saving} onClick={() => save(undefined, false)}>Save</Button>
          <Button appearance="secondary" size="small" disabled={saving} onClick={() => save("?", true)}>Unreadable</Button>
          {t.truth && <Button appearance="subtle" size="small" disabled={saving} onClick={() => save("", false)}>Clear</Button>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "3px 14px" }}>
          {fastLine.map(([k, v]) => <React.Fragment key={k}><Text size={300} style={muted}>{k}</Text><Text size={400} weight="semibold" style={{ ...tab, color: col(v.text) ?? (v.format_ok === false ? C.AMBER : undefined) }}>{v.text}<Text size={200} style={faint}> · vote {v.score}{v.format_ok ? " · known format" : ""}</Text></Text></React.Fragment>)}
          {(t.vlm || []).map(m => <React.Fragment key={m.model}><Text size={300} style={muted}>{MODEL_SHORT(m.model)}</Text>
            <Tooltip content={m.raw || ""} relationship="description"><Text size={400} weight="semibold" style={{ ...tab, color: col(m.text) }}>{m.text}<Text size={200} style={faint}> · {m.seconds} s{m.tok_s ? ` · ${m.tok_s} tok/s` : ""}{m.think_off ? " · thinking off" : ""}</Text></Text></Tooltip></React.Fragment>)}
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
        <tr>{th("method")}{th("reader")}{th("n", true)}<th style={{ textAlign: "left", padding: "4px 8px", fontSize: 12, fontWeight: 600, color: T.colorNeutralForeground2, width: "22%" }}>exact</th><th style={{ textAlign: "left", padding: "4px 8px", fontSize: 12, fontWeight: 600, color: T.colorNeutralForeground2, width: "18%" }}>within 1 char</th>{th("answered", true)}{th("time / plate", true)}</tr>
        {rows.map((m, i) => <tr key={i}>
          {td(m.method)}{td(m.reader.replace(/:latest$/, ""), false, { color: T.colorNeutralForeground2 })}{td(m.n, true)}
          <td style={{ padding: "5px 8px", borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{bar(m.exact_pct, C.GREEN)}</td>
          <td style={{ padding: "5px 8px", borderTop: `1px solid ${T.colorNeutralStroke2}` }}>{bar(m.within1_pct, C.BRAND)}</td>
          {td(`${Math.round(m.answered_pct)}%`, true)}{td(m.ms == null ? "–" : m.ms >= 1000 ? `${(m.ms / 1000).toFixed(1)} s` : `${Math.round(m.ms)} ms`, true)}
        </tr>)}
        {!rows.length && <tr><td colSpan={7} style={{ padding: 10 }}><Text size={300} style={muted}>Nothing in this family yet.</Text></td></tr>}
      </tbody></table>
    </Card>}
    <Text size={200} style={faint}>exact = the read matches the label character for character · within 1 = one character wrong, missing or extra · answered = gave a plate rather than "?" · ms = time for that one read on the GPU machine, where recorded</Text>
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
