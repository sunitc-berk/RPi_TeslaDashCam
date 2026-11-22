// The frame around every page: the rail on the left, the top bar (where you are, List | Map, search), the panel slot, and toasts.
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FluentProvider, Text, Breadcrumb, BreadcrumbItem, BreadcrumbButton, BreadcrumbDivider, SearchBox, PresenceBadge, Toaster, Toast, ToastTitle, useToastController, useId, Link, Button, OverlayDrawer, DrawerHeader, DrawerHeaderTitle, DrawerBody } from "@fluentui/react-components";
import { Video24Regular, Video24Filled, Pin24Regular, Pin24Filled, ArrowUpload24Regular, ArrowUpload24Filled, DeveloperBoard24Regular, DeveloperBoard24Filled, Database24Regular, Database24Filled, Settings24Regular, Settings24Filled, VehicleCar24Regular, VehicleCar24Filled, CalendarLtr24Regular, Search24Regular, Dismiss24Regular, ArrowLeft24Regular } from "@fluentui/react-icons";
import { ROUTE, LIVE, THEME, BUS, useStore, go, hrefOf, pillState, pollLive, pollDiag, startRouter } from "./lib.js";
import { useFluentTheme, T } from "./theme.js";
import { DESIGN } from "./designs.js";
import { Footage } from "./footage.jsx";
import { Player } from "./player.jsx";
import { Uploads } from "./uploads.jsx";
import { Pi } from "./pi.jsx";
import { Storage } from "./storage.jsx";
import { Settings } from "./settings.jsx";
import { Plates } from "./plates.jsx";

const PAGES = { drives: Footage, kept: Footage, player: Player, status: Uploads, health: Pi, storage: Storage, system: Settings, plates: Plates };
const TITLES = { drives: "Footage", kept: "Kept", player: "Player", status: "Uploads", health: "Pi", storage: "Storage", system: "Settings", plates: "Plates" };
const RAIL = [["footage", "Footage", "drives", Video24Regular, Video24Filled], ["kept", "Kept", "kept", Pin24Regular, Pin24Filled], ["uploads", "Uploads", "status", ArrowUpload24Regular, ArrowUpload24Filled],
  ["pi", "Pi", "health", DeveloperBoard24Regular, DeveloperBoard24Filled], ["storage", "Storage", "storage", Database24Regular, Database24Filled],
  ["plates", "Plates", "plates", VehicleCar24Regular, VehicleCar24Filled]];
const RAIL_OF = { drives: "footage", kept: "kept", player: "footage", status: "uploads", health: "pi", storage: "storage", system: "settings", plates: "plates" };

export const Shell = createContext(null);
export const useShell = () => useContext(Shell);

// ---------------------------------------------------------------- phones get their own frame: top bar, bottom tabs, a sheet for the calendar
// A phone is a phone browser (iPhone, Android phone) or any narrow touch screen; ?phone=1 / ?phone=0 forces it for trying things out.
const PHONE_UA = /iPhone|iPod|Android.*Mobile|Windows Phone/i.test(navigator.userAgent);
const PHONE_FORCE = new URLSearchParams(location.search).get("phone");
const phoneNow = () => PHONE_FORCE === "1" ? true : PHONE_FORCE === "0" ? false : PHONE_UA || matchMedia("(max-width: 720px) and (pointer: coarse)").matches;
export function usePhone() {
  const [phone, set] = useState(phoneNow);
  useEffect(() => { const mq = matchMedia("(max-width: 720px)"), f = () => set(phoneNow()); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); }, []);
  return phone;
}
// a page declares its breadcrumb (and whether it uses the panel) with this
export function useCrumb(crumb) {
  const sh = useShell(); const key = JSON.stringify(crumb);
  useEffect(() => { sh.setCrumb(crumb); }, [key]);   // eslint-disable-line
}

const RailItem = ({ on, label, R, F, href, title }) => <a href={href} title={title} className="rail-item" aria-current={on ? "page" : undefined} style={{ position: "relative", width: 76, height: 64, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 4, borderRadius: T.borderRadiusLarge, textDecoration: "none",
  background: on ? T.colorNeutralBackground1 : "transparent", boxShadow: on ? T.shadow2 : "none", color: on ? T.colorBrandForeground1 : T.colorNeutralForeground2 }}>
  {on && <span style={{ position: "absolute", left: 0, top: 18, bottom: 18, width: 3, borderRadius: 2, background: T.colorBrandForeground1 }} />}
  {on ? <F /> : <R />}<Text size={200} weight={on ? "semibold" : "regular"} style={{ color: "inherit" }}>{label}</Text></a>;

