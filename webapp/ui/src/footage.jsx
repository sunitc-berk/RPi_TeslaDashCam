// Footage - every drive and alert, newest first, grouped by day. The panel on the left chooses what to show and holds the
// month calendar; the map is another view of the same list. "Kept" is the same page for everything kept.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { Text, Card, Badge, CounterBadge, Divider, Nav, NavItem, NavSectionHeader, TabList, Tab, Button, Link, Spinner } from "@fluentui/react-components";
import { Calendar } from "@fluentui/react-calendar-compat";
import { List20Regular, Map20Regular, ChevronRight20Regular, ChevronDown20Regular, ChevronUp20Regular, Eye16Filled, Pin16Filled, Pin16Regular, Dismiss16Regular, VehicleCar24Regular } from "@fluentui/react-icons";
import { api, media, parseT, t12, range12, durWords, milesText, plural, dayLong, dayMid, dayLabel, todayStr, MO, itemTitle, placeText, itemHref, whyText, FAV, useStore, isKept, toggleKeep, useStill, setParams, go, BUS, pad } from "./lib.js";
import { useCrumb, InPanel, InTop, useShell } from "./shell.jsx";
import { T, useColors, CAT } from "./theme.js";
import { streetLayer } from "./maps.js";

const SHOWS = [["all", "Everything"], ["drives", "Drives"], ["parked", "Parked"], ["sentry", "Sentry alerts"], ["saved", "Saved clips"], ["kept", "Kept"]];
const monthName = m => { const [y, mo] = m.split("-"); return `${MO[+mo - 1]} ${y}`; };
// what each choice shows. "Everything" leaves out footage of the car sitting parked at home, and stops under 5 minutes
function shown(items, show, kept) {
  if (kept && show === "all") return items.filter(i => !(i.type === "parked" && i.at_home));
  const f = {
    all: i => i.type === "drive" || i.type === "sentry" || (i.type === "saved" && !i.in_drive) || (i.type === "parked" && !i.at_home && i.dur >= 300),
    drives: i => i.type === "drive", parked: i => i.type === "parked", sentry: i => i.type === "sentry", saved: i => i.type === "saved",
    kept: i => isKept(i.trip || i.id, i.kept) && !(i.type === "parked" && i.at_home),
  }[show];
  return items.filter(f);
}
const countOf = (items, show, kept) => { const l = shown(items, show, kept); return show === "sentry" ? l.reduce((a, i) => a + (i.count || 1), 0) : l.length; };
const byDay = items => { const m = new Map(); items.forEach(i => { const k = i.start.slice(0, 10); (m.get(k) || m.set(k, []).get(k)).push(i); }); return [...m]; };
const dayTitle = s => dayLong(s) + (s.slice(0, 4) !== String(new Date().getFullYear()) ? `, ${s.slice(0, 4)}` : "");
function daySummary(list) {
  const dr = list.filter(i => i.type === "drive"), mi = dr.reduce((a, i) => a + (i.miles || 0), 0);
  const se = list.filter(i => i.type === "sentry").reduce((a, i) => a + (i.count || 1), 0), sv = list.filter(i => i.type === "saved").length, pk = list.filter(i => i.type === "parked").length;
  return [dr.length ? plural(dr.length, "drive") : "", dr.length ? `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} miles` : "", se ? plural(se, "Sentry alert") : "", sv ? plural(sv, "saved clip") : "", !dr.length && pk ? plural(pk, "parked recording") : ""].filter(Boolean).join(", ");
}
function removedSoon(list) {                                  // "Removed in 2 days" for footage about to pass 30 days
  const left = list.filter(i => (i.type === "drive" || i.type === "parked") && !isKept(i.trip || i.id, i.kept) && i.expires_days != null && i.expires_days <= 3).map(i => i.expires_days);
  if (!left.length) return "";
  const n = Math.min(...left);
  return `${n <= 0 ? "Removed today" : n === 1 ? "Removed tomorrow" : `Removed in ${n} days`} unless kept`;
}
const Dot = ({ c, s = 12 }) => <span style={{ display: "inline-block", width: s, height: s, borderRadius: "50%", flex: "none", background: c }} />;
const muted = { color: T.colorNeutralForeground2 };

