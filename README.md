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
- **Scheduling:** give any item on a channel start and end dates, times of day (overnight works), and days of the week. Each item shows as On now, Scheduled, or Ended. TVs follow the host computer's clock, even if their own is wrong, and keep to the schedule through network drops.
- **Video:** every upload is converted to H.264/AAC MP4 for TV compatibility.
- **Override:** one click puts a message or library item on all or selected channels, until cleared or for a set number of minutes.
- **Live feeds:** show OBS, vMix, or a capture card on your TVs. See [Live feed](#live-feed).
- **Users and roles:** each person has a role and a set of channels. Built-in roles are Admin (everything), Editor (content on assigned channels), Editor with Override (the same, plus overrides), and Uploader (adds content to assigned channels, and can only change what they uploaded). Admins can create custom roles under **Users > Roles**. See [Roles](#roles).
- **Branding:** organization name, logo, colors, and font.
- **Resilient TVs:** changes arrive instantly with no refresh. TVs cache media and keep playing through network drops, then reconnect on their own.

YouTube works through its embed links (**Share > Embed**), which play muted. Regular YouTube links are not accepted, because YouTube refuses to appear inside another page.

## Live feed

Someone with permission to manage live feeds creates a feed under **Live Feeds**. It then appears in the Library, and anyone can add it to their channels like any other item. For several live views, such as Program and Multiview, use one feed and one channel for each.

A feed only shows on TVs while it is on air. While it's down, TVs keep rotating through the rest of the channel, and they pick the feed up as soon as it returns. An override on a feed that's down shows "Waiting for the live feed", then switches to the video when it starts.

### Set up OBS or vMix

Create the feed first. The **Live Feeds** page shows the exact address to use, with your computer's address and the feed's port filled in.

**RTMP**

- **OBS:** go to **Settings > Stream**, choose **Custom** as the service, then paste the **Server** from the Live Feeds page, and what it shows for the **Stream key** box.
- **vMix:** go to **Settings > Streaming**, choose **Custom RTMP Server**, then paste the server as the URL, and what the page shows for the stream key box as the stream name.

**SRT** is offered only if this computer's copy of ffmpeg supports it. If you don't see it as an option, use RTMP. Set the sender to **Caller** mode, with the address shown on the Live Feeds page.

**Capture cards and cameras** are listed if your system exposes them, which needs the card's driver for DeckLink and Magewell. On a Mac, the first use may need camera permission: go to **System Settings > Privacy & Security > Camera** and turn on Network Signage.

Turn on automatic reconnect in your sender. The feed stops listening for a moment each time a sender disconnects, so a reconnect can take a second try.

### Security

- **Anyone on the network who can reach a feed's port can send video to this feed.** While nothing else is sending, whatever they send plays on your TVs. OBS and vMix ask for a stream key, but it only fills in that box: it isn't a password, because ffmpeg accepts any key.
- **Use a separate network if you share this one.** If guests or the public are on your network, put the host computer and the computer sending the video, such as a production trailer, on their own separate network, so nobody else can reach these ports.
- **Never port-forward a feed's port.** The app's local network filter covers its web pages and video, but not these ports, because ffmpeg listens on them directly.
- **Anyone on your network can watch a channel,** including its live feeds, since TV addresses don't require signing in.

### Network load

Each TV downloads its own copy of the video. As a rule of thumb, multiply the feed's maximum quality by the number of TVs showing it: 10 TVs at 6 Mbps is 60 Mbps, all leaving the host computer. Connect the host by Ethernet, and be careful with many TVs on one Wi-Fi access point. Lower the maximum quality on the feed if video stutters.

### Latency

In testing with a synthetic source on the host computer, a frame took about 1 to 2 seconds to reach the playlist, and about 3 to 5 seconds to reach the screen in a desktop browser. Real TVs and networks may differ.

## Roles

A role is a checklist of what someone can do:

- **Library:** upload, edit and delete their own uploads, edit and delete any item.
- **Channels:** add library items, change items on a channel (order, settings, schedules, removal), create, rename, and delete channels, and work on every channel rather than only assigned ones.
- **Everything else:** overrides, TVs and pairing, live feeds, branding and settings, people and roles.

Some rules always apply:

- **Upgrading keeps everyone's access.** Admins become Admin. Editors become Editor, or Editor with Override if they could push overrides. Their channels stay the same.
- **Shared items:** a library item can't be changed by someone if it's also on a channel they don't work on, unless they work on every channel.
- **Overrides reach every channel,** whatever someone's assigned channels are.
- **Nobody can give access they don't have,** to a person or to a role, and nobody can change the account of someone with more access than them.
- **Someone always keeps full access.** The last account with every permission can't be demoted or deleted, and its role can't be reduced.
- **Roles in use can't be deleted.** Move the people to a different role first. Built-in roles can't be changed.
- **Changes apply right away,** on that person's next action, with no need to sign in again.

## Good to know

- **Anyone on your network can open a TV address.** Players do not sign in, so media and playlists are visible to anyone on the LAN. Only the admin requires a password. Do not put private material on signage, and consider a separate network for guests.
- **Requests from outside the local network are refused** by source address. Do not port-forward to this app. It uses plain HTTP, which is not safe over the internet.
- **Web pages:** some sites refuse to appear inside another page and will show blank.
- **Sound:** TV browsers block autoplay with sound unless a kiosk browser allows it. A video with sound turned on plays muted rather than freezing. See [TV setup](docs/TV-SETUP.md).
- **Forgotten passwords:** anyone who can manage people can reset a password under **Users**, for accounts that don't have more access than they do. If an admin is locked out, go to the signage computer and choose **Reset admin password** from the tray menu. It shows a temporary password to sign in with, which you then change under **Settings**. Without the tray app, run `npm run reset-admin -- <username>`. Both work for any account with full access, whatever its role is called. They only work on the host computer, so keep it somewhere trusted.
- **Backups:** an account with full access can download everything from **Settings > Backup and restore**, while TVs keep playing. The file holds all your media and everyone's hashed passwords, so keep it somewhere safe. To move to a new computer, install the app there and choose **Restore from a backup** on the first screen. Restoring also works from Settings, where it replaces everything on the server. If the new computer gets a different address, TVs need that fixed, and the app explains how. A backup can be up to 20 GB, the largest file the app accepts.
- **Internet use:** the server's only outbound request is a once-a-day check of this project's GitHub Releases for a newer version, which then shows a notice with an **Install now** button and a link. Nothing downloads or installs until someone chooses to, because installing restarts the app and stops live feeds for a moment. Turn it off under **Settings > Check for updates**, and the server contacts nothing outside your network.
- **Finding the server:** the app announces itself on your local network as an mDNS service, `_network-signage._tcp`, so the kiosk app can find it. It includes an ID that stays the same when the computer's name or address changes, and a restored backup keeps it, so TVs can keep following the same server. If another computer on the network already uses the name, this one adds a number to its own. If publishing fails, everything else keeps working, and it tries again later.
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