function Rail({ on }) {
  const live = useStore(LIVE), p = pillState(live);
  const status = p.kind === "up" ? "busy" : p.kind === "ok" ? "available" : p.kind === "wait" ? "away" : "offline";
  return <nav aria-label="Main" className="rail" style={{ flex: "0 0 92px", display: "flex", flexDirection: "column", alignItems: "center", gap: 6, padding: "14px 0", background: T.colorNeutralBackground3, borderRight: `1px solid ${T.colorNeutralStroke2}`, overflow: "hidden" }}>
    <a href="#/drives" aria-label="TeslaCam" style={{ width: 44, height: 44, marginBottom: 10, borderRadius: T.borderRadiusLarge, background: T.colorBrandBackground, display: "grid", placeItems: "center", color: T.colorNeutralForegroundOnBrand }}><VehicleCar24Regular /></a>
    {RAIL.map(([k, l, page, R, F]) => <RailItem key={k} on={k === on} label={l} R={R} F={F} href={`#/${page}`} />)}
    <a href="#/status" title={p.title} className="rail-state" style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 6, height: 56, marginTop: 8, justifyContent: "center", textDecoration: "none" }}>
      <PresenceBadge status={status} size="small" />
      {p.kind === "up" ? <span style={{ display: "flex", flexDirection: "column", alignItems: "center", lineHeight: 1.15 }}><Text size={300} weight="semibold" style={{ color: T.colorBrandForeground1 }}>{Math.floor(p.pct)}%</Text><Text size={200} style={{ color: T.colorNeutralForeground2 }}>Uploading</Text></span>
        : <Text size={200} style={{ color: T.colorNeutralForeground2, whiteSpace: "nowrap" }}>{p.text}</Text>}</a>
    <span style={{ flex: 1 }} />
    <RailItem on={on === "settings"} label="Settings" R={Settings24Regular} F={Settings24Filled} href="#/system" />
  </nav>;
}

function TopBar({ crumb, topEl, q, onSearch }) {
  const [val, setVal] = useState(q || ""); const timer = useRef();
  useEffect(() => { setVal(q || ""); }, [q]);
  const change = (e, d) => { setVal(d.value); clearTimeout(timer.current); timer.current = setTimeout(() => onSearch(d.value.trim()), 350); };
  return <header className="topbar" style={{ flex: "none", minHeight: 64, display: "flex", alignItems: "center", gap: 16, padding: "0 24px 0 16px", background: T.colorNeutralBackground1, borderBottom: `1px solid ${T.colorNeutralStroke2}` }}>
    <Breadcrumb size="large" aria-label="Where you are" className="display">{crumb.map((c, i) => <React.Fragment key={i}><BreadcrumbItem>
      {c[1] && i < crumb.length - 1 ? <BreadcrumbButton href={c[1]}>{c[0]}</BreadcrumbButton> : <BreadcrumbButton current={i === crumb.length - 1}>{c[0]}</BreadcrumbButton>}</BreadcrumbItem>{i < crumb.length - 1 && <BreadcrumbDivider />}</React.Fragment>)}</Breadcrumb>
    <span style={{ flex: 1 }} />
    <div ref={topEl} style={{ display: "contents" }} />
    <SearchBox className="find" value={val} onChange={change} placeholder="Search a place or a date" aria-label="Search a place or a date" appearance="filled-darker" size="large" style={{ width: 320 }}
      onKeyDown={e => { if (e.key === "Enter") { clearTimeout(timer.current); onSearch(val.trim()); } }} />
  </header>;
}

