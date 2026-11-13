// The design systems the dashboard can wear. Each one is a small set of semantic values (from 4designs.md); from those
// come a Fluent theme (so every Fluent control follows) and the CSS variables in themes.css (for everything else).
import { createLightTheme, createDarkTheme } from "@fluentui/react-components";
import { makeStore } from "./lib.js";

const SANS_SYS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif";
const INTER = `'Inter', ${SANS_SYS}`, JAKARTA = `'Plus Jakarta Sans', ${SANS_SYS}`, NEWSREADER = "'Newsreader', Georgia, 'Times New Roman', serif", JBMONO = "'JetBrains Mono', 'IBM Plex Mono', Consolas, monospace";

export const DESIGNS = {
  house: { name: "House", canvas: "#FAFAFA", surface: "#FFFFFF", sidebar: "#F5F5F5", hover: "#F0F0F0", border: "#D1D1D1", border2: "#E0E0E0",
    text: "#242424", text2: "#616161", muted: "#8A8A8A", accent: "#E84524", accentHover: "#D9391C", accentDark: "#F0553A", onAccent: "#FFFFFF",
    radius: [4, 4, 6, 8], shadow: ["0 1px 2px rgba(0,0,0,.14)", "0 2px 4px rgba(0,0,0,.14)", "0 4px 8px rgba(0,0,0,.14)", "0 8px 16px rgba(0,0,0,.14)"],
    fontSans: `'Segoe UI', 'Segoe UI Web (West European)', 'Open Sans', ${SANS_SYS}`, fontDisplay: `'Segoe UI', 'Segoe UI Web (West European)', 'Open Sans', ${SANS_SYS}`, fontMono: "Consolas, 'IBM Plex Mono', monospace", tracking: "0",
    chart: ["#75756E", "#C27500", "#0E8A4F", "#E84524", "#8C8C85", "#B5B5B0"], trip: "#75756E", mapLine: "#8C8C85", free: "#E6E6E6", other: "#B5B5B0",
    good: { fg: "#0E8A4F", bg: "#E9F5EE", border: "#9FD4B4" }, warn: { fg: "#C27500", bg: "#FFF4E0", border: "#F2C86B" }, bad: { fg: "#C4314B", bg: "#FCEEF0", border: "#F2A7B4" } },

  tremor: { name: "Tremor", canvas: "#F9FAFB", surface: "#FFFFFF", sidebar: "#F9FAFB", hover: "#F3F4F6", border: "#E5E7EB", border2: "#E5E7EB",
    text: "#111827", text2: "#374151", muted: "#6B7280", accent: "#2563EB", accentHover: "#1D4ED8", accentDark: "#3B82F6", onAccent: "#FFFFFF",
    radius: [6, 6, 8, 8], shadow: ["0 1px 2px rgba(0,0,0,.04)", "0 1px 2px rgba(0,0,0,.04)", "0 1px 3px rgba(0,0,0,.06)", "0 4px 12px rgba(0,0,0,.08)"],
    fontSans: INTER, fontDisplay: INTER, fontMono: JBMONO, tracking: "-0.015em",
    chart: ["#3B82F6", "#06B6D4", "#6366F1", "#8B5CF6", "#D946EF", "#10B981"], trip: "#6366F1", mapLine: "#9CA3AF", free: "#E5E7EB", other: "#D1D5DB",
    good: { fg: "#047857", bg: "#ECFDF5", border: "#A7F3D0" }, warn: { fg: "#B45309", bg: "#FFFBEB", border: "#FDE68A" }, bad: { fg: "#BE123C", bg: "#FFF1F2", border: "#FECDD3" } },

  plotly: { name: "Plotly", canvas: "#F4F6F9", surface: "#FFFFFF", sidebar: "#F4F6F9", hover: "#EEF2F6", border: "#DCE1E7", border2: "#DCE1E7",
    text: "#1E293B", text2: "#475569", muted: "#64748B", accent: "#0F766E", accentHover: "#115E59", accentDark: "#2DD4BF", onAccent: "#FFFFFF",
    radius: [4, 4, 6, 6], shadow: ["none", "none", "0 1px 2px rgba(15,23,42,.06)", "0 4px 12px rgba(15,23,42,.10)"],
    fontSans: INTER, fontDisplay: INTER, fontMono: JBMONO, tracking: "-0.01em",
    chart: ["#0F766E", "#0284C7", "#6366F1", "#D97706", "#E11D48"], trip: "#0284C7", mapLine: "#94A3B8", free: "#E2E8F0", other: "#CBD5E1",
    good: { fg: "#0F766E", bg: "#F0FDFA", border: "#99F6E4" }, warn: { fg: "#D97706", bg: "#FFFBEB", border: "#FDE68A" }, bad: { fg: "#E11D48", bg: "#FFF1F2", border: "#FECDD3" } },

  lovable: { name: "Lovable", canvas: "#FAF9F6", surface: "#FFFFFF", sidebar: "#F5F3EE", hover: "#F3F1EC", border: "#E8E5DE", border2: "#EEEBE4",
    text: "#141413", text2: "#4A4946", muted: "#8A8883", accent: "#141413", accentHover: "#2A2927", accentDark: "#F97066", onAccent: "#FFFFFF",
    radius: [8, 10, 14, 18], shadow: ["0 1px 2px rgba(20,20,19,.04)", "0 2px 8px rgba(20,20,19,.05)", "0 8px 24px rgba(20,20,19,.07)", "0 16px 40px rgba(20,20,19,.10)"],
    fontSans: JAKARTA, fontDisplay: JAKARTA, fontMono: JBMONO, tracking: "-0.02em",
    chart: ["#F97066", "#D946EF", "#6366F1", "#F59E0B", "#10B981", "#0EA5E9"], trip: "#6366F1", mapLine: "#B4B2AC", free: "#ECEAE4", other: "#D6D3CB",
    good: { fg: "#15803D", bg: "#F0FDF4", border: "#BBF7D0" }, warn: { fg: "#C2410C", bg: "#FFF7ED", border: "#FED7AA" }, bad: { fg: "#BE123C", bg: "#FFF1F2", border: "#FECDD3" },
    glow: "radial-gradient(60% 80% at 15% 0%, rgba(249,112,102,.22), transparent 60%), radial-gradient(50% 70% at 85% 10%, rgba(217,70,239,.16), transparent 60%), radial-gradient(60% 80% at 60% 100%, rgba(99,102,241,.16), transparent 60%)" },

  anthropic: { name: "Anthropic", canvas: "#F0EEE6", surface: "#FBFAF6", sidebar: "#EAE7DD", hover: "#F2F0E8", border: "#DCD9CE", border2: "#DCD9CE",
    text: "#141413", text2: "#5E5D59", muted: "#87867F", accent: "#D97757", accentHover: "#C4663F", accentDark: "#E8906F", onAccent: "#FFFFFF",
    radius: [4, 6, 8, 10], shadow: ["none", "none", "none", "none"],
    fontSans: INTER, fontDisplay: NEWSREADER, fontMono: JBMONO, tracking: "-0.005em",
    chart: ["#D97757", "#6A9BCC", "#788C5D", "#B5A186", "#C46686", "#87867F"], trip: "#B5A186", mapLine: "#A8A59A", free: "#E6E3D8", other: "#CFCBBF",
    good: { fg: "#5B7A3B", bg: "#EEF2E4", border: "#C5D3A8" }, warn: { fg: "#B5742A", bg: "#F8EFDF", border: "#E6C89A" }, bad: { fg: "#B23A3A", bg: "#F7E6E3", border: "#E5B5AE" } },
};
export const DESIGN_ORDER = ["tremor", "plotly", "lovable", "anthropic"];

