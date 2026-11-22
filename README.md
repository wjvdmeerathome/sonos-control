# Sonos Control

A Windows app to control Sonos speakers on your home network. No Sonos account and no cloud: the app talks directly to the speakers over the local network.

The interface is in Dutch.

## Features

- All rooms and groups with what's playing, including album art
- Play/pause, next/previous, shuffle, repeat and seeking
- Group volume and per-room volume, mute
- Group and ungroup rooms
- Play Sonos favorites (radio, Spotify playlists, …)
- Queue: see what's next, jump to a track, remove tracks or clear the queue
- Sleep timer (15 minutes to 1.5 hours)
- Sound settings per speaker: bass, treble, loudness, plus night mode and speech enhancement on soundbars
- Alarms: view your Sonos alarms and switch them on or off
- System info per speaker (model, software, Wi-Fi band and channel, network traffic), based on the speaker's `/support/review` page
- **Live updates**: changes made in the Sonos app or on the speaker show up immediately
- **Mini player**: minimise the window and a small always-on-top player appears (drag it anywhere; scroll for volume)
- **Tray icon** with playback controls; optionally keeps running when you close the window
- **Media keys** on your keyboard control Sonos (optionally the volume keys too)
- **Start with Windows** (starts hidden in the tray)
- **Automatic updates** from GitHub releases
- Keyboard: space = play/pause, ↑/↓ = volume

## Install

Download `Sonos-Control-Setup-x.y.z.exe` from the [latest release](https://github.com/wjvdmeerathome/sonos-control/releases/latest) and run it.
Windows SmartScreen may warn because the installer is not code-signed: choose *More info* → *Run anyway*.

On first start Windows Firewall asks whether Sonos Control may use the network. Allow it on private networks: the speakers use that connection to send live updates. Without it the app still works, but refreshes every 2 seconds instead.

## Settings

Open the gear icon in the app, or right-click the tray icon:

| Setting | Default |
|---|---|
| Mini player when minimised | on |
| Media keys control Sonos | on |
| Volume keys control Sonos | off |
| Start with Windows | off |
| Close to tray | on |

Speakers not found? Create `%APPDATA%\sonos-control\config.json` with fixed IP addresses:

```json
{ "speakers": ["192.168.1.20"] }
```

## How it works

`server.js` finds speakers via SSDP (falling back to a scan of the local /24 subnet on port 1400), talks UPnP/SOAP to them and subscribes to their UPnP events. The windows receive updates over Server-Sent Events. The Electron app (`electron/`) runs that server in-process (port 8421) and adds the windows, tray, media keys and updater.

## Development

```
npm install
npm start            # run the app
npm run smoke        # smoke test: main window, live connection, settings, mini player, close to tray
npm run dist         # build the installer in dist/
```

Web version only, without Electron: `node server.js` and open <http://localhost:8420> (or double-click `Sonos.cmd`; stop with `Stop.cmd`). Set `PORT` to change the port and `SONOS_DEBUG=1` to log incoming speaker events. To use it from a phone, start it with `HOST=0.0.0.0` and open `http://<pc-ip>:8420` — there is no password, so only do this on your own home network.

## License

MIT