// the phone's top bar: back or the brand mark, where you are, then calendar/filters, search and settings
function PhoneBar({ crumb, topEl, q, onSearch, hasPanel, onSheet }) {
  const [search, setSearch] = useState(!!q), [val, setVal] = useState(q || ""); const timer = useRef();
  useEffect(() => { setVal(q || ""); if (q) setSearch(true); }, [q]);
  // the back button leads to the parent crumb, unless that is this same page with other parameters (a month of Footage is still the Footage tab)
  const title = crumb[crumb.length - 1][0], parent = crumb.length > 1 ? crumb[crumb.length - 2] : null;
  const back = parent?.[1] && parent[1].split("?")[0] !== location.hash.split("?")[0] ? parent : null;
  const change = (e, d) => { setVal(d.value); clearTimeout(timer.current); timer.current = setTimeout(() => onSearch(d.value.trim()), 350); };
  return <header className="pbar" style={{ flex: "none", background: T.colorNeutralBackground1, borderBottom: `1px solid ${T.colorNeutralStroke2}`, paddingTop: "env(safe-area-inset-top)" }}>
    <div style={{ display: "flex", alignItems: "center", gap: 2, height: 56, padding: "0 6px 0 12px" }}>
      {back ? <Button appearance="subtle" size="large" icon={<ArrowLeft24Regular />} as="a" href={back[1]} aria-label={`Back to ${back[0]}`} style={{ marginLeft: -8 }} />
        : <a href="#/drives" aria-label="TeslaCam" style={{ width: 36, height: 36, borderRadius: T.borderRadiusLarge, background: T.colorBrandBackground, display: "grid", placeItems: "center", color: T.colorNeutralForegroundOnBrand, flex: "none", marginRight: 8 }}><VehicleCar24Regular /></a>}
      <Text className="display" size={500} weight="semibold" truncate block style={{ flex: 1, minWidth: 0 }}>{title}</Text>
      {hasPanel && <Button appearance="subtle" size="large" icon={<CalendarLtr24Regular />} aria-label="Calendar and filters" onClick={onSheet} />}
      <Button appearance="subtle" size="large" icon={search ? <Dismiss24Regular /> : <Search24Regular />} aria-label={search ? "Close search" : "Search"} onClick={() => { if (search && q) onSearch(""); setSearch(!search); }} />
      <Button appearance="subtle" size="large" icon={<Settings24Regular />} as="a" href="#/system" aria-label="Settings" />
    </div>
    {search && <div style={{ padding: "0 12px 10px" }}><SearchBox value={val} onChange={change} placeholder="Search a place or a date" aria-label="Search a place or a date" appearance="filled-darker" size="large" autoFocus style={{ width: "100%" }}
      onKeyDown={e => { if (e.key === "Enter") { clearTimeout(timer.current); onSearch(val.trim()); } }} /></div>}
    <div ref={topEl} className="pbar-tools" />
  </header>;
}

// the phone's bottom tabs; the Uploads tab shows the percentage while an upload runs
function PhoneTabs({ on }) {
  const live = useStore(LIVE), p = pillState(live), up = p.kind === "up";
  return <nav aria-label="Main" className="ptabs" style={{ flex: "none", display: "flex", background: T.colorNeutralBackground1, borderTop: `1px solid ${T.colorNeutralStroke2}`, paddingBottom: "env(safe-area-inset-bottom)" }}>
    {RAIL.map(([k, l, page, R, F]) => { const sel = k === on, busy = k === "uploads" && up; return <a key={k} href={`#/${page}`} className="ptab" aria-current={sel ? "page" : undefined} aria-label={busy ? `${l}, ${Math.floor(p.pct)} percent` : l}
      style={{ flex: 1, height: 60, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 3, textDecoration: "none", color: sel ? T.colorBrandForeground1 : T.colorNeutralForeground3 }}>
      <span style={{ position: "relative", display: "grid", placeItems: "center", width: 44, height: 26, borderRadius: 13, background: sel ? T.colorNeutralBackground3 : "transparent" }}>{sel ? <F /> : <R />}
        {busy && <PresenceBadge status="busy" size="extra-small" style={{ position: "absolute", top: 1, right: 6 }} />}</span>
      <Text size={200} weight={sel ? "semibold" : "regular"} style={{ color: "inherit", fontVariantNumeric: "tabular-nums" }}>{busy ? `${Math.floor(p.pct)}%` : l}</Text></a>; })}
  </nav>;
}

function Toasts() {
  const id = useId("toasts"), { dispatchToast } = useToastController(id);
  useEffect(() => {
    const f = e => dispatchToast(<Toast><ToastTitle>{e.detail.text}</ToastTitle></Toast>, { intent: e.detail.intent || "success", timeout: 3500, position: "bottom" });
    BUS.addEventListener("toast", f); return () => BUS.removeEventListener("toast", f);
  }, []);
  return <Toaster toasterId={id} position="bottom" />;
}

