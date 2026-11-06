import { updateFeedUrl } from '../server/ops/updates.js';

const FAILED = "The update couldn't be installed, and your current version is still running. You can install it by hand from the release page.";

// Downloads and installs a release when someone asks. It never starts by itself, because installing
// restarts the server and stops live feeds, and nobody should lose a feed in the middle of a game.
// The version comes from the release check, so the address is a release that check already trusted.
//
// On a Mac the library reports "downloaded" before macOS's updater has its copy, so `nativeUpdater`
// is what says it's really ready. The server stays up until then.
export function createUpdater({ autoUpdater, nativeUpdater = null, version, stop, relaunch, feedUrl = null, log = () => {}, quitTimeoutMs = 60000 }) {
  const state = { phase: 'idle', version: null, percent: 0, error: null };

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = Boolean(nativeUpdater); // what makes the library hand the Mac updater its copy
  autoUpdater.disableDifferentialDownload = true;

  function fail(err) {
    log(`Update failed: ${err?.stack ?? err}`);
    // The server is already stopped by this point, so bringing the app back is the only way out.
    if (state.phase === 'installing') {
      relaunch();
      return;
    }
    state.phase = 'error';
    state.error = FAILED;
  }

  autoUpdater.on('error', fail);
  autoUpdater.on('download-progress', (p) => {
    state.percent = Math.round(p.percent);
  });
  async function install() {
    if (state.phase !== 'downloading') return;
    state.phase = 'installing';
    state.percent = 100;
    try {
      log('Update ready, stopping the server');
      await stop();
      // A stopped server that never quits would leave every TV without a host until someone came by.
      setTimeout(() => fail(new Error('The app did not quit to install the update')), quitTimeoutMs).unref?.();
      log('Quitting to install');
      autoUpdater.quitAndInstall(true, true);
    } catch (err) {
      fail(err);
    }
  }
  (nativeUpdater ?? autoUpdater).on('update-downloaded', install);

  return {
    status: () => ({ current: version, ...state }),
    start(update) {
      if (state.phase === 'downloading' || state.phase === 'installing') return this.status();
      Object.assign(state, { phase: 'downloading', version: update.version, percent: 0, error: null });
      (async () => {
        autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl ?? updateFeedUrl(update) });
        const found = await autoUpdater.checkForUpdates();
        if (!found?.isUpdateAvailable) throw new Error(`No update found for ${update.version}`);
        await autoUpdater.downloadUpdate();
      })().catch(fail);
      return this.status();
    },
  };
}
