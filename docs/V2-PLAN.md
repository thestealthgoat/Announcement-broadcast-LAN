# V2 build plan

Goal: signs that show the right thing at the right time, run unattended, and can carry a live feed.

Apple signing and notarization come after V2. Live data slides, PowerPoint import, a freeform slide editor, Roku and Apple TV apps, and per-channel passwords are out of scope.

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

## Second wave

These start after sections A to D are merged, because they change the same screens. Migrations continue from `005`.

### E. Announcement designer

A guided designer, not a freeform canvas. Text announcements and quick overrides share one slide format, so both get it.

- **Templates:** built-in looks such as Emergency, Weather, Schedule change, Game day, and General, plus templates admins save themselves.
- **Controls:** background color, gradient, or library image with a dimming control, text color, font size, alignment, accent, logo position, and an optional countdown to a set time.
- **Preview:** a live preview that matches the TV, because both use the same rendering code.
- **Safety:** text auto-fits so that it can't overflow, and low-contrast color choices get a warning.
- **Override flow:** the Override page offers templates first, so an urgent message still takes seconds.
- **Not building:** free placement of elements, layers, shapes, and drawing tools. Staff who need that can make it in Canva and upload it.

### F. Transitions

- **More types:** add wipe, zoom, and push in four directions alongside cut, fade, and slide.
- **Controls:** speed per item, plus a default transition per channel that new items inherit.
- **Limits:** stay CSS-only and ES5 for older TVs, and fall back to fade where a browser can't do the effect.
- **Preview:** preview a transition in the admin.

### G. Roles and permissions

Custom roles replace the fixed Admin and Editor pair.

- **Permissions:** separate toggles for managing content, editing channels, uploading, deleting library items, pushing overrides, managing screens, live feeds, branding, and users. Access is limited per channel.
- **Built-in roles:** Admin, Editor, and Uploader, the last for coaches who only add content. Admins can create more.
- **Upgrade:** every existing account keeps exactly the access it has today, including the separate override flag. A test proves this on a 1.0.2 database.
- **Safety:** always keep at least one account with full access, and nobody can grant permissions they don't have. Every route is checked on the server, with a test for each permission.

### H. Library organization

- **Organizing:** folders and tags, search, sort, and filters by type, folder, or status.
- **Bulk actions:** select several items to move, tag, add to a channel, or delete.
- **Usage:** show which channels use each item, and warn before deleting one in use.
- **Cleanup:** a cleanup view of items no channel uses, oldest first, showing the space each would free. Nothing is deleted without confirmation.
- **Duplicates:** warn when an upload matches a file already in the library.

### I. Backup and restore

For moving to a new host computer or recovering from a failed one. Admin only, in Settings.

- **Export:** a Back Up button downloads a single file with a consistent database snapshot, all media, branding files, and a manifest with the app version. It streams, so a large library doesn't fill memory, and it works while TVs keep playing. Live segments and caches are left out.
- **Import, new computer:** the first-run screen offers Restore from a backup as well as starting fresh. This path only exists while no accounts exist.
- **Import, existing install:** in Settings, with a clear warning that it replaces everything. A safety copy of the current data is kept until the restored data opens successfully.
- **Safety:** check the manifest and file contents before changing anything, reject unsafe file paths inside the archive, refuse backups from a newer version, and run migrations on older ones. A failed restore leaves existing data untouched.
- **After restoring:** the app restarts itself. Accounts and passwords come across, so everyone signs in as before. Paired TVs remember their server by address, so if the new host's address differs, show how to fix it: reserve the old address for the new computer, or re-pair each TV.
- **Sensitive file:** the backup contains password hashes and all media, so the page says to store it somewhere safe.
- **Tests:** a full round trip into a new data folder with media and pairing intact, restoring a backup from an older schema, and rejecting corrupted, truncated, and path-traversal archives, all with existing data unchanged.

## Merge order

First wave: A, then C, then B, then D, onto the `v2` branch. Second wave: G first because it changes permission checks everywhere, then E, F, H, and I in parallel. After each wave comes a full review, every automated check, a scripted browser pass, and installers. The result goes up as a pull request.
