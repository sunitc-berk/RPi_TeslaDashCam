# TeslaCam Dashboard

A local web app for browsing, searching and playing the dashcam footage your Raspberry Pi
uploads to `D:\TeslaCam`. It runs on your PC. Nothing is uploaded anywhere.

## First-time setup

1. **Install Python 3.11 or newer** if you don't have it:
   `winget install Python.Python.3.12` (or download it from python.org and tick "Add to PATH").
2. Make sure this folder is at **`D:\TeslaCam\webapp`**. The app reads footage from the folder
   above it. To keep it somewhere else, set `"root": "D:\\TeslaCam"` in `settings.json`.
3. Double-click **`start-dashboard.bat`**. The first run installs two Python packages
   (FastAPI and Uvicorn), then opens **http://localhost:8080**.
   To stop it: press **Ctrl+C** in its window, or double-click **`stop-dashboard.bat`**.
4. Optional: start it automatically at login, hidden:
   `powershell -ExecutionPolicy Bypass -File D:\TeslaCam\webapp\install-autostart.ps1`

## What it shows

The buttons on the left open each page. The box at the top searches a street, a city, a weekday or a date ("Nov 4").

| Page | What you can do |
|---|---|
| **Footage** | Every drive, day by day, with a picture from the front camera, its time, length, miles and a sketch of its route. Sentry alerts and saved clips sit in the same list. The panel beside the list chooses what to show (Drives, Parked, Sentry alerts, Saved clips, Kept) and holds the month calendar: click a day to jump to it, use the arrows to change month. **Map** at the top shows the same routes and alerts on a map. Footage parked at home is only listed under **Parked**. |
| **Kept** | Everything you have kept, from any month. Kept footage is never removed. |
| **Player** (click any row) | All six cameras in sync, with the route, speed and Autopilot state on a map beside the video. Click a small camera to make it big. Click the route or the speed chart to jump. **Keep** protects the footage from the 30-day cleanup (it is hard-linked into `D:\TeslaCam\Favorites\`, no extra space). Space = play/pause, arrows = 10 s, `,` `.` = one frame, 1-6 = choose the big camera. |
| **Uploads** | What is uploading now, what is waiting on the Pi, and what arrived. The dot at the bottom of the left navigation shows the same state at a glance. |
| **Pi** | Temperature, power, Wi-Fi and the Pi's diagnostics log. Problems with the Pi itself, including footage lost before it could upload, are shown here and only here. |
| **Storage** | How full the PC drive is and how fast it fills. |
| **Settings** | Place names, light/dark, rescan, and a line each on whether uploads, the Pi and storage are working. |

The pictures in the list are read from the videos by your browser as rows scroll into view; nothing extra is stored on disk.

**Place names** are off by default. When turned on (Settings), the start and end point of
each drive - never your home - is sent once to OpenStreetMap's public look-up service to get a street name.

## How it works

- `indexer.py` scans `D:\TeslaCam` every 5 minutes (and when you press **Rescan**) and builds
  `data\index.db` (SQLite). Tables: `clips`, `segments` (one per minute, all cameras),
  `trips`, `events`, `pi_metrics`, `syncs`, `removed`, `favorites`.
- **Trips** are runs of recent footage with no gap longer than 5 minutes (`trip_gap_minutes`).
- `drives.py` splits each trip into **drives** and **parked** stretches using the gear, speed and GPS
  position the car writes into every video frame (`gps.py` reads them), and works out where home is
  from where your drives start and end.
- Event details (time, reason, city, street, GPS) come from each clip folder's `event.json`.
- The Pi's per-file log (`PiMetrics\manifest-*.jsonl`) adds which car wake-up recorded each file
  and when it was saved and uploaded.
- Encrypted clips (from before encryption was turned off) are listed but can't play in a browser.

## Fixing file dates (one time)

Footage uploaded before 25 Oct 2026 evening shows a "Date modified" 7 hours off in Explorer.
Run once from this folder:  `.venv\Scripts\python fix-file-times.py`
(New uploads get the right time automatically.)

## Settings (`settings.json`)

| Setting | Default | Meaning |
|---|---|---|
| `root` | `null` | Footage folder. `null` = the folder above `webapp`. |
| `host` | `127.0.0.1` | `127.0.0.1` = this PC only. Use `0.0.0.0` to open it from your phone on your home Wi-Fi (Windows will ask to allow it through the firewall; choose **Private networks** only). |
| `port` | `8080` | Web port. |
| `index_interval_seconds` | `300` | How often to rescan. |
| `trip_gap_minutes` | `5` | Gap that splits two trips. |

Restart the dashboard after changing settings.

## On a phone

Open the same address on an iPhone or Android phone and the dashboard switches to a phone layout by itself (bottom tabs, drives as cards, the calendar and filters in a bottom sheet). It goes by the browser's user agent, or by any narrow touch screen. Add `?phone=1` or `?phone=0` to the address to force one layout or the other.

## Changing the look (the front end)

The pages are built with React and Microsoft's Fluent UI, bundled into one file, `static/app.js`.
You only need this section if you want to change the front end; the dashboard itself runs without Node.

```
cd /d D:\TeslaCam\webapp\ui
npm install            (once; needs Node.js 18 or newer: winget install OpenJS.NodeJS.LTS)
npm run build          (writes ..\static\app.js; then Ctrl+F5 in the browser)
npm run watch          (rebuilds on every save while you edit)
```

The source is in `ui/src`: `shell.jsx` (navigation, top bar, theme), `footage.jsx` (list, map, calendar),
`player.jsx` (the six cameras and the map), `uploads.jsx`, `pi.jsx`, `storage.jsx`, `settings.jsx`,
`lib.js` (the API, dates and words, upload state, the still-frame grabber, the router) and `theme.js` (colours and type).
`static/app.css` holds the few styles outside Fluent (maps, the video tiles, small windows), and `static/themes.css` the five looks
(Lovable is the default; Settings → Look switches between House, Tremor, Plotly, Lovable and Anthropic; `ui/src/designs.js` holds the same values for Fluent). The map library (Leaflet)
is in `static/vendor`. The previous plain-JavaScript front end is kept in `static-before-fluent`.