export function Footage({ params, kept }) {
  const C = useColors(), sh = useShell() || {}, phone = !!sh.phone, closeSheet = sh.closeSheet || (() => {});
  const [data, setData] = useState(null), [err, setErr] = useState(null);
  const showP = params.get("show"), q = kept ? "" : (params.get("q") || "").trim(), month = params.get("month") || "";
  const [show, setShow] = useState(SHOWS.some(s => s[0] === showP) && !(kept && showP === "kept") ? showP : "all");
  const [view, setView] = useState(params.get("view") === "map" ? "map" : "list");
  const [sel, setSel] = useState(params.get("sel") || null);
  const favs = useStore(FAV);                                // re-render when something is kept or un-kept
  const url = `/api/feed?${kept ? "kept=1" : q ? "q=" + encodeURIComponent(q) : "month=" + encodeURIComponent(month)}`;
  useEffect(() => { let on = true; api(url).then(d => on && setData(d)).catch(e => on && setErr(e)); return () => { on = false; }; }, [url]);
  useEffect(() => {                                           // after keeping / un-keeping something, the counts and the Kept page follow
    const f = () => api(url).then(setData).catch(() => {});
    BUS.addEventListener("favchange", f); return () => BUS.removeEventListener("favchange", f);
  }, [url]);
  useCrumb(kept ? [["Kept"]] : q ? [["Footage", "#/drives"], ["Search"]] : month ? [["Footage", "#/drives"], [monthName(month)]] : [["Footage"]]);
  useEffect(() => { if (data) setParams({ ...(kept ? {} : { month: data.q ? "" : data.month, q: data.q }), show: show === "all" ? "" : show, view: view === "map" ? "map" : "", sel: view === "map" ? sel || "" : "" }); }, [data, show, view, sel]);   // eslint-disable-line
  const jumpTo = params.get("day");
  const items = useMemo(() => data ? shown(data.items, show, kept) : [], [data, show, kept, favs]);
  const bodyRef = useRef();
  useEffect(() => { if (data && jumpTo && view === "list") { if (!jumpToDay(bodyRef.current, jumpTo) && show !== "all") setShow("all"); } }, [data, jumpTo, view, show]);
  if (err) return <Card><Text weight="semibold">Could not load the footage list.</Text><Text style={muted}>{String(err.message)}</Text></Card>;
  if (!data) return <Spinner label="Loading footage…" style={{ marginTop: 40 }} />;
  const shows = SHOWS.filter(([k]) => !(kept && k === "kept"));
  return <>
    <InTop><TabList selectedValue={view} onTabSelect={(e, d) => { setView(d.value); setSel(null); }} size="medium" aria-label="View">
      <Tab value="list" icon={<List20Regular />}>List</Tab><Tab value="map" icon={<Map20Regular />}>Map</Tab></TabList></InTop>
    <InPanel>
      <div style={{ flex: "none" }}><Nav selectedValue={show} onNavItemSelect={(e, d) => { setShow(d.value); setSel(null); closeSheet(); }} style={{ background: "transparent", minWidth: 0, width: "100%", height: "auto" }}>
        <NavSectionHeader>Show</NavSectionHeader>
        {shows.map(([k, l]) => <NavItem key={k} value={k} icon={<Dot c={k === "all" ? T.colorNeutralForeground1 : k === "kept" ? T.colorNeutralForeground3 : CAT(C, k === "drives" ? "drive" : k === "parked" ? "parked" : k)} />}>
          <span style={{ display: "flex", alignItems: "center", width: "100%", gap: 8 }}><span style={{ flex: 1 }}>{l}</span>
            <CounterBadge count={countOf(data.items, k, kept)} showZero appearance={k === show ? "filled" : "ghost"} color={k === show ? "brand" : "informative"} overflowCount={999} /></span></NavItem>)}
      </Nav></div>
      <Divider style={{ flex: "none" }} />
      {kept ? <Text size={300} style={{ ...muted, padding: "0 14px" }}>Kept footage is never removed. Drive footage you do not keep is removed after {data.keep_days || 30} days.</Text>
        : data.q ? <Text size={300} style={{ ...muted, padding: "0 14px" }}>Showing every month. Clear the search to see the calendar.</Text>
        : data.month ? <MonthCalendar data={data} C={C} onDay={day => { closeSheet(); if (day.slice(0, 7) === data.month) { if (view !== "list") setView("list"); setTimeout(() => { if (!jumpToDay(bodyRef.current, day) && show !== "all") { setShow("all"); setTimeout(() => jumpToDay(bodyRef.current, day), 50); } }, phone ? 250 : 0); } else go("drives", { month: day.slice(0, 7), day, show: show === "all" ? "" : show }); }} /> : null}
    </InPanel>
    {phone && show !== "all" && <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none", padding: "0 2px" }}>
      <Dot c={show === "kept" ? T.colorNeutralForeground3 : CAT(C, show === "drives" ? "drive" : show === "parked" ? "parked" : show)} /><Text size={300}>Showing <b>{SHOWS.find(x => x[0] === show)?.[1]}</b></Text>
      <Button appearance="subtle" size="small" icon={<Dismiss16Regular />} onClick={() => { setShow("all"); setSel(null); }}>Everything</Button></div>}
    {data.q && <div style={{ display: "flex", alignItems: "center", gap: 14, flex: "none" }}>
      <Text size={400}><b>{items.length}</b> {items.length === 1 ? "result" : "results"} for “{data.q}”</Text>
      <Button appearance="subtle" icon={<Dismiss16Regular />} onClick={() => go("drives", {})}>Clear search</Button></div>}
    {!items.length ? <Empty show={show} kept={kept} data={data} />
      : view === "map" ? <MapView items={items} data={data} sel={sel} setSel={setSel} C={C} />
      : <div ref={bodyRef} style={{ display: "flex", flexDirection: "column", gap: 18 }}>
        {byDay(items).map(([day, list]) => <section key={day} data-day-anchor={day} style={{ flex: "none", display: "flex", flexDirection: "column", gap: 10 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "0 4px", flexWrap: "wrap" }}><Text size={500} weight="semibold" className="display dayhead">{dayTitle(day)}</Text><Text size={300} style={muted}>{daySummary(list)}</Text>
            {removedSoon(list) && <Badge appearance="tint" color="warning" shape="rounded" size="large">{removedSoon(list)}</Badge>}</div>
          {phone ? <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>{list.map(it => <Card key={it.id} style={{ padding: 0, gap: 0, overflow: "hidden" }}><Row it={it} C={C} phone /></Card>)}</div>
            : <Card style={{ padding: 0, gap: 0 }}>{list.map((it, i) => <React.Fragment key={it.id}>{i > 0 && <Divider />}<Row it={it} C={C} /></React.Fragment>)}</Card>}</section>)}
        {!kept && !data.q && !data.place_names && data.items.some(i => i.type === "drive" && (!i.frm?.name || !i.to?.name)) &&
          <Text size={300} style={{ ...muted, padding: "0 4px" }}>Drives are named by place when place names are turned on. <Link href="#/system">Turn that on in Settings</Link></Text>}
      </div>}
  </>;
}
function jumpToDay(root, day) {
  const at = root?.querySelector(`[data-day-anchor="${day}"]`); if (!at) return false;
  at.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  const h = at.querySelector(".dayhead"); if (h) { h.classList.remove("flash"); void h.offsetWidth; h.classList.add("flash"); }
  return true;
}
function Empty({ show, kept, data }) {
  const what = { all: "footage", drives: "drives", parked: "parked footage", sentry: "Sentry alerts", saved: "saved clips", kept: "kept footage" }[show];
  const title = kept ? (show === "all" ? "Nothing is kept yet" : `No kept ${what}`) : data.q ? "Nothing matches that search" : data.months.length ? `No ${what} in this month` : "No footage yet";
  const hint = kept ? (show === "all" ? "Open a drive or a clip and choose Keep. Kept footage is never removed." : "Choose Everything to see all kept footage.")
    : data.q ? "Try a street, a city, a weekday or a date like “Nov 4”." : data.months.length ? (show === "all" ? "Pick another month in the calendar." : "Choose Everything, or pick another month in the calendar.") : "Footage appears here after the car comes home and the Pi uploads it.";
  return <Card style={{ padding: "28px 24px", gap: 4, alignItems: "center", textAlign: "center" }}><Text className="display" size={500} weight="semibold">{title}</Text><Text size={300} style={muted}>{hint}</Text></Card>;
}

