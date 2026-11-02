# TV setup

Each TV needs a browser pointed at the signage computer. Find the addresses in the tray menu, under **Show address and QR code**.

There are two ways to connect a TV:

- **Pairing (easiest):** open `http://<host>:<port>/tv`. The TV shows a 4-digit code. In the admin, go to **Screens**, enter the code, and choose a channel. You can change the channel later from the admin.
- **Direct:** open `http://<host>:<port>/play/<channel>`. The channel page in the admin shows this address.

Bookmark the address on the TV. Pairing is remembered in that browser.

## Which device do I need?

**Roku TVs and Apple TV have no real web browser**, so they can't run the player directly. Plug a Fire TV Stick or a computer into the TV's HDMI port and select that input. On a Roku TV, you may be able to make it open on that input at power-on, under **Settings > System > Power > Power On**.

**When buying a Fire TV Stick, check that it runs Fire OS.** The 4K Max is tested and has the most storage. Avoid the 4K Select and other Vega OS models, because they block the normal way of installing kiosk browsers like Fully Kiosk.

See [test status](TEST-STATUS.md) for what has been tested so far.

## Fire TV Stick (recommended): Fully Kiosk Browser

Fully Kiosk is the best fit. It starts on boot, keeps the screen on, reloads after errors, and can allow video sound. It is a third-party app, and some features need a paid license from its developer.

1. On the Fire TV, install **Downloader** from the Appstore, and allow it to install apps under **Settings > My Fire TV > Developer Options**.
2. Use Downloader to install Fully Kiosk Browser from `https://www.fully-kiosk.com`.
3. In Fully Kiosk settings, set:
   - **Start URL:** your TV address
   - **Web Content Settings > Autoplay Videos:** on
   - **Device Management > Keep Screen On:** on
   - **Device Management > Start on Boot:** on (Fire OS may also need this app set as the launcher)
   - **Advanced Web Settings > Reload on Internet Reconnect / Reload on Error:** on
4. Exact setting names can change between Fully Kiosk versions.

### Fire TV with Silk Browser (no install)

Silk works for quick use, but it does not start on boot, and the Fire TV may sleep during still images. Open the address and press **Select** on the remote to go fullscreen.

## Samsung and LG built-in browsers (best effort)

1. Open the TV's Internet or Web Browser app and go to your TV address.
2. Press **OK** on the remote for fullscreen, if the browser offers it.
3. Turn off the TV's screen saver, auto power off, and eco timers in its settings.

Built-in browsers vary a lot by model year. They may not support some video features, and they usually block sound. If one struggles, a Fire TV Stick is inexpensive and much more predictable.

## Sound

Audio is off by default for every item, because most screens are in public areas. To use it, turn on **Play sound** on an item in its channel.

TV browsers block autoplay with sound unless the browser is configured to allow it. If blocked, the video plays muted. Fully Kiosk's autoplay setting allows it on Fire TV.

## Troubleshooting

| Problem | Try |
| --- | --- |
| TV cannot load the page | Check that it is on the same network, then allow the app through the host's firewall. Guest Wi-Fi often isolates devices. |
| The address stopped working | The host's IP changed. Reserve its address on your router. |
| Dashboard shows the TV offline | The TV may be asleep, or its browser closed. It reconnects on its own once running. |
| A web page is blank | That site blocks being shown inside another page. Use a screenshot or PDF instead. |
| Video has no sound | See **Sound** above, and check **Play sound** on the item. |
| Fire TV goes to its screen saver | Use Fully Kiosk with Keep Screen On, or set the screen saver to **Never** under **Settings > Display & Sounds**. |
