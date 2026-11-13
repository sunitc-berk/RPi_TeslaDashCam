// The frame around every page: the rail on the left, the top bar (where you are, List | Map, search), the panel slot, and toasts.
import React, { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FluentProvider, Text, Breadcrumb, BreadcrumbItem, BreadcrumbButton, BreadcrumbDivider, SearchBox, PresenceBadge, Toaster, Toast, ToastTitle, useToastController, useId, Link } from "@fluentui/react-components";
import { Video24Regular, Video24Filled, Pin24Regular, Pin24Filled, ArrowUpload24Regular, ArrowUpload24Filled, DeveloperBoard24Regular, DeveloperBoard24Filled, Database24Regular, Database24Filled, Settings24Regular, Settings24Filled, VehicleCar24Regular } from "@fluentui/react-icons";
import { ROUTE, LIVE, THEME, BUS, useStore, go, hrefOf, pillState, pollLive, pollDiag, startRouter } from "./lib.js";
import { useFluentTheme, T } from "./theme.js";
import { DESIGN } from "./designs.js";
import { Footage } from "./footage.jsx";
import { Player } from "./player.jsx";
import { Uploads } from "./uploads.jsx";
import { Pi } from "./pi.jsx";
import { Storage } from "./storage.jsx";
import { Settings } from "./settings.jsx";

const PAGES = { drives: Footage, kept: Footage, player: Player, status: Uploads, health: Pi, storage: Storage, system: Settings };
const TITLES = { drives: "Footage", kept: "Kept", player: "Player", status: "Uploads", health: "Pi", storage: "Storage", system: "Settings" };
const RAIL = [["footage", "Footage", "drives", Video24Regular, Video24Filled], ["kept", "Kept", "kept", Pin24Regular, Pin24Filled], ["uploads", "Uploads", "status", ArrowUpload24Regular, ArrowUpload24Filled],
  ["pi", "Pi", "health", DeveloperBoard24Regular, DeveloperBoard24Filled], ["storage", "Storage", "storage", Database24Regular, Database24Filled]];
const RAIL_OF = { drives: "footage", kept: "kept", player: "footage", status: "uploads", health: "pi", storage: "storage", system: "settings" };

export const Shell = createContext(null);
export const useShell = () => useContext(Shell);
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
  return <FluentProvider theme={theme} style={{ height: "100%" }}>
    <Shell.Provider value={{ setCrumb, panelEl, topEl }}>
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
