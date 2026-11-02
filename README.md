# Network Signage

Open-source, self-hosted digital signage. One always-on computer serves rotating playlists, and any TV on the network plays them in a browser. Coaches and office staff manage content from a phone or laptop.

It runs on your local network only. There is no cloud service, account, or subscription.

## Install

1. Download the installer for the computer that will stay on: `.pkg` for macOS (`arm64` for Apple Silicon, `x64` for Intel), `.exe` for Windows.
2. Run it. The app starts, adds itself to startup, and sits in the menu bar or system tray.
3. Scan the QR code, or open the admin address it shows, and create the admin account.
4. On each TV, open the TV address it shows, then pair the TV using the 4-digit code on screen.

See [TV setup](docs/TV-SETUP.md) for Fire TV, Samsung, and LG.

The installers are not signed with a paid Apple or Microsoft certificate yet, so your computer warns you the first time:

- **macOS:** open the `.pkg`. When macOS blocks it, go to **System Settings > Privacy & Security**, scroll down, choose **Open Anyway**, and confirm. Then run the installer.
- **Windows:** choose **More info > Run anyway**.

Allow incoming connections when your firewall asks, or TVs cannot connect.

**Give the host computer a fixed IP address** (a DHCP reservation on your router). TVs reach it by address, so they lose it if the address changes.

See [test status](docs/TEST-STATUS.md) for what has been tested so far.

## What it does

