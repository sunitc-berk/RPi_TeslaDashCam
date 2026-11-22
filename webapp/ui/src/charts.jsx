// Small, quiet charts for the analysis pages: thin marks, recessive grid, labels in text colours.
import React from "react";
import { Text } from "@fluentui/react-components";
import { T } from "./theme.js";

const faint = { color: T.colorNeutralForeground3 }, muted = { color: T.colorNeutralForeground2 };
export const fmtK = v => v == null ? "–" : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : Number.isInteger(v) ? String(v) : v.toFixed(1);

// Several series over the same x positions; each series is {name, values, color}. One y axis, a legend when there is more than one.
export function Lines({ series, labels, height = 110, yMax, yMin = 0, unit = "", title, sub }) {
  const W = 960, H = height, padL = 0, n = Math.max(...series.map(s => s.values.length), 1);
  const vals = series.flatMap(s => s.values).filter(v => v != null);
  const hi = yMax ?? (vals.length ? Math.max(...vals) * 1.08 || 1 : 1), lo = yMin;
  const x = i => padL + (n === 1 ? W / 2 : i / (n - 1) * (W - padL)), y = v => H - (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * H;
  const path = v => { let d = "", pen = false; v.forEach((p, i) => { if (p == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p).toFixed(1)}`; pen = true; }); return d; };
  const ticks = [0, .5, 1].map(f => lo + (hi - lo) * f);
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
    {(title || series.length > 1) && <div style={{ display: "flex", alignItems: "baseline", gap: 12, flexWrap: "wrap" }}>
      {title && <Text size={300} weight="semibold">{title}</Text>}{sub && <Text size={200} style={faint}>{sub}</Text>}<span style={{ flex: 1 }} />
      {series.length > 1 && series.map(s => <span key={s.name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}><span style={{ width: 10, height: 3, borderRadius: 2, background: s.color }} /><Text size={200} style={muted}>{s.name}</Text></span>)}
    </div>}
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" style={{ width: "100%", height: H, display: "block" }}>
        {ticks.map(t => <line key={t} x1={padL} x2={W} y1={y(t)} y2={y(t)} stroke={T.colorNeutralStroke2} strokeWidth="1" vectorEffect="non-scaling-stroke" />)}
        {series.map(s => <path key={s.name} d={path(s.values)} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div style={{ position: "absolute", right: 4, top: 0 }}><Text size={100} style={faint}>{fmtK(hi)}{unit}</Text></div>
      <div style={{ position: "absolute", right: 4, bottom: 0 }}><Text size={100} style={faint}>{fmtK(lo)}{unit}</Text></div>
    </div>
    {labels && <div style={{ display: "flex", justifyContent: "space-between" }}>{[labels[0], labels[Math.floor((labels.length - 1) / 2)], labels[labels.length - 1]].map((l, i) => <Text key={i} size={100} style={faint}>{l}</Text>)}</div>}
  </div>;
}

// Vertical bars with a label under each; values shown on top of the bars.
export function Bars({ items, color, height = 90, unit = "", title, sub, valueText }) {
  const top = Math.max(1, ...items.map(i => i.v || 0));
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
    {title && <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}><Text size={300} weight="semibold">{title}</Text>{sub && <Text size={200} style={faint}>{sub}</Text>}</div>}
    <div style={{ display: "flex", alignItems: "flex-end", gap: 6, height: height + 18 }}>
      {items.map((it, i) => <div key={i} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 2, height: "100%", justifyContent: "flex-end" }}>
        <Text size={100} style={{ ...muted, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{valueText ? valueText(it) : `${fmtK(it.v)}${unit}`}</Text>
        <div style={{ width: "100%", maxWidth: 46, height: Math.max(2, (it.v || 0) / top * height), background: it.color || color, borderRadius: "4px 4px 0 0", opacity: it.dim ? .35 : 1 }} />
      </div>)}
    </div>
    <div style={{ display: "flex", gap: 6 }}>{items.map((it, i) => <Text key={i} size={100} style={{ ...faint, flex: 1, minWidth: 0, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</Text>)}</div>
  </div>;
}

// Horizontal bars: a label, a bar, a value; the right shape for "share per category" and for ranked lists.
export function HBars({ items, color, unit = "", title, sub, max }) {
  const top = max ?? Math.max(1, ...items.map(i => i.v || 0));
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
    {title && <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}><Text size={300} weight="semibold">{title}</Text>{sub && <Text size={200} style={faint}>{sub}</Text>}</div>}
    <div style={{ display: "grid", gridTemplateColumns: "minmax(70px,auto) 1fr auto", gap: "5px 10px", alignItems: "center" }}>
      {items.map((it, i) => <React.Fragment key={i}>
        <Text size={200} style={muted} truncate>{it.label}</Text>
        <div style={{ height: 8, background: T.colorNeutralBackground3, borderRadius: 4, overflow: "hidden" }}><div style={{ width: `${Math.min(100, (it.v || 0) / top * 100)}%`, height: "100%", background: it.color || color, borderRadius: 4 }} /></div>
        <Text size={200} style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>{it.text ?? `${fmtK(it.v)}${unit}`}</Text>
      </React.Fragment>)}
    </div>
  </div>;
}

// Dots: one point per item, for "sharpness against plate width" style views.
export function Dots({ points, height = 140, xLabel, yLabel, color, title, sub }) {
  const W = 960, H = height, xs = points.map(p => p.x), ys = points.map(p => p.y);
  const xmax = Math.max(1, ...xs), ymax = Math.max(1, ...ys);
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
    {title && <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}><Text size={300} weight="semibold">{title}</Text>{sub && <Text size={200} style={faint}>{sub}</Text>}</div>}
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true" style={{ width: "100%", height: H, display: "block" }}>
        {[.25, .5, .75].map(f => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke={T.colorNeutralStroke2} vectorEffect="non-scaling-stroke" />)}
        {points.map((p, i) => <circle key={i} cx={p.x / xmax * (W - 16) + 8} cy={H - p.y / ymax * (H - 12) - 6} r="4" fill={p.color || color} opacity=".7" vectorEffect="non-scaling-stroke" />)}
      </svg>
      <div style={{ position: "absolute", left: 4, top: 0 }}><Text size={100} style={faint}>{yLabel} ↑ {fmtK(ymax)}</Text></div>
      <div style={{ position: "absolute", right: 4, bottom: 0 }}><Text size={100} style={faint}>{xLabel} → {fmtK(xmax)}</Text></div>
    </div>
  </div>;
}
