// Restarts the tray app after a restore. Electron is passed in so this can be tested without a
// display. Live feeds and conversions stop as part of server.stop(), and a stop that hangs mustn't
// strand the restore, since the marker on disk already has everything the next boot needs.
export async function restartApp({ app, server, timeoutMs = 15000 }) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([server.stop().catch(() => {}), timeout]);
  clearTimeout(timer);
  app.relaunch();
  app.exit(0);
}
