// The street map used by the footage map and the player map (Leaflet is loaded by index.html as window.L).
export function streetLayer(cfg = {}) {
  const OSM = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
  return cfg.carto_api_key
    ? L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png?key=${encodeURIComponent(cfg.carto_api_key)}`, { maxZoom: 20, attribution: OSM + ' &copy; <a href="https://carto.com/attributions">CARTO</a>' })
    : L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri, HERE, Garmin, " + OSM });
}