// ---------------------------------------------------------------- the calendar: dots on days with footage, click a day to jump to it
const MARKS = {};                                             // month -> Set of "YYYY-MM-DD" (other months, fetched when the calendar shows them)
function MonthCalendar({ data, C, onDay }) {
  const [, bump] = useState(0);
  const [y, mo] = data.month.split("-").map(Number);
  const per = useMemo(() => { const p = {}; data.items.forEach(it => { const k = it.start.slice(0, 10), x = p[k] || (p[k] = { drive: 0, sentry: 0, saved: 0, parked: 0 }); x[it.type] += it.type === "sentry" ? it.count || 1 : 1; }); return p; }, [data]);
  const oldest = data.months[data.months.length - 1], minDate = oldest ? new Date(+oldest.slice(0, 4), +oldest.slice(5, 7) - 1, 1) : undefined;
  const today = new Date(), maxDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const [value, setValue] = useState(null), [nav, setNav] = useState(new Date(y, mo - 1, 1));   // the month on show (the arrows move it)
  const getMarkedDays = (a, b) => {
    const out = [], months = new Set();
    for (let d = new Date(a); d <= b; d.setDate(d.getDate() + 1)) {
      const m = `${d.getFullYear()}-${pad(d.getMonth() + 1)}`, k = `${m}-${pad(d.getDate())}`;
      if (m === data.month) { if (per[k]) out.push(new Date(d)); }
      else if (MARKS[m]) { if (MARKS[m].has(k)) out.push(new Date(d)); }
      else months.add(m);
    }
    months.forEach(m => { MARKS[m] = new Set(); if (data.months.includes(m)) api(`/api/days?month=${m}`).then(r => { MARKS[m] = new Set(Object.keys(r)); bump(x => x + 1); }).catch(() => {}); });
    return out;
  };
  return <>
    <div className="cal" style={{ display: "flex", justifyContent: "center", flex: "none", zoom: 1.6 }}>
      <Calendar value={value || undefined} today={today} minDate={minDate} maxDate={maxDate} showGoToToday={false} showMonthPickerAsOverlay={false} isMonthPickerVisible={false}
        calendarDayProps={{ getMarkedDays, navigatedDate: nav, onNavigateDate: d => setNav(d) }}
        onSelectDate={d => { setValue(d); onDay(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`); }} />
    </div>
    <div style={{ display: "flex", gap: 14, padding: "0 14px", flex: "none" }}>{[["Drives", C.BRAND], ["Sentry", C.AMBER], ["Saved", C.GREEN]].map(([l, c]) => <span key={l} style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot c={c} s={8} /><Text size={200} style={muted}>{l}</Text></span>)}</div>
  </>;
}

// ---------------------------------------------------------------- one row of the list
function Thumb({ it, member, C, wide, small }) {                    // small: a phone row                           // a frame of the front camera for drives; the car's own thumbnail for clips
  const m = member || it, isVideo = it.type === "drive" || it.type === "parked";
  const { ref, url } = useStill(isVideo && !it.encrypted ? it.still : null);
  const img = isVideo ? url : m.thumb ? media(m.thumb) : null;
  const [broken, setBroken] = useState(false);
  const badge = it.type === "drive" ? <Badge appearance="filled" shape="rounded" style={{ background: "rgba(0,0,0,.78)", color: "#fff" }}>{it.encrypted ? "Encrypted" : durWords(it.dur)}</Badge>
    : it.type === "parked" ? <Badge appearance="filled" shape="rounded" style={{ background: "rgba(0,0,0,.6)", color: "#fff" }}>{it.encrypted ? "Encrypted" : "Parked"}</Badge>
    : it.type === "sentry" ? <Badge appearance="filled" color="warning" shape="rounded" icon={<Eye16Filled />}>{it.count > 1 ? `${it.count} clips` : "Sentry"}</Badge>
    : <Badge appearance="filled" color="success" shape="rounded">Saved</Badge>;
  return <span ref={ref} aria-hidden="true" style={{ position: "relative", flex: "none", ...(wide ? { width: "100%", aspectRatio: "16 / 9", borderRadius: 0 } : small ? { width: 112, height: 63, borderRadius: T.borderRadiusMedium } : { width: 150, height: 84, borderRadius: T.borderRadiusMedium }), overflow: "hidden", background: it.type === "sentry" ? C.AMBER : it.type === "saved" ? C.GREEN : T.colorNeutralBackground5, display: "grid", placeItems: "center", color: it.type === "drive" || it.type === "parked" ? T.colorNeutralForeground3 : "#fff" }}>
    {it.type === "parked" ? <Text className="display" size={600} weight="semibold" style={{ color: "inherit" }}>P</Text> : it.type === "drive" ? <VehicleCar24Regular /> : it.type === "sentry" ? <Eye16Filled /> : <Pin16Filled />}
    {img && !broken && <img src={img} alt="" onError={() => setBroken(true)} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} />}
    {!member && <span style={{ position: "absolute", left: wide ? 10 : "auto", right: wide ? "auto" : 6, bottom: wide ? 10 : 6 }}>{badge}</span>}</span>;
}
// a small sketch of the route: the shape of a drive tells two drives apart at a glance
function RouteSketch({ route, w = 86, h = 48, p = 8 }) {
  if (!route || route.length < 2) return <svg width={w} height={h} aria-hidden="true" style={{ flex: "none", borderRadius: T.borderRadiusMedium, background: T.colorNeutralBackground3 }}><circle cx={w / 2} cy={h / 2} r="3.4" fill={T.colorBrandStroke1} /></svg>;
  const k = Math.cos(route[0][0] * Math.PI / 180), xs = route.map(q => q[1] * k), ys = route.map(q => -q[0]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const s = Math.min((w - 2 * p) / Math.max(x1 - x0, 1e-9), (h - 2 * p) / Math.max(y1 - y0, 1e-9)), ox = (w - (x1 - x0) * s) / 2, oy = (h - (y1 - y0) * s) / 2;
  const P = xs.map((x, i) => [(ox + (x - x0) * s).toFixed(1), (oy + (ys[i] - y0) * s).toFixed(1)]), a = P[0], b = P[P.length - 1];
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" style={{ flex: "none", borderRadius: T.borderRadiusMedium, background: T.colorNeutralBackground3 }}>
    <polyline points={P.map(q => q.join(",")).join(" ")} fill="none" stroke={T.colorBrandStroke1} strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    <circle cx={a[0]} cy={a[1]} r="2.6" fill={T.colorNeutralBackground1} stroke={T.colorBrandStroke1} strokeWidth="1.5" /><circle cx={b[0]} cy={b[1]} r="2.8" fill={T.colorBrandStroke1} /></svg>;
}
export function KeepButton({ id, itemType, current, size = "small", words = false }) {
  const favs = useStore(FAV), on = isKept(id, current);
  return <Button appearance={on ? "primary" : "outline"} size={size} shape="rounded" icon={on ? <Pin16Filled /> : <Pin16Regular />} aria-pressed={on} title={on ? "Kept: this footage is never removed" : "Keep this footage"}
    onClick={e => { e.preventDefault(); e.stopPropagation(); toggleKeep(id, itemType, current); }}>{on ? "Kept" : typeof words === "string" ? words : "Keep"}</Button>;
}
function KeepCell({ it }) {
  if (it.type === "sentry" && it.count > 1) return null;
  const id = it.trip || it.id, on = isKept(id, it.kept), soon = it.trip && it.expires_days != null && it.expires_days <= 3;
  return on || soon ? <KeepButton id={id} itemType={it.trip ? "trip" : "event"} current={it.kept} /> : null;
}
const rowStyle = { display: "flex", alignItems: "center", gap: 16, padding: "10px 16px", color: "inherit", textDecoration: "none", cursor: "pointer" };
// a row opens the player; links inside it (saved moments) go to their own place
const RowLink = ({ href, children, style, cls = "" }) => <div className={"row " + cls} role="link" tabIndex={0} style={{ ...rowStyle, ...style }} onClick={() => { location.hash = href; }}
  onKeyDown={e => { if (e.key === "Enter") location.hash = href; }}>{children}</div>;
function Row({ it, C, phone }) {
  const [open, setOpen] = useState(false);
  const s = parseT(it.start), e = parseT(it.end), chev = <ChevronRight20Regular style={{ color: T.colorNeutralForeground3, flex: "none" }} />;
  const Meta = ({ main, rest }) => <div style={{ display: "flex", gap: phone ? 12 : 16, marginTop: 2, flexWrap: "wrap" }}><Text size={300} weight="semibold">{main}</Text>{rest.filter(Boolean).map((x, i) => typeof x === "string" ? <Text key={i} size={300} style={muted}>{x}</Text> : <React.Fragment key={i}>{x}</React.Fragment>)}</div>;
  // on a phone a drive is a card: the picture across the top with the route sketched in its corner, the words underneath
  if (it.type === "drive" && phone) return <RowLink href={itemHref(it)} cls="pcard" style={{ flexDirection: "column", alignItems: "stretch", gap: 0, padding: 0 }}>
    <div style={{ position: "relative" }}><Thumb it={it} C={C} wide />
      <span style={{ position: "absolute", right: 10, bottom: 10, padding: 3, borderRadius: T.borderRadiusMedium, background: "rgba(255,255,255,.92)", boxShadow: T.shadow4 }}><RouteSketch route={it.route} w={78} h={46} /></span></div>
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 14px 12px" }}>
      <div style={{ flex: 1, minWidth: 0 }}><Text size={400} weight="semibold" block truncate>{itemTitle(it)}</Text>
        <Meta main={range12(s, e)} rest={[milesText(it.miles), it.top_mph ? `top ${it.top_mph} mph` : "",
          ...(it.saved || []).map(sv => <a key={sv.time} href={itemHref(it, Math.max(0, sv.pos - 10))} onClick={e => e.stopPropagation()} style={{ textDecoration: "none" }}><Badge appearance="tint" color="success" shape="rounded" size="large">Saved {t12(parseT(sv.time))}</Badge></a>)]} /></div>
      <KeepCell it={it} />{chev}</div></RowLink>;
  if (it.type === "drive") return <RowLink href={itemHref(it)}><Thumb it={it} C={C} small={phone} />
    <div style={{ flex: 1, minWidth: 0 }}><Text size={400} weight="semibold" block truncate>{itemTitle(it)}</Text>
      <Meta main={range12(s, e)} rest={[milesText(it.miles), it.top_mph ? `top ${it.top_mph} mph` : "",
        ...(it.saved || []).map(sv => <a key={sv.time} href={itemHref(it, Math.max(0, sv.pos - 10))} onClick={e => e.stopPropagation()} style={{ textDecoration: "none" }}><Badge appearance="tint" color="success" shape="rounded" size="large" title="Play from this moment">Saved moment {t12(parseT(sv.time))}</Badge></a>)]} /></div>
    <KeepCell it={it} /><RouteSketch route={it.route} />{chev}</RowLink>;
  if (it.type === "parked") { const pl = placeText(it.place);
    return <RowLink href={itemHref(it)}><Thumb it={it} C={C} small={phone} />
      <div style={{ flex: 1, minWidth: 0 }}><Text size={400} style={muted} block>{itemTitle(it)}</Text><Meta main={range12(s, e)} rest={[it.at_home ? "at home" : pl ? "at " + pl : "away from home"]} /></div>
      <KeepCell it={it} />{chev}</RowLink>; }
  const pl = placeText(it.place), why = whyText(it.reason);
  const where = pl ? (it.type === "sentry" ? (it.place.home ? "parked at home" : `parked in ${pl}`) : pl) : "";
  const chip = why ? <Badge appearance="tint" color={it.type === "sentry" ? "warning" : "success"} shape="rounded" size="large">{why}</Badge> : null;
  if (it.type === "sentry" && it.count > 1) return <>
    <div className="row" role="button" tabIndex={0} aria-expanded={open} onClick={() => setOpen(!open)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setOpen(!open); } }} style={{ ...rowStyle, cursor: "pointer" }}><Thumb it={it} C={C} small={phone} />
      <div style={{ flex: 1, minWidth: 0 }}><div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}><Text size={400} weight="semibold">{itemTitle(it)}</Text>{chip}</div><Meta main={range12(s, e)} rest={[where]} /></div>
      {!phone && <Text size={300} style={muted}>{open ? "Hide" : "Show all"}</Text>}{open ? <ChevronUp20Regular style={{ color: T.colorNeutralForeground3 }} /> : <ChevronDown20Regular style={{ color: T.colorNeutralForeground3 }} />}</div>
    {open && <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: phone ? "0 8px 10px 8px" : "0 16px 12px 56px" }}>{it.members.map(m => <RowLink key={m.id} href={`#/player?event=${encodeURIComponent(m.id)}`} style={{ padding: "6px 10px", gap: 14, borderRadius: T.borderRadiusMedium }}>
      <span style={{ width: 96, height: 54, flex: "none", borderRadius: T.borderRadiusSmall, overflow: "hidden", background: T.colorNeutralBackground5 }}>{m.thumb && <img src={media(m.thumb)} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />}</span>
      <Text size={300} weight="semibold" style={{ flex: "0 0 80px" }}>{t12(parseT(m.time))}</Text><Text size={300} style={{ ...muted, flex: 1 }}>{whyText(m.reason) || "Sentry alert"}</Text>{chev}</RowLink>)}</div>}</>;
  return <RowLink href={itemHref(it)}><Thumb it={it} C={C} small={phone} />
    <div style={{ flex: 1, minWidth: 0 }}><div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}><Text size={400} weight="semibold">{itemTitle(it)}</Text>{chip}</div>
      <Meta main={t12(s)} rest={[it.dur ? durWords(it.dur) : "", where]} /></div>
    <KeepCell it={it} />{chev}</RowLink>;
}

