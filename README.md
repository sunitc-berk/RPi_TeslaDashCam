# RPi_TeslaDashCam

**A Raspberry Pi that pretends to be my Tesla's dashcam drive, and brings the footage home over Wi-Fi.**

The car records six cameras all day onto a USB stick in the glovebox, and that is where the footage dies: you only ever look at it when something has already gone wrong. This project replaces the stick with a Raspberry Pi 4. The car still sees a plain USB drive, but every time I park at home the Pi quietly copies the new clips to my Windows PC, where a small dashboard turns them into something you would actually open: every drive on a calendar, all six cameras playing in sync, the route on a map, and a health page for the Pi itself.

<p align="center">
  <img src="docs/images/pi-in-glovebox-wide.jpg" width="46%" alt="The Raspberry Pi in the glovebox, plugged into the car's USB port">
  &nbsp;
  <img src="docs/images/dashboard-footage.png" width="52%" alt="The dashboard's Footage page: drives listed by day with a thumbnail, time, miles and a sketch of the route">
</p>

Inspired by [teslausb](https://github.com/marcone/teslausb). Different goals: dashcam files only, nothing else on the drive, a dashboard rather than a folder of MP4s, and whole drives kept, not just Sentry events.

## What it does

- **Looks like a USB stick to the car.** The Pi's USB-C port runs in gadget mode (`g_mass_storage`) and presents a 64 GB FAT32 image. The car writes `RecentClips`, `SavedClips` and `SentryClips` to it like any other drive.
- **Brings everything home.** Every two minutes the Pi checks whether it can reach the PC. When it can, it uploads finished clips to a Windows share in small batches, verifies each file's size on the PC, and only then deletes it from the Pi.
- **Survives the car.** The car cuts the Pi's power whenever it goes to sleep, and Wi-Fi drops mid-transfer are normal. Nothing is ever mounted that could hang; uploads use `smbclient` with time limits, files are written as `.part` and renamed when complete, and every run starts by healing whatever the last one left behind.
- **Keeps whole drives.** Finished minutes of `RecentClips` are copied to the Pi's SD card (a 40 GB rolling buffer) so a drive is kept even if the car later overwrites its own copy. The PC keeps 30 days of drives and everything you mark as kept.
- **Reports on itself.** Temperature, throttling, Wi-Fi signal, CPU, SD space, USB state and every upload are logged on the Pi and shipped to the PC with the footage.
- **Shows it all in a dashboard** on the PC: calendar, search, six-camera synced player with the route and speed read out of the video frames, Sentry events on a map, upload progress, Pi health and storage. Nothing leaves your home network; the only optional outside call is a street-name lookup you turn on yourself.

## How it works

<p align="center"><img src="docs/images/architecture.png" width="100%" alt="Car → USB → Raspberry Pi → Wi-Fi → Windows PC share → dashboard"></p>

**On the Pi** (`pi/`), a systemd timer runs `teslacam-sync.sh` every two minutes:

1. `teslacam-heal.sh` cleans up after a run that was killed by a power cut or a Wi-Fi drop.
2. If the car is idle at home, new Saved and Sentry clips are copied from the USB image to the SD card and the drive is handed straight back to the car. The car is never without its drive while an upload runs.
3. If the PC answers, `teslacam-upload.py` uploads staged clips, recent footage and metrics with `smbclient`, in batches of about 400 MB, two streams at a time (dropping to one when the link is slow), and verifies each file's size on the PC before anything is deleted. Once a day it removes drives older than the retention period from the PC.

Alongside it, `teslacam-archive.py` copies each finished minute of `RecentClips` into the 40 GB buffer every five minutes, `teslacam-metrics.py` samples the Pi's health every five minutes, `teslacam-manifest.py` records which car wake-up produced each file, and `teslacam-diag.py` writes the problems log, including **footage lost** events when the buffer had to drop drives that never made it home. During an upload the Pi also writes a live status file to the share every five seconds, which is what the dashboard's Uploads page and the "57% Uploading" pill in its navigation read.

**On the PC** (`webapp/`), `indexer.py` scans the footage folder every five minutes into a SQLite index (`clips`, `segments`, `trips`, `events`, `pi_metrics`, `syncs`, `favorites`). `drives.py` splits each trip into drives and parked stretches using the gear, speed and GPS position Tesla embeds in every video frame (`gps.py` reads them), and works out where home is from where drives start and end. `server.py` (FastAPI) serves the API and the front end, which is React + Microsoft Fluent UI bundled into one file so the dashboard runs without Node.

## The dashboard

| | |
|:--|:--|
| <img src="docs/images/dashboard-player.jpg" alt="Player: six cameras in sync, speed and Autopilot state, the route on a map, and a speed chart"> | <img src="docs/images/dashboard-pi.png" alt="Pi page: a car → Pi → Wi-Fi → PC pipeline, a 24-hour timeline, and gauges for temperature, Wi-Fi, processor and upload speed"> |
| **Player.** Click any drive: all six cameras play in sync, with speed, gear, Autopilot state and the route on a map beside them. Click the map or the speed chart to jump. Keep protects a drive from the 30-day cleanup. | **Pi.** What the Pi is doing right now, the last 24 hours as a timeline (home, away, uploads, power-ups, footage lost), and four vitals with range gauges so you can tell at a glance whether a number is normal. |
| <img src="docs/images/dashboard-uploads.png" alt="Uploads page: progress of the current upload with a running list of files arriving, the Pi's signal, car and temperature, and past uploads"> | <img src="docs/images/dashboard-storage.png" alt="Storage page: how full the PC drive is, footage by day, and when the drive will be full"> |
| **Uploads.** Progress of the current upload and a running list of files as they arrive, with the Pi's signal, car connection and temperature beside it. | **Storage.** How full the PC drive is, footage per day, and when it will be full at the current rate. |

The look is switchable (Settings → Look): five design systems, each defined once as CSS variables in `webapp/static/themes.css` and as a Fluent theme in `webapp/ui/src/designs.js`.

<p align="center"><img src="docs/images/dashboard-evolution.gif" width="100%" alt="The Footage page in six versions, October 25 to November 13"></p>

*How the Footage page changed over three weeks: six looks, the same footage. The 28 colour schemes that were tried and rejected along the way are in [docs/images/rejected-looks.png](docs/images/rejected-looks.png).*

## The build

<table>
  <tr>
    <td><img src="docs/images/build-01-parts.jpg" alt="Raspberry Pi 4 board, heatsinks and the acrylic case parts"></td>
    <td><img src="docs/images/build-02-board-top.jpg" alt="Raspberry Pi 4 Model B, top"></td>
    <td><img src="docs/images/build-03-board-bottom-sd.jpg" alt="Underside of the board with the microSD card fitted"></td>
  </tr>
  <tr>
    <td><img src="docs/images/build-04-heatsinks-and-fan-lid.jpg" alt="Heatsinks on, fan mounted to the lid"></td>
    <td><img src="docs/images/build-05-assembled-top.jpg" alt="Assembled case, top"></td>
    <td><img src="docs/images/build-06-ports.jpg" alt="Assembled case, port side"></td>
  </tr>
  <tr>
    <td><img src="docs/images/build-07-sd-slot-and-led.jpg" alt="SD card slot and the power LED through the case"></td>
    <td><img src="docs/images/build-08-underside.jpg" alt="Underside of the assembled case with the USB-C cable"></td>
    <td><img src="docs/images/build-09-done.jpg" alt="Finished, cable attached"></td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/pi-glovebox-closeup-wide.jpg" width="32%" alt="The Pi in the glovebox, close up">
  <img src="docs/images/pi-glovebox-side.jpg" width="32%" alt="The Pi in the glovebox from the side, cable to the USB port">
  <img src="docs/images/car-rear-wide.jpg" width="32%" alt="The car in the garage">
</p>

### Hardware

| Part | Notes |
|---|---|
| Raspberry Pi 4 Model B, 2 GB | A good fit: USB gadget mode on its USB-C port, 5 GHz Wi-Fi, and enough CPU to push ~10 MB/s of signed SMB traffic. 2 GB of RAM is plenty. |
| 128 GB microSD, high-endurance | 64 GB goes to the USB image the car writes to, 40 GB to the drive buffer, the rest to the OS. High-endurance cards are made for exactly this kind of constant writing. |
| Acrylic case with fan and heatsinks | The glovebox gets warm. With the fan the Pi sits around 50 °C while uploading. |
| Short USB-C to USB-A cable | From the car's USB port. Data lines are required; charge-only cables will not work. |
| A Wi-Fi node near the car | Optional but worth it (see "Things I learned"). |

## Setting it up

### 1. The Pi

**Flash the card.** Raspberry Pi OS Lite (64-bit) with Raspberry Pi Imager. In the Imager's settings set the hostname (`teslapi`), a user, your Wi-Fi, and turn on SSH, so the Pi comes up on your network headless.

**Make the USB drive.** This is the one part that is done by hand, once. Turn on device mode for the Pi's USB-C port by adding `dtoverlay=dwc2,dr_mode=peripheral` to `/boot/firmware/config.txt`, then create the image the car will see as its drive (Tesla wants a FAT32 drive with a `TeslaCam` folder on it):

```bash
sudo mkdir -p /piusb /mnt/cam
sudo fallocate -l 64G /piusb/cam.bin
sudo mkfs.vfat -F 32 -n TESLACAM /piusb/cam.bin
sudo mount -o loop /piusb/cam.bin /mnt/cam && sudo mkdir /mnt/cam/TeslaCam && sudo umount /mnt/cam
sudo reboot
```

**Install.** Copy the `pi/` folder to the Pi and run the installer:

```bash
scp -r pi pi@teslapi.local:~/ && ssh pi@teslapi.local
cd ~/pi && sudo bash install.sh
```

`install.sh` is safe to run again after any change. It installs the scripts into `/usr/local/bin` and the systemd units and timers (including `teslacam-usb.service`, which checks the image with `fsck` and presents it to the car with `g_mass_storage` at every boot), asks for the share's user name and password and stores them in `/root/.teslacam-smb`, turns off Wi-Fi power saving, makes the system log survive power cuts, runs a self-check that every script loads, and records the installed version so the dashboard can show when the Pi's software was last updated.

**Point it at the PC.** Set your PC's address and share name at the top of `teslacam-sync.sh` (before or after installing; the installer copies it). Reserve the PC's IP address in your router so it never changes.

**Plug it in.** On the car's screen the dashcam icon appears within a minute; `cat /sys/class/udc/*/state` on the Pi says `configured`.

Useful afterwards: `sudo systemctl list-timers 'teslacam*'`, `journalctl -t teslacam-sync -f`, and `sudo teslacam-upload.py --heartbeat` to push a status update by hand.

### 2. The PC

1. Run `windows\setup-share.ps1` as administrator. It creates the footage folder (`D:\TeslaCam`), shares it as `TeslaCam`, and creates a local user for the Pi with access to that share only.
2. Copy `webapp\` to `D:\TeslaCam\webapp` and double-click `start-dashboard.bat`. The first run installs FastAPI and Uvicorn into a local virtual environment, then opens **http://localhost:8080**. `install-autostart.ps1` makes it start at login, hidden.

The dashboard's own README, `webapp/README.md`, covers its settings (port, rescan interval, opening it to your phone on the home Wi-Fi) and how to rebuild the front end if you want to change it.

### Folder layout on the share

```
D:\TeslaCam
├── RecentClips\            every drive, one folder per car wake-up, 1-minute clips × 6 cameras
├── SavedClips\             clips you saved from the car's screen (with event.json)
├── SentryClips\            Sentry events
├── Favorites\              hard links to footage you marked Keep (never cleaned up)
├── PiMetrics\
│   ├── 2026-11-12.jsonl    the Pi's health samples, one line per 5 minutes
│   ├── manifest-2026-11.jsonl   which wake-up produced each file, when it was saved and uploaded
│   ├── sync-history.jsonl  every upload run
│   ├── diag\               the Pi's problems log and network samples
│   └── live\status.json    what the Pi is doing right now (rewritten every 5 s while uploading)
└── webapp\                 the dashboard (this repo's webapp folder) and its data\index.db
```

## What's in this repo

```
pi/                 everything that runs on the Raspberry Pi
  install.sh          installs everything below, asks for the share password, self-check, records the version
  teslacam-usb.service  fsck the drive image, then present it to the car (g_mass_storage)
  teslacam-sync.sh    the 2-minute loop: heal → stage events → upload → daily cleanup (settings at the top)
  teslacam-upload.py  smbclient uploads in batches, verify-before-delete, live status, retention
  teslacam-archive.py copies finished RecentClips minutes into the 40 GB buffer on the SD card
  teslacam-heal.sh    recovers from a run that was cut off
  teslacam-metrics.py temperature, throttling, CPU, memory, SD, Wi-Fi, USB state → PiMetrics
  teslacam-diag.py    problems log, network samples, Wi-Fi self-repair, support bundle
  teslacam-manifest.py / teslacam_sei.py / teslacam-report-failure.sh, and the .service and .timer units
windows/            setup-share.ps1: the shared folder and the Pi's user on the PC; move-teslacam-to-d.ps1
webapp/             the dashboard: server.py (FastAPI), indexer.py, drives.py, gps.py, static/, ui/src/
docs/               the photos and screenshots used here, and architecture.svg
```

## Things I learned the hard way

- **The first clips would not play.** Tesla started encrypting dashcam footage in software 2026.20; it can only be viewed on the car's screen until you turn encryption off in the Dashcam settings. The dashboard lists the encrypted clips it finds but cannot play them.
- **The car cuts the Pi's power when it sleeps.** With Sentry mode off at home (which is what you want in your own garage) the USB port goes dead as soon as the car goes to sleep. Everything on the Pi had to be designed to be interrupted at any moment: short steps, state on disk, a heal step at the start of every run.
- **Never mount the share.** An early version mounted the PC with CIFS. When Wi-Fi dropped mid-transfer the process hung in the kernel and could not be killed until a reboot. `smbclient` is an ordinary program with a timeout; it loses, it exits, the next run carries on.
- **Lost footage should be loud.** When uploads stalled for a week, the 40 GB buffer kept filling and had to drop its oldest drives: 450 GB never made it home, and nothing told me. A file is only ever removed from the Pi after the PC reports the same size, and now the Pi logs a "footage lost" event whenever the buffer drops something that never uploaded, and the dashboard's Pi page shows it in one line at the top.
- **Wi-Fi is the whole game.** Uploads collapsed one afternoon from 10 MB/s to nothing. The router had been moved, nine ESP32 boards on the mesh were adding congestion, and the Pi had picked a far-away mesh node. The fix was a mesh node in the garage next to the car, pinning the Pi to it (`nmcli connection modify <ssid> 802-11-wireless.bssid <mac>`), and making the upload code tolerate a slow link (longer timeouts, fewer streams when slow, retry before giving up) instead of stopping at the first stall.
- **The Pi's CPU is part of the link.** Windows signs every SMB packet and a Pi 4 has no hardware help for that, so a single `smbclient` connection is held back by one core as much as by the Wi-Fi. Two parallel streams help on a good link; more than two just fight over the air, so the uploader drops back to one stream as soon as the link is slow.

## Credits

- [teslausb](https://github.com/marcone/teslausb) for proving the USB-gadget idea and for a decade of hard-won notes.
- Built with [Claude](https://claude.com) as a pair: the dashboard was designed as rendered mockups before any code was written, and the Pi's logs were read and debugged the same way.
- [FastAPI](https://fastapi.tiangolo.com), [React](https://react.dev), [Fluent UI](https://react.fluentui.dev), [Leaflet](https://leafletjs.com), map tiles by Esri and [OpenStreetMap](https://www.openstreetmap.org) contributors, fonts from [Google Fonts](https://fonts.google.com).

## License

[MIT](LICENSE). Use it, change it, tell me what you built.
