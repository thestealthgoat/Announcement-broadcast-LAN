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

## Not yet tested

| Area | Status |
| --- | --- |
| Overnight run on Fire TV Stick | In progress |
| Network drop on Fire TV Stick | Not tested |
| Video with sound on Fire TV Stick | Not tested |
| Fully Kiosk Browser, and auto-start after a power cut | Not tested |
| Android kiosk app: not tested on a device | Compiled and unit tested only. It has never run on a device or emulator, so discovery, playback, remote control, recovery, and starting on boot are all unproven |
| Windows installer | Not tested yet |
| Intel Mac installer | Built and inspected, not run |
| `.pkg` install to Applications from a browser download | Not tested |
| Uploading from a real phone | Not tested |
| Samsung and LG built-in browsers | Not tested |

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
