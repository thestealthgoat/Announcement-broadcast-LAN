// Restarts the tray app after a restore. Electron is passed in so this can be tested without a
// display. Live feeds and conversions stop as part of server.stop(), and a stop that hangs mustn't
// strand the restore, since the marker on disk already has everything the next boot needs.
export async function restartApp({ app, server, timeoutMs = 15000 }) {
  await stopWithin(server, timeoutMs);
  app.relaunch();
  app.exit(0);
}

// Quitting from the tray. An app that won't quit gets its installer run over it, so this has a limit
// of its own past the server's, in case anything else in stopping ever hangs.
export async function quitApp({ app, server, timeoutMs = 10000 }) {
  await stopWithin(server, timeoutMs);
  app.exit(0);
}

async function stopWithin(server, ms) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms);
  });
  await Promise.race([server.stop().catch(() => {}), timeout]);
  clearTimeout(timer);
}
