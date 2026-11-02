# Network Signage kiosk app (Android)

A small app for Fire OS and Google TV: a fullscreen WebView showing the player at `http://<host>:<port>/tv`, with no browser controls. It's Java with no libraries, and the only dependency is JUnit for tests.

**Status: compiled and unit tested, but it has never run on a device or emulator.** Everything below about how it behaves on a TV is what the code is written to do, not something that has been observed.

## Building

You need JDK 17 and the Android SDK with `platforms;android-34` and `build-tools;34.0.0`. Gradle comes from the wrapper.

```sh
cd android
JAVA_HOME=/path/to/jdk-17 ANDROID_HOME=/path/to/android-sdk ./gradlew test assembleDebug lint
```

The APK is at `app/build/outputs/apk/debug/app-debug.apk`. Never commit `local.properties`, keystores, or build output. They're in `android/.gitignore`.

## Installing for testing

On a Fire TV, turn on **ADB debugging** under **Settings > My Fire TV > Developer Options**. Then, from a computer on the same network:

```sh
adb connect <tv-address>:5555
adb install app-debug.apk
```

Debug and release builds are signed differently, so moving from one to the other means uninstalling first. That also clears the TV's pairing, so it will have to be paired again.

## How it behaves

- **Choosing a server:** the first run searches for `_network-signage._tcp` with NsdManager and lists what it finds. Addresses can also be typed, and `192.168.1.20` means port 8080. The choice is remembered.
- **Hold Back or Menu for about 1.5 seconds** to open a menu with **Keep showing**, **Change server**, and **Exit app**. It closes itself after 30 seconds. Pressing the key three times quickly does the same, for any remote that doesn't report a held key. One press of Back only shows a hint. Home always leaves the app, as it does for any other app.
- **Server unreachable:** a load that fails or takes over 20 seconds shows "Trying to reach your signage server" with the address, and retries after 2, 4, 8, 16, then every 30 seconds. Once the player page is up, the player handles outages itself and keeps playing, so this screen doesn't appear.
- **Address changes:** the app remembers the server's ID from its mDNS record, and its service name for servers too old to have an ID. It searches while retrying, and every 3 minutes for 20 seconds while playing, because nothing fails on a playing TV when the host's address changes. If that server has a new address, the app tries the address first. It saves and uses it only if it answers, and, while playing, only if the old address has stopped answering, so a host on both Ethernet and Wi-Fi doesn't reload the player. The TV's pairing moves with it, by copying the player's device cookie to the new address. An address that was typed only follows like this if a service was seen at that address when it was entered. The app never moves to a different server, even one with the same name, because a TV showing the wrong signs is worse than one saying it's retrying. mDNS isn't authenticated, so this trusts the LAN, as plain HTTP already does.
- **Renderer crash:** the WebView is rebuilt and the player reloaded, backing off if crashes repeat. This needs API 26 or newer. On Fire OS 6, a renderer crash takes the app down with it.
- **Navigation:** the main frame can only be on the server's origin. Iframes can go anywhere, because web page slides need that.
- **Offline starts:** the player's service worker can't run over plain HTTP, so the page itself isn't cached. If the app starts while the server is down, it shows the retry screen, even if the media is cached. A page that's already running keeps playing.

The app makes no connections of its own beyond the server, and the WebView's Safe Browsing and metrics are turned off. Web slides connect to wherever they're hosted.

## Starting on boot

`BootReceiver` tries to open the app when `BOOT_COMPLETED` arrives, once a server has been chosen. Android doesn't deliver that broadcast until the app has been opened by hand once. **None of this has been tried on a device.**

| Device | Expected |
| --- | --- |
| Android 9 and older, including Fire OS 7 | Should open the app |
| Android 10 and newer, including Fire OS 8 and Google TV | Blocked by the background activity limits, unless the permission below is granted |
| Fire OS generally | Amazon can change this behavior, so only testing on the device will tell |

When it's blocked, nothing visible happens: the TV stays on its home screen until someone opens the app.

### The "display over other apps" permission

`SYSTEM_ALERT_WINDOW` is the documented exemption from those limits on Android 10 and newer. The manifest declares it so that a person can grant it, but installing the app does not grant it, and the app never requests it by itself. The app works without it, except for this one thing.

To grant it, use **Allow starting after power-on** on the server screen. That button only appears on Android 10 and newer when the permission hasn't been granted. It opens the system's settings screen. Some TV devices leave that screen out, and then the app says so, and adb still works:

```sh
adb shell appops set org.networksignage.kiosk SYSTEM_ALERT_WINDOW allow
```

If you'd rather not ship this permission, remove the `uses-permission` line and the button. Everything else keeps working, and boot starts stay blocked on Android 10 and newer.

## Release builds and stores

There's no signing config and no keystore in this repo. A release build needs the owner's own key.

1. Create a keystore with `keytool -genkeypair`, keep it out of the repo, and back it up. Updates must be signed with the same key.
2. Run `./gradlew assembleRelease`, which makes an unsigned APK, and sign it with `apksigner` from the build-tools. Or add a `signingConfig` that reads its passwords from outside the repo.
3. Raise `versionCode` for every release.

For a store:

- **Amazon Appstore:** accepts an APK. It needs store listing assets and Amazon's review of the app on Fire TV.
- **Google Play for TV:** needs an app bundle (`./gradlew bundleRelease`), TV screenshots and a banner, a privacy policy, and Google's TV review. Check Play's current target SDK requirement first.
- **Both:** a reviewer may ask why `SYSTEM_ALERT_WINDOW` and cleartext traffic are needed.

### Raising targetSdk

`targetSdk` stays at 34 on purpose. Before raising it, check these against the current Android docs:

- **API 35:** edge-to-edge becomes mandatory. That should be harmless in a fullscreen app.
- **API 36:** predictive back is on by default, so the Back key stops reaching `dispatchKeyEvent` and press-and-hold breaks. It needs `android:enableOnBackInvokedCallback="false"` or a different exit gesture.
- **Newer versions:** Android is adding a runtime permission for local network access, which this app would need to request.

## What needs testing on a real device

- It appears on the Fire TV and Google TV home screens, with its banner.
- Discovery finds a real server, and the list and every button work with the remote.
- The soft keyboard works in the address box on Fire OS.
- Holding Back and Menu is reported the way the code expects on each remote.
- A video with sound plays with sound.
- The player's "Press OK for fullscreen" hint stays hidden. It should, because the page already fills the screen.
- Web page slides load, including ones on HTTPS.
- Pulling the network, stopping the server, and changing its address all recover.
- A host address change while a TV is playing: the TV should follow within about 3 minutes, on its channel, without asking to be paired again.
- Boot behavior on each OS version, with and without the permission.
- An overnight run: memory, renderer restarts, and the Fire TV screen saver.