// ---------------------------------------------------------------- map view: the same items, drawn
const onMap = it => it.type === "drive" ? it.route && it.route.length > 1 : !!it.at;
function MapView({ items, data, sel, setSel, C }) {
  const box = useRef(), M = useRef({ map: null, layers: {} });
  const popHTML = it => {
    const s = parseT(it.start), meta = it.type === "drive" ? `${dayLabel(it.start.slice(0, 10)).big} ${t12(s)}, ${durWords(it.dur)}, ${milesText(it.miles)}` : `${dayLabel(it.start.slice(0, 10)).big} ${t12(s)}${placeText(it.place) ? ", " + placeText(it.place) : ""}`;
    const href = it.type === "sentry" && it.count > 1 ? `#/player?event=${encodeURIComponent(it.members[0].id)}` : itemHref(it);
    const esc = x => String(x).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    return `<div class="hpop"><div><b>${esc(itemTitle(it))}</b><span>${esc(meta)}</span></div><a class="playbtn" href="${href}"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 4l13 8-13 8z"/></svg>Play</a></div>`;
  };
  const select = (id, zoom) => {
    const { map, layers } = M.current; if (!map) return;
    setSel(id);
    Object.values(layers).forEach(l => { if (l.line) l.line.setStyle({ color: C.MAPLINE, weight: 5 }); if (l.pin) l.pin.setStyle({ radius: 8 }); });
    map.closePopup();
    const l = id && layers[id]; if (!l) return;
    const it = l.it; let at;
    if (l.line) { l.casing.bringToFront(); l.line.bringToFront(); l.line.setStyle({ color: C.BRAND, weight: 6 }); at = it.route[Math.floor(it.route.length / 2)]; if (zoom) map.fitBounds(l.line.getBounds(), { padding: [70, 70], maxZoom: 15 }); }
    else { l.pin.setStyle({ radius: 11 }); l.pin.bringToFront(); at = it.at; if (zoom) map.setView(at, Math.max(map.getZoom(), 14)); }
    const pop = () => { if (M.current.map === map) L.popup({ className: "hpopup", closeButton: false, autoPan: true, autoPanPadding: [30, 30], offset: [0, -8], maxWidth: 420 }).setLatLng(at).setContent(popHTML(it)).openOn(map); };
    if (zoom) setTimeout(pop, 450); else pop();             // after the map has finished moving, so the bubble is not cut off
  };
  useEffect(() => {
    let dead = false;
    api("/api/config").catch(() => ({})).then(cfg => {
      if (dead || !box.current) return;
      const map = L.map(box.current, { zoomControl: true, attributionControl: true, keyboard: false });
      map.zoomControl.setPosition("topright"); map.attributionControl.setPrefix(false);
      streetLayer(cfg).addTo(map);
      const layers = {}, pts = [];
      items.forEach(it => {
        if (!onMap(it)) return;
        if (it.type === "drive") {
          const casing = L.polyline(it.route, { color: "#FFF", weight: 9, opacity: .95, lineCap: "round", lineJoin: "round", interactive: false }).addTo(map);
          const line = L.polyline(it.route, { color: C.MAPLINE, weight: 5, lineCap: "round", lineJoin: "round" }).addTo(map);
          line.on("click", e => { L.DomEvent.stopPropagation(e); select(it.id, false); });
          layers[it.id] = { it, line, casing }; it.route.forEach(p => pts.push(p));
        } else {
          const pin = L.circleMarker(it.at, { radius: 8, color: "#FFF", weight: 3, fillColor: CAT(C, it.type === "parked" ? "parked" : it.type), fillOpacity: 1 }).addTo(map);
          pin.on("click", e => { L.DomEvent.stopPropagation(e); select(it.id, false); });
          layers[it.id] = { it, pin }; pts.push(it.at);
        }
      });
      if (data.home) { L.marker(data.home, { icon: L.divIcon({ className: "homeicon", html: `<span><svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/></svg></span>`, iconSize: [30, 30], iconAnchor: [15, 15] }), interactive: false, keyboard: false }).addTo(map); pts.push(data.home); }
      if (pts.length) map.fitBounds(pts, { padding: [40, 40], maxZoom: 15 }); else map.setView([36.04, -115.03], 10);
      map.on("click", () => select(null));
      M.current = { map, layers };
      setTimeout(() => map.invalidateSize(), 50);
      if (sel && layers[sel]) select(sel, true);
    });
    return () => { dead = true; if (M.current.map) M.current.map.remove(); M.current = { map: null, layers: {} }; };
  }, [items, data.home]);   // eslint-disable-line
  const sideRef = useRef();
  useEffect(() => { sideRef.current?.querySelector(`[data-id="${CSS.escape(sel || "")}"]`)?.scrollIntoView({ block: "nearest" }); }, [sel]);
  return <div style={{ flex: 1, display: "grid", gridTemplateColumns: "340px minmax(0,1fr)", gap: 16, minHeight: 0 }} className="mapview">
    <div ref={sideRef} style={{ overflowY: "auto", display: "flex", flexDirection: "column", gap: 4, minHeight: 0 }}>{byDay(items).map(([day, list]) => <React.Fragment key={day}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, padding: "10px 8px 4px", flexWrap: "wrap" }}><Text size={400} weight="semibold">{dayMid(day)}</Text><Text size={200} style={muted}>{daySummary(list)}</Text></div>
      {list.map(it => { const on = sel === it.id, s = parseT(it.start), has = onMap(it);
        const meta = it.type === "drive" ? `${t12(s)}, ${durWords(it.dur)}, ${milesText(it.miles)}${it.saved?.length ? `, ${plural(it.saved.length, "saved moment")}` : ""}` : `${t12(s)}${placeText(it.place) ? ", " + placeText(it.place) : ""}`;
        return <button key={it.id} type="button" data-id={it.id} aria-pressed={on} onClick={() => select(it.id, true)} className="srow" style={{ position: "relative", display: "flex", alignItems: "center", gap: 12, padding: "8px 12px", border: 0, textAlign: "left", cursor: "pointer", font: "inherit", color: "inherit", borderRadius: T.borderRadiusMedium, background: on ? T.colorNeutralBackground1 : "transparent", boxShadow: on ? T.shadow4 : "none", opacity: has ? 1 : .6 }}>
          {on && <span style={{ position: "absolute", left: 0, top: 10, bottom: 10, width: 3, borderRadius: 2, background: T.colorBrandForeground1 }} />}
          <Dot c={it.type === "drive" ? (on ? C.BRAND : C.MAPLINE) : CAT(C, it.type === "parked" ? "parked" : it.type)} s={10} /><div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}><Text size={300} weight="semibold" truncate block>{itemTitle(it)}</Text>
            <Text size={200} style={muted}>{meta}{has ? "" : ", not on the map"}</Text></div></button>; })}</React.Fragment>)}</div>
    <Card style={{ padding: 0, position: "relative", overflow: "hidden", minHeight: 420 }}><div ref={box} className="gray" style={{ position: "absolute", inset: 0 }} aria-label="Map of drives and alerts" />
      <div style={{ position: "absolute", left: 12, bottom: 12, zIndex: 500, display: "flex", gap: 16, padding: "8px 14px", borderRadius: T.borderRadiusMedium, background: T.colorNeutralBackground1, boxShadow: T.shadow4 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 20, height: 4, borderRadius: 2, background: C.MAPLINE }} /><Text size={200}>Drive</Text></span>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot c={C.AMBER} s={10} /><Text size={200}>Sentry</Text></span><span style={{ display: "flex", alignItems: "center", gap: 6 }}><Dot c={C.GREEN} s={10} /><Text size={200}>Saved</Text></span></div></Card></div>;
}
