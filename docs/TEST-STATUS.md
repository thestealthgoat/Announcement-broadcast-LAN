# Test status

What has been tested on real setups, and what hasn't. Last updated November 2, 2026, for version 1.0.2.

## Passed

| Area | Tested on | Result |
| --- | --- | --- |
| Playback in a browser | Computer connected to a TV by HDMI | Works |
| Pairing, full playlist rotation | Fire TV Stick 4K Max (2nd gen), Fire OS, Silk Browser | Works |
| Pushing and clearing an override | Same Fire TV Stick | Works |
| Branding | Admin and TV | Works |
| Installing the `.pkg` and converting a video | Apple Silicon Mac, installed to the user folder | Works |
| Playback while the server is stopped, then reconnecting | Desktop browser over a LAN address | Keeps playing, reconnects with no reload |
| HLS video | Desktop browser, native and through hls.js | Plays |
| Server: accounts, permissions, conversion, pairing, overrides | Automated tests | Pass |
| Clearing an ffmpeg left behind by a force kill | Automated test on a Mac, with real ffmpeg and the real command-line server | Cleared at the next start, and the port works again |
| Stopping with a stalled client | Automated tests on a Mac: a stalled video read, half-sent POST and upload, and a silent websocket | Stops after a 3-second grace period, and a second Ctrl-C exits at once |

## Not yet tested

| Area | Status |
| --- | --- |
| Overnight run on Fire TV Stick | In progress |
| Schedules on a real TV | Not tested |
| Network drop on Fire TV Stick | Not tested |
| Video with sound on Fire TV Stick | Not tested |
| Fully Kiosk Browser, and auto-start after a power cut | Not tested |
| Android kiosk app: not tested on a device | Compiled and unit tested only. It has never run on a device or emulator, so discovery, playback, remote control, recovery, starting on boot, and following a server whose address changes are all unproven |
| Publishing on a real network | Only tested on loopback between two copies of the mDNS library: real multicast, a second real host using the same name, waking from sleep, and Android's NsdManager reading the server's ID are not tested |
| Live feeds through hls.js with native fallback, on a TV or Android WebView | Only tested against a stand-in for the browser and hls.js |
| Clearing a leftover ffmpeg on Windows | Not tested: the Windows command-line lookup has only been checked against a stand-in |
| Backup and restore | Automated tests only, on one computer. A real move between two computers, and the tray app's restart after a restore, have not been tried |
| Windows installer | Not tested yet |
| Windows file locks | Not tested on Windows: leaving a folder behind after a delete, the next start's sweep, and a backup's cleanup were only tested on a Mac, using folders that can't be changed in place of a real lock |
| `.pkg` upgrade over a running or hung app | Not tested with a real install: the preinstall script was only run as a copy, against stand-ins for `pkill` and `pgrep` and a test process, never the real tools or app |
| Tray Quit's time limit | Tested with a stand-in for Electron, not by quitting the real tray app |
| Intel Mac installer | Built and inspected, not run |
| `.pkg` install to Applications from a browser download | Not tested |
| Uploading from a real phone | Not tested |
| Samsung and LG built-in browsers | Not tested |
| Live feed from a capture card or camera | Not tested |
| Live feed with NVENC or Quick Sync hardware encoding | Not tested |
| Live feed over SRT | Not tested: the bundled Mac ffmpeg has no SRT, so it is hidden there |
| Live feed on Windows | Not tested |
| Live feed from real OBS or vMix, or on a TV | Not tested |

## TV compatibility

| TV or device | Status |
| --- | --- |
| Fire TV Stick on Fire OS | Works in Silk. See the table above for what's left |
| Fire TV devices on Vega OS (such as the 4K Select) | Not recommended: they block the normal way of installing kiosk browsers |
| Computer connected by HDMI | Works |
| Roku TV or Roku player | No full web browser, so plug a supported device into HDMI |
| Apple TV | No web browser, so use a supported device instead |
| Google TV devices | Not tested |
| Raspberry Pi | Not tested |
