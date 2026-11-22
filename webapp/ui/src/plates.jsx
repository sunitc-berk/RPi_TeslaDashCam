// Plates: the licence-plate analysis run on the GPU machine - its progress, the machine's vitals, and the vehicles it is reading.
import React, { useEffect, useState } from "react";
import { Text, Card, Badge, ProgressBar, Button, Tooltip } from "@fluentui/react-components";
import { api, fmtDur, CAM_SHORT, MO } from "./lib.js";
import { useCrumb, useShell } from "./shell.jsx";
import { T, useColors } from "./theme.js";

const muted = { color: T.colorNeutralForeground2 }, faint = { color: T.colorNeutralForeground3 };
const Num = ({ v, u, size = 800, color }) => <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}><Text size={size} weight="semibold" style={{ color, fontVariantNumeric: "tabular-nums", lineHeight: 1.1 }}>{v}</Text>{u && <Text size={400} style={muted}>{u}</Text>}</span>;
const STAGE_NAMES = { clips: "Reading clips", subset: "Sampling experiments", vlm: "Vision models", report: "Writing the report" };
const MODEL_SHORT = m => (m || "").replace(/:latest$/, "").replace(/^richardyoung\//, "");
const n0 = v => (v == null ? "–" : Math.round(v).toLocaleString());

export function Plates() {
  useCrumb([["Plates"]]);
  const C = useColors(), sh = useShell() || {}, phone = !!sh.phone;
  const [st, setSt] = useState(null), [recent, setRecent] = useState(null), [page, setPage] = useState(0), [pick, setPick] = useState(null);
  useEffect(() => {
    const a = () => api("/api/plates/status").then(setSt).catch(() => setSt({ available: false }));
    a(); const i = setInterval(() => { if (!document.hidden) a(); }, 5000);
    return () => clearInterval(i);
  }, []);
  useEffect(() => {
    const b = () => api(`/api/plates/recent?limit=${phone ? 24 : 48}&offset=${page * (phone ? 24 : 48)}`).then(r => setRecent(r.items)).catch(() => {});
    b(); const i = setInterval(() => { if (!document.hidden && page === 0) b(); }, 10000);
    return () => clearInterval(i);
  }, [page, phone]);

  if (!st) return null;
  const prog = st.progress, stage = prog?.stages?.[prog.current], sys = prog?.system;
  const running = prog && prog.age_s < 120 && !(prog.current === "report" && stage?.done >= stage?.total);
  const finished = prog && prog.current === "report" && stage?.done >= stage?.total;
  const pct = stage ? Math.min(100, 100 * stage.done / Math.max(1, stage.total)) : 0;
  const clipsDone = st.clips?.done || 0, clipsAll = Object.values(st.clips || {}).reduce((a, b) => a + b, 0);
  const vlmAsked = (st.vlm || []).reduce((a, m) => a + m.asked, 0), vlmAns = (st.vlm || []).reduce((a, m) => a + m.answered, 0);
  const reads = Object.fromEntries((st.reads || []).map(r => [r.reader, r.n]));
  const kpi = (l, v, u) => <div style={{ minWidth: 0 }}><Text size={300} style={muted} block>{l}</Text><Num v={v} u={u} size={600} /></div>;

  // ---- the run
  let title, sub;
  if (!st.available) { title = "No analysis run yet"; sub = `The GPU machine writes its run to ${st.root}. Start the benchmark there and this page follows it.`; }
  else if (finished) { title = "Run finished"; sub = `${n0(clipsDone)} clips, ${n0(st.tracks?.n)} vehicles, ${n0(st.tracks?.with_plate)} with a plate · ${fmtDur(prog.elapsed_s)} in all`; }
  else if (!running) { title = "Run stopped"; sub = prog ? `Last heard ${fmtDur(prog.age_s)} ago in "${STAGE_NAMES[prog.current] || prog.current}" · it resumes where it stopped when started again` : "No progress file yet."; }
  else { title = STAGE_NAMES[prog.current] || prog.current; sub = stage?.eta_s != null ? `${n0(stage.done)} of ${n0(stage.total)} · about ${fmtDur(stage.eta_s)} left in this stage · ${fmtDur(prog.elapsed_s)} so far` : `${n0(stage?.done)} of ${n0(stage?.total)}`; }
  const badge = <Badge appearance={running ? "filled" : "outline"} color={running ? "success" : finished ? "brand" : "informative"} shape="rounded">{running ? "Running" : finished ? "Done" : "Idle"}</Badge>;

  const head = <Card style={{ padding: "16px 20px", gap: 12 }}>
    <div className="uplive" style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>{badge}<Text size={200} style={faint}>GPU machine · refreshes every 5 s{prog ? ` · progress file ${prog.age_s < 60 ? "just updated" : `${fmtDur(prog.age_s)} old`}` : ""}</Text></div>
    <div className="upnums" style={{ display: "flex", alignItems: "baseline", gap: 18, flexWrap: "wrap" }}>
      <Num v={Math.floor(pct)} u="%" size={1000} color={T.colorBrandForeground1} />
      <div style={{ minWidth: 0, flex: 1 }}><Text className="display" size={600} weight="semibold" block>{title}</Text><Text size={300} style={muted} block>{sub}</Text></div>
    </div>
    <ProgressBar value={pct / 100} thickness="large" />
    {st.available && <div className="upkpis" style={{ display: "flex", gap: 22, flexWrap: "wrap", marginTop: 4 }}>
      {kpi("Clips", `${n0(clipsDone)} / ${n0(clipsAll)}`)}{kpi("Frames", n0(st.frames))}{kpi("Vehicles", n0(st.tracks?.n))}{kpi("With a plate", n0(st.tracks?.with_plate))}
      {kpi("Plate boxes", n0(st.plate_boxes))}{kpi("Confident reads", n0(reads.cct_s ?? reads.mobilevit), "cct")}{kpi("Vision answers", `${n0(vlmAns)} / ${n0(vlmAsked)}`)}
    </div>}
    {st.errors?.length > 0 && <Text size={200} style={{ color: C.RED }}>{st.errors.length} clip error{st.errors.length > 1 ? "s" : ""} · latest: {st.errors[0].name} — {st.errors[0].err}</Text>}
  </Card>;

  // ---- the machine
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
      <div className="vbig" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}><Text className="display" size={700} weight="semibold" style={{ lineHeight: 1.1, whiteSpace: "nowrap", color: v.state === "hot" ? C.RED : undefined }}>{v.big}</Text></div>
      <Text className="vsub" size={200} style={muted} block truncate>{v.sub}</Text>
    </Card>)}
  </div>;

  // ---- the models' tallies (fast readers and vision models), compact
  const models = st.available && <Card style={{ padding: "12px 16px", gap: 8 }}>
    <Text size={300} weight="semibold">Readers</Text>
    <div style={{ display: "flex", flexWrap: "wrap", gap: "6px 18px" }}>
      {(st.reads || []).map(r => <Text key={r.reader} size={300}><b>{r.reader}</b> <span style={muted}>{n0(r.n)} confident</span></Text>)}
      {(st.vlm || []).map(m => <Text key={m.model} size={300}><b>{MODEL_SHORT(m.model)}</b> <span style={muted}>{n0(m.answered)} of {n0(m.asked)} read{m.avg_s ? ` · ${m.avg_s} s each` : ""}</span></Text>)}
      {!(st.reads || []).length && !(st.vlm || []).length && <Text size={300} style={muted}>Nothing read yet.</Text>}
    </div>
  </Card>;

  // ---- the vehicles being evaluated
  const when = t => { const m = /(\d{4})-(\d\d)-(\d\d)_(\d\d)-(\d\d)-(\d\d)/.exec(t.clip || ""); if (!m) return t.clip; const h = +m[4], hh = h % 12 || 12; return `${MO[+m[2] - 1].slice(0, 3)} ${+m[3]}, ${hh}:${m[5]} ${h < 12 ? "am" : "pm"} +${Math.round(t.first_sec || 0)}s`; };
  const readLine = t => {
    const parts = [];
    for (const [k, v] of Object.entries(t.fast || {})) if (v) parts.push([k, v.text, v.format_ok, v.score]);
    for (const [k, v] of Object.entries(t.vlm || {})) if (v && v !== "ERR") parts.push([MODEL_SHORT(k), v, null, null]);
    return parts;
  };
  const grid = <div style={{ display: "grid", gridTemplateColumns: `repeat(auto-fill, minmax(${phone ? 150 : 210}px, 1fr))`, gap: 12 }}>
    {(recent || []).map(t => <Card key={t.id} className="plcard" onClick={() => setPick(t)} style={{ padding: 0, gap: 0, overflow: "hidden", cursor: "pointer" }}>
      <div style={{ position: "relative", background: "#111", aspectRatio: "4 / 3" }}>
        <img src={`/plates-media/${t.best_context}`} alt="" loading="lazy" style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }} />
        <img src={`/plates-media/${t.best_crop}`} alt="" loading="lazy" style={{ position: "absolute", left: 6, bottom: 6, width: "46%", borderRadius: 4, boxShadow: T.shadow8, border: "2px solid rgba(255,255,255,.9)" }} />
        <span style={{ position: "absolute", right: 6, top: 6 }}><Badge appearance="filled" color="informative" shape="rounded" size="small">{CAM_SHORT?.[t.camera] || t.camera}</Badge></span>
      </div>
      <div style={{ padding: "8px 10px 10px", display: "flex", flexDirection: "column", gap: 2 }}>
        <Text size={200} style={faint} block truncate>{when(t)} · {t.bucket} · plate {t.best_plate_w}px</Text>
        {readLine(t).length ? readLine(t).slice(0, 3).map(([k, v, ok]) => <div key={k} style={{ display: "flex", justifyContent: "space-between", gap: 8 }}><Text size={200} style={muted} truncate>{k}</Text><Text size={300} weight="semibold" style={{ fontVariantNumeric: "tabular-nums", color: ok === false ? C.AMBER : undefined }}>{v}</Text></div>)
          : <Text size={200} style={muted}>plate found, no read yet</Text>}
      </div>
    </Card>)}
  </div>;

  const detail = pick && <Card style={{ padding: 16, gap: 10 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}><Text size={400} weight="semibold">{when(pick)} · {pick.camera} · {pick.bucket}</Text><span style={{ flex: 1 }} /><Button appearance="subtle" size="small" onClick={() => setPick(null)}>Close</Button></div>
    <div className="two" style={{ display: "grid", gridTemplateColumns: "minmax(0,1.2fr) minmax(260px,1fr)", gap: 16, alignItems: "start" }}>
      <img src={`/plates-media/${pick.best_context}`} alt="" style={{ width: "100%", borderRadius: 10, display: "block" }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <img src={`/plates-media/${pick.best_crop}`} alt="" style={{ width: "100%", borderRadius: 8, display: "block", imageRendering: "auto" }} />
        <Text size={200} style={muted}>{pick.clip} · seen in {pick.n_frames} frames · vehicle {pick.max_w}px wide · plate box {pick.best_plate_w}px, detector {Math.round((pick.best_det_conf || 0) * 100)}%</Text>
        <div style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "4px 14px" }}>
          {readLine(pick).map(([k, v, ok, sc]) => <React.Fragment key={k}><Text size={300} style={muted}>{k}</Text><Text size={400} weight="semibold" style={{ fontVariantNumeric: "tabular-nums", color: ok === false ? C.AMBER : undefined }}>{v}{sc != null ? <Text size={200} style={faint}> · vote {sc}</Text> : null}{ok ? <Text size={200} style={{ color: C.GREEN }}> · known plate format</Text> : null}</Text></React.Fragment>)}
          {!readLine(pick).length && <Text size={300} style={muted}>No read yet.</Text>}
        </div>
      </div>
    </div>
  </Card>;

  return <>
    {head}
    {machine}
    {models}
    {detail}
    {st.available && <>
      <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}><Text className="display" size={500} weight="semibold" style={{ whiteSpace: "nowrap" }}>Vehicles being evaluated</Text>{!phone && <Text size={300} style={muted}>newest first · tap one for the full picture</Text>}<span style={{ flex: 1 }} />
        <Button appearance="subtle" size="small" disabled={page === 0} onClick={() => setPage(p => p - 1)}>Newer</Button><Button appearance="subtle" size="small" disabled={!recent || recent.length < (phone ? 24 : 48)} onClick={() => setPage(p => p + 1)}>Older</Button></div>
      {recent && recent.length ? grid : <Text size={300} style={muted}>No vehicles with a plate yet.</Text>}
    </>}
  </>;
}