// ---------------------------------------------------------------- the chosen design, remembered in the browser
const saved = (() => { try { return localStorage.getItem("teslacam.design"); } catch (e) { return null; } })();
export const DEFAULT_DESIGN = "lovable";
export const DESIGN = makeStore({ id: DESIGNS[saved] ? saved : DEFAULT_DESIGN });
export function setDesign(id) { if (!DESIGNS[id]) return; DESIGN.set({ id }); try { localStorage.setItem("teslacam.design", id); } catch (e) {} document.documentElement.dataset.theme = id; }
export const currentDesign = () => DESIGNS[DESIGN.get().id];

// ---------------------------------------------------------------- a Fluent theme from a design
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const toHex = ([r, g, b]) => "#" + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");
const mix = (a, b, t) => toHex(hex(a).map((v, i) => v + (hex(b)[i] - v) * t));
// Fluent wants 16 shades of the brand colour; shade 80 is the colour itself
function ramp(accent) {
  const r = {};
  for (let k = 10; k <= 160; k += 10) r[k] = k < 80 ? mix(accent, "#000000", (80 - k) / 80 * 0.85) : k === 80 ? accent : mix(accent, "#FFFFFF", (k - 80) / 80 * 0.92);
  return r;
}
const palette = (name, s) => ({ [`colorPalette${name}Foreground1`]: s.fg, [`colorPalette${name}Foreground2`]: s.fg, [`colorPalette${name}Foreground3`]: s.fg, [`colorPalette${name}Background1`]: s.bg, [`colorPalette${name}Background2`]: s.bg, [`colorPalette${name}Background3`]: s.fg, [`colorPalette${name}Border1`]: s.border, [`colorPalette${name}Border2`]: s.fg, [`colorPalette${name}BorderActive`]: s.fg });
export function fluentTheme(d, dark = false) {
  const t = dark ? createDarkTheme(ramp(d.accentDark || d.accent)) : createLightTheme(ramp(d.accent));
  const base = {
    fontFamilyBase: d.fontSans, fontFamilyMonospace: d.fontMono,
    fontSizeBase200: "13px", fontSizeBase300: "15px", fontSizeBase400: "17px", fontSizeBase500: "21px", lineHeightBase300: "21px", lineHeightBase400: "23px",
    borderRadiusSmall: d.radius[0] + "px", borderRadiusMedium: d.radius[1] + "px", borderRadiusLarge: d.radius[2] + "px", borderRadiusXLarge: d.radius[3] + "px",
    shadow2: d.shadow[0], shadow4: d.shadow[1], shadow8: d.shadow[2], shadow16: d.shadow[3],
    colorNeutralForegroundOnBrand: d.onAccent, colorBrandForegroundOnLight: d.accent,
    ...palette("Green", d.good), ...palette("DarkOrange", d.warn), ...palette("Red", d.bad), ...palette("Marigold", d.warn),
  };
  if (!dark) Object.assign(base, {
    colorNeutralBackground1: d.surface, colorNeutralBackground1Hover: d.hover, colorNeutralBackground1Pressed: d.hover, colorNeutralBackground1Selected: d.hover,
    colorNeutralBackground2: d.canvas, colorNeutralBackground3: d.sidebar, colorNeutralBackground4: d.hover, colorNeutralBackground5: d.border2, colorNeutralBackground6: d.border,
    colorSubtleBackgroundHover: d.hover, colorSubtleBackgroundPressed: d.hover, colorSubtleBackgroundSelected: d.hover,
    colorNeutralForeground1: d.text, colorNeutralForeground2: d.text2, colorNeutralForeground3: d.muted, colorNeutralForeground4: d.muted,
    colorNeutralStroke1: d.border, colorNeutralStroke2: d.border2, colorNeutralStroke3: d.border2, colorNeutralStrokeAccessible: d.text2,
    colorBrandBackground: d.accent, colorBrandBackgroundHover: d.accentHover, colorBrandBackgroundPressed: d.accentHover, colorBrandForeground1: d.accent, colorBrandForeground2: d.accentHover, colorBrandStroke1: d.accent, colorCompoundBrandStroke: d.accent, colorCompoundBrandBackground: d.accent, colorCompoundBrandForeground1: d.accent,
  });
  return Object.assign(t, base);
}