export function App() {
  const route = useStore(ROUTE), { dark } = useStore(THEME), theme = useFluentTheme(), { id: designId } = useStore(DESIGN);
  const [crumb, setCrumb] = useState([["Footage"]]);
  const [panelEl, setPanelEl] = useState(null), [topEl, setTopEl] = useState(null);
  const Page = PAGES[route.name] || Footage, on = RAIL_OF[route.name] || "footage";
  const hasPanel = route.name === "drives" || route.name === "kept";
  useEffect(() => { document.title = `${TITLES[route.name] || "TeslaCam"} · TeslaCam`; }, [route.name]);
  useEffect(() => {                                   // live upload state for the rail; the Pi's diagnostics for Settings and Pi
    pollLive(); pollDiag();
    const a = setInterval(() => { if (!document.hidden && ROUTE.get().name !== "status") pollLive(); }, 8000);
    const b = setInterval(() => { if (!document.hidden) pollDiag(); }, 60000);
    return () => { clearInterval(a); clearInterval(b); };
  }, []);
  useEffect(() => { document.documentElement.dataset.mode = dark ? "dark" : "light"; }, [dark]);
  useEffect(() => { document.documentElement.dataset.theme = designId; }, [designId]);
  const q = route.name === "drives" ? route.params.get("q") || "" : "";
  const onSearch = v => { if (v !== q) go("drives", v ? { q: v } : {}); };
  const phone = usePhone();
  const [sheet, setSheet] = useState(false);
  useEffect(() => { if (phone) document.documentElement.dataset.phone = "1"; else delete document.documentElement.dataset.phone; }, [phone]);
  useEffect(() => { setSheet(false); }, [route.key]);          // a new page closes the sheet
  if (phone) return <FluentProvider theme={theme} style={{ height: "100%" }}>
    <Shell.Provider value={{ setCrumb, panelEl, topEl, phone: true, closeSheet: () => setSheet(false) }}>
      <div className="frame pframe" style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", background: T.colorNeutralBackground2 }}>
        <PhoneBar crumb={crumb} topEl={setTopEl} q={q} onSearch={onSearch} hasPanel={hasPanel} onSheet={() => setSheet(true)} />
        <main id="page" className="page" key={route.key} style={{ flex: 1, minHeight: 0, padding: 12, overflowY: "auto", display: "flex", flexDirection: "column", gap: 14, WebkitOverflowScrolling: "touch" }}>
          <Page params={route.params} kept={route.name === "kept"} />
        </main>
        <PhoneTabs on={on} />
      </div>
      <OverlayDrawer position="bottom" open={sheet} onOpenChange={(e, d) => setSheet(d.open)} style={{ height: "min(82vh, 680px)", borderRadius: "18px 18px 0 0" }}>
        <DrawerHeader><DrawerHeaderTitle action={<Button appearance="subtle" icon={<Dismiss24Regular />} aria-label="Close" onClick={() => setSheet(false)} />}>Show</DrawerHeaderTitle></DrawerHeader>
        <DrawerBody><div ref={setPanelEl} className="psheet" aria-label="Show and calendar" style={{ display: "flex", flexDirection: "column", gap: 14, paddingBottom: 24 }} /></DrawerBody>
      </OverlayDrawer>
      <Toasts />
    </Shell.Provider>
  </FluentProvider>;
  return <FluentProvider theme={theme} style={{ height: "100%" }}>
    <Shell.Provider value={{ setCrumb, panelEl, topEl, phone: false }}>
      <div className="frame" style={{ display: "flex", height: "100%", overflow: "hidden", background: T.colorNeutralBackground2 }}>
        <Rail on={on} />
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
          <TopBar crumb={crumb} topEl={setTopEl} q={q} onSearch={onSearch} />
          <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
            <aside ref={setPanelEl} aria-label="Show and calendar" className="panel" style={{ display: hasPanel ? "flex" : "none", flex: "0 0 340px", flexDirection: "column", gap: 18, padding: "18px 12px", background: T.colorNeutralBackground2, borderRight: `1px solid ${T.colorNeutralStroke2}`, overflowY: "auto" }} />
            <main id="page" className="page" key={route.key} style={{ flex: 1, minWidth: 0, padding: 24, overflowY: "auto", display: "flex", flexDirection: "column", gap: 18 }}>
              <Page params={route.params} kept={route.name === "kept"} />
            </main>
          </div>
        </div>
      </div>
      <Toasts />
    </Shell.Provider>
  </FluentProvider>;
}
// render children into the panel on the left (or the top bar) from inside a page
export const InPanel = ({ children }) => { const sh = useShell(); return sh.panelEl ? createPortal(children, sh.panelEl) : null; };
export const InTop = ({ children }) => { const sh = useShell(); return sh.topEl ? createPortal(children, sh.topEl) : null; };
export { startRouter };
