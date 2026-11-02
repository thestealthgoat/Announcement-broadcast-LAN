# V2 build plan

Goal: signs that show the right thing at the right time, run unattended, and can carry a live feed.

Apple signing and notarization come after V2. Live data slides, fill-in templates, PowerPoint import, Roku and Apple TV apps, and per-channel passwords are out of scope.

## Ground rules

- The player (`public/player/*`) stays strict ES5 with no build step. `test/realtime.test.js` enforces this, so add new player files to that test.
- Schema changes are new numbered files in `server/migrations/`: `002` scheduling, `003` live feeds, `004` operations. Never rebuild the `media` or `playlist_items` tables, because with foreign keys on, dropping them cascades into playlists. `test/migrations.test.js` upgrades a real 1.0.2 database.
- Every feature has automated tests that use a real server, and `npm test` stays green.
- Admin copy is plain language for non-technical staff, and screens work at phone width.
- Tests never use port 8080, the default data folder, or login items. `SIGNAGE_DATA_DIR`, `PORT`, and `SIGNAGE_NO_AUTOSTART` isolate a run.

## A. Scheduling

Per playlist item (per placement on a channel), so one library item can run on different schedules on different channels.

- `002-schedule.sql` adds nullable columns to `playlist_items`: `start_date`, `end_date` (`YYYY-MM-DD`, both inclusive), `start_time`, `end_time` (`HH:MM`), and `days` (bitmask, Sunday = 1 through Saturday = 64; NULL means every day).
- A window where end time is before start time runs overnight. The days field refers to the day the window starts.
- Schedules use the host computer's wall clock, not the TV's clock, which is often wrong.
- `public/player/schedule.js` is one ES5 file, loaded by both the player and Node, that answers "is this active at this wall-clock time?".
- The server sends every enabled ready item with its schedule, plus the host's wall-clock time. The player filters locally and rechecks about every 15 seconds, so schedules keep working through network drops.
- A schedule ending while its item plays moves on right away. If nothing is active, the idle screen shows. Overrides ignore schedules.
- The admin shows each item as On now, Scheduled, or Ended, and edits schedules in the item settings.

## B. Operations

- **Finding the server:** publish an mDNS service, `_network-signage._tcp`, with `bonjour-service`, for the kiosk app to discover. Failure to publish must never stop the server.
- **Address changes:** remember the host's primary LAN address. When it changes, show admins a banner saying TVs using the old address must be updated, and how to prevent it with a router reservation.
- **Update notices:** once a day, check GitHub Releases, including pre-releases, for a newer version. Show admins a banner and the tray a menu item linking to the release. There's a setting to turn this off, failures are silent, and nothing installs automatically until the app is signed.
- **Screen health:** the admin shows a count and list of paired screens offline for over 5 minutes, and a TV's heartbeat reports when its media cache is full.
- **Storage warnings:** warn admins when the host has under 2 GB or 10% free, and show library size in Settings.

## C. Live Feed

A live feed is a library item of the existing `hls` type whose address is `/live/<id>/index.m3u8`, plus a row in a new `live_feeds` table from `003-live.sql`. That means playlists, overrides, and the player work with no rewrite. One channel per feed gives Program, Multiview, and so on.

- **Inputs:** an SRT or RTMP listener for vMix or OBS, and capture devices listed by ffmpeg (DirectShow on Windows, AVFoundation on macOS, which covers UVC, DeckLink, and Magewell when their drivers expose them). NDI stays out.
- **Pipeline:** one ffmpeg process per feed encodes once to H.264 low-latency HLS, using 1-second segments and a short playlist, targeting 2–5 seconds of latency. Probe for NVENC, Quick Sync, and VideoToolbox with a real test encode, and fall back to libx264. Capabilities are probed, and unavailable options are hidden.
- **Supervision:** restart with backoff, report idle, live, or error, start enabled feeds at boot, and stop cleanly with no leftover ffmpeg. Segments live under `live/` in the data folder and are cleaned up.
- **While a feed is down:** the hub leaves it out of playlists, so screens keep rotating, and pushes as soon as it goes live. An override on a feed that's down shows a plain "Waiting for the live feed" slide.
- **Admin:** an admin-only Live Feeds page shows the address to paste into vMix or OBS, status, and encoder. Editors can add feeds to their channels like any item.
- **Security:** ffmpeg listeners can't use the app's LAN filter, so the docs warn never to port-forward them. Channels stay viewable by anyone on the network.

## D. Kiosk app (Android)

A small app for Fire OS and Google TV in `android/`: a fullscreen WebView showing the player, with no browser controls.

- Finds the server with mDNS, with manual entry as a fallback, and remembers it.
- Keeps the screen on, allows video to autoplay with sound, and allows plain HTTP to the LAN.
- Retries with a friendly screen while the server is unreachable, and starts on boot where the device allows it.
- The Back button doesn't exit by accident.
- Pure logic has unit tests. Auto-start can only be proven on real devices.

## Merge order

A, then C, then B, then D, onto the `v2` branch. Then a full review, every automated check, a scripted browser pass, and installers. The result goes up as a pull request.
