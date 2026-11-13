// Colours and type: the house red-orange on Fluent by default, or one of the design systems in designs.js.
import { tokens } from "@fluentui/react-components";
import { THEME, useStore } from "./lib.js";
import { DESIGN, DESIGNS, fluentTheme } from "./designs.js";

export const T = tokens;
const cache = {};
export function useFluentTheme() {
  const { id } = useStore(DESIGN), { dark } = useStore(THEME), k = `${id}:${dark}`;
  return cache[k] || (cache[k] = fluentTheme(DESIGNS[id], dark));
}
// colours that are not Fluent tokens: Sentry amber, saved-clip green, the trip colour in charts, the map line
export function useColors() {
  const { dark } = useStore(THEME), { id } = useStore(DESIGN), d = DESIGNS[id];
  return dark
    ? { dark, AMBER: "#F2B649", GREEN: "#3DBB78", TRIP: "#9A9A93", FREE: "#3D3D3D", OTHER: "#6B6B6B", MAPLINE: "#A0A09A", BRAND: d.accent, ON_BRAND: d.onAccent, CHART: d.chart }
    : { dark, AMBER: d.warn.fg, GREEN: d.good.fg, TRIP: d.trip, FREE: d.free, OTHER: d.other, MAPLINE: d.mapLine, BRAND: d.accent, ON_BRAND: d.onAccent, CHART: d.chart };
}
export const CAT = (c, type) => type === "sentry" ? c.AMBER : type === "saved" ? c.GREEN : type === "drive" ? c.BRAND : c.TRIP;