- **Channels:** a channel is a named playlist. Each TV plays one channel, and many TVs can share one.
- **Library:** images (JPG, PNG, WebP, GIF), video, PDF (one slide per page), web pages, and text announcements. Items can appear on several channels.
- **Per item:** duration, transition (cut, fade, slide), sound (off by default), and show/hide. Drag to reorder, with a live preview.
- **Video:** every upload is converted to H.264/AAC MP4 for TV compatibility.
- **Override:** one click puts a message or library item on all or selected channels, until cleared or for a set number of minutes.
- **Live feeds:** show OBS, vMix, or a capture card on your TVs. See [Live feed](#live-feed).
- **Users:** admins do everything. Editors manage content on their assigned channels. Override is a separate permission.
- **Branding:** organization name, logo, colors, and font.
- **Resilient TVs:** changes arrive instantly with no refresh. TVs cache media and keep playing through network drops, then reconnect on their own.

YouTube is intentionally not supported.

## Live feed

An admin creates a feed under **Live Feeds**. It then appears in the Library, and anyone can add it to their channels like any other item. For several live views, such as Program and Multiview, use one feed and one channel for each.

A feed only shows on TVs while it is on air. While it's down, TVs keep rotating through the rest of the channel, and they pick the feed up as soon as it returns. An override on a feed that's down shows "Waiting for the live feed", then switches to the video when it starts.

### Set up OBS or vMix

Create the feed first. The **Live Feeds** page shows the exact address to use, with your computer's address and the feed's port filled in.

**RTMP**

- **OBS:** go to **Settings > Stream**, choose **Custom** as the service, then paste the **Server** and **Stream key** from the Live Feeds page.
- **vMix:** go to **Settings > Streaming**, choose **Custom RTMP Server**, then paste the server as the URL and the stream key as the stream name.

**SRT** is offered only if this computer's copy of ffmpeg supports it. If you don't see it as an option, use RTMP. Set the sender to **Caller** mode, with the address shown on the Live Feeds page.

**Capture cards and cameras** are listed if your system exposes them, which needs the card's driver for DeckLink and Magewell. On a Mac, the first use may need camera permission: go to **System Settings > Privacy & Security > Camera** and turn on Network Signage.

Turn on automatic reconnect in your sender. The feed stops listening for a moment each time a sender disconnects, so a reconnect can take a second try.

### Security

- **Never port-forward a feed's port.** The app's local network filter covers its web pages and video, but not these ports, because ffmpeg listens on them directly. Anyone who can reach the port can send video to your TVs. The stream key is not a password, because ffmpeg accepts any key.
- **Anyone on your network can watch a channel,** including its live feeds, since TV addresses don't require signing in.

### Network load

Each TV downloads its own copy of the video. As a rule of thumb, multiply the feed's maximum quality by the number of TVs showing it: 10 TVs at 6 Mbps is 60 Mbps, all leaving the host computer. Connect the host by Ethernet, and be careful with many TVs on one Wi-Fi access point. Lower the maximum quality on the feed if video stutters.

### Latency

In testing with a synthetic source on the host computer, a frame took about 1 to 2 seconds to reach the playlist, and about 3 to 5 seconds to reach the screen in a desktop browser. Real TVs and networks may differ.

## Good to know

- **Anyone on your network can open a TV address.** Players do not sign in, so media and playlists are visible to anyone on the LAN. Only the admin requires a password. Do not put private material on signage, and consider a separate network for guests.
- **Requests from outside the local network are refused** by source address. Do not port-forward to this app. It uses plain HTTP, which is not safe over the internet.
- **Web pages:** some sites refuse to appear inside another page and will show blank.
- **Sound:** TV browsers block autoplay with sound unless a kiosk browser allows it. A video with sound turned on plays muted rather than freezing. See [TV setup](docs/TV-SETUP.md).
- **Forgotten passwords:** an admin can reset anyone's password under **Users**. If an admin is locked out, go to the signage computer and choose **Reset admin password** from the tray menu. It shows a temporary password to sign in with, which you then change under **Settings**. Without the tray app, run `npm run reset-admin -- <username>`. This only works on the host computer, so keep it somewhere trusted.
- **Backups:** everything is in the data folder (tray menu > **Open data folder**). Copy it while the app is stopped.
- **Port:** the default is 8080. To change it, put `{ "port": 9000 }` in `config.json` in the data folder and restart.

### How offline playback works

Browsers only allow service workers and the Cache API on HTTPS or `localhost`, so they are unavailable at an address like `http://192.168.1.20:8080`. The player therefore stores media in IndexedDB, which works over plain HTTP, and plays from there.

A TV that is already playing keeps going through an outage. A TV that reloads or restarts while the server is down cannot load the page at all, because the page itself is not cached over plain HTTP. It recovers once the server returns if the browser retries, which Fully Kiosk can do automatically. The service worker in `public/player/sw.js` keeps the page available only where browsers allow it (HTTPS or `localhost`).

Files over 500 MB are not cached, and stream from the server instead.

## Develop

Requires Node.js 22.13 or newer.

```bash
npm install
```

```bash
npm test
```

```bash
npm run dev
```

```bash
npm run tray
```

`npm run dev` serves on port 8080 and stores data in `~/.network-signage`. Set `PORT` and `SIGNAGE_DATA_DIR` to change them. `npm run tray` runs the Electron tray app.

### Build installers

```bash
npm run dist:mac
```

```bash
npm run dist:win
```

Both work from a Mac, because the app has no native Node modules. Output goes to `dist/`.

### Layout

| Path | Purpose |
| --- | --- |
| `server/` | Fastify API, SQLite (`node:sqlite`), WebSocket hub, ffmpeg queue |
| `server/live/` | Live feeds: one supervised ffmpeg per feed, and capability probing |
| `public/player/` | TV player. Strict ES5 with no build step, for old TV browsers (a test enforces this) |
| `public/admin/` | Mobile-first admin. Plain ES modules with no build step |
| `electron/` | Tray app |
| `test/` | Integration tests against a real server, ffmpeg, and WebSockets |

## License

MIT. See [LICENSE](LICENSE).

The installers bundle an [ffmpeg](https://ffmpeg.org) build from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static), which runs as a separate program and is licensed under the GPL. Its license ships beside the binary, and its source is available from the ffmpeg project. Also used: [hls.js](https://github.com/video-dev/hls.js) (Apache-2.0), [PDF.js](https://github.com/mozilla/pdf.js) (Apache-2.0), [SortableJS](https://github.com/SortableJS/Sortable) (MIT).
