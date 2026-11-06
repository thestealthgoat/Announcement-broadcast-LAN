import updaterPackage from 'electron-updater';
import { app, autoUpdater as nativeAutoUpdater, BrowserWindow, Menu, Tray, clipboard, dialog, nativeImage, powerSaveBlocker, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from '../server/index.js';
import { baseUrls } from '../server/lan.js';
import { updateMenuItems } from '../server/ops/updates.js';
import { runRecoveryFlow } from './recovery.js';
import { quitApp, restartApp, stopWithin } from './restart.js';
import { createUpdater } from './updater.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 8080;

// A custom data folder also gets its own single-instance lock.
if (process.env.SIGNAGE_DATA_DIR) app.setPath('userData', process.env.SIGNAGE_DATA_DIR);

let tray = null;
let win = null;
let server = null;
let port = DEFAULT_PORT;
let stopping = false;
let updater = null;

const dataDir = () => process.env.SIGNAGE_DATA_DIR ?? app.getPath('userData');
const adminUrl = () => `${baseUrls(port)[0]}/admin/`;
const tvUrl = () => `${baseUrls(port)[0]}/tv`;

// Optional config.json in the data folder: { "port": 8080 }
function readPort() {
  if (process.env.PORT) return Number(process.env.PORT);
  try {
    const { port: p } = JSON.parse(fs.readFileSync(path.join(dataDir(), 'config.json'), 'utf8'));
    if (Number.isInteger(p) && p > 0 && p < 65536) return p;
  } catch {}
  return DEFAULT_PORT;
}

function showWindow() {
  if (win) {
    win.show();
    win.focus();
    return;
  }
  win = new BrowserWindow({
    width: 420,
    height: 620,
    resizable: false,
    fullscreenable: false,
    title: 'Network Signage',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const url = pathToFileURL(path.join(HERE, 'window.html'));
  url.searchParams.set('base', baseUrls(port)[0]);
  url.searchParams.set('local', `http://localhost:${port}`);
  win.loadURL(url.href);
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith('http://') || target.startsWith('https://')) shell.openExternal(target);
    return { action: 'deny' };
  });
  win.on('closed', () => {
    win = null;
  });
}

async function recoverAdmin() {
  app.focus({ steal: true }); // the app has no Dock icon, so dialogs can open behind other windows
  try {
    await runRecoveryFlow({ server, dialog, clipboard });
  } catch (err) {
    dialog.showErrorBox('Could not reset the password', err.message);
  }
}

function autostartAllowed() {
  return app.isPackaged && !process.env.SIGNAGE_NO_AUTOSTART;
}

function buildMenu() {
  const items = [
    ...updateMenuItems(server.ops.availableUpdate(), (url) => shell.openExternal(url), updater && ((update) => updater.start(update))),
    { label: 'Show address and QR code', click: showWindow },
    { label: 'Open admin', click: () => shell.openExternal(adminUrl()) },
    { label: `Copy TV address (${tvUrl()})`, click: () => clipboard.writeText(tvUrl()) },
    { type: 'separator' },
  ];
  if (autostartAllowed()) {
    items.push({
      label: 'Start when this computer starts',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    });
  }
  items.push({ label: 'Reset admin password…', click: recoverAdmin });
  items.push({ label: 'Open data folder', click: () => shell.openPath(dataDir()) });
  items.push({ type: 'separator' }, { label: 'Quit Network Signage', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(items));
  tray.setToolTip(`Network Signage: ${adminUrl()}`);
}

function createTray() {
  const file = process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png';
  tray = new Tray(nativeImage.createFromPath(path.join(HERE, file)));
  buildMenu();
  if (process.platform !== 'darwin') tray.on('click', showWindow);
  // The computer's address can change, so keep the menu current.
  setInterval(buildMenu, 60000);
}

// Turned on once, on first launch. After that the tray checkbox is the user's choice.
function enableAutostartOnce() {
  if (!autostartAllowed()) return false;
  const marker = path.join(dataDir(), '.autostart-configured');
  if (fs.existsSync(marker)) return false;
  app.setLoginItemSettings({ openAtLogin: true });
  fs.writeFileSync(marker, '');
  return true;
}

async function main() {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  app.on('second-instance', showWindow);
  app.on('window-all-closed', () => {}); // stays running in the tray
  app.on('activate', showWindow);
  await app.whenReady();
  app.dock?.hide();
  fs.mkdirSync(dataDir(), { recursive: true });

  // Only an installed copy has anything to replace.
  if (app.isPackaged) {
    updater = createUpdater({
      autoUpdater: updaterPackage.autoUpdater,
      nativeUpdater: process.platform === 'darwin' ? nativeAutoUpdater : null,
      version: app.getVersion(),
      feedUrl: process.env.SIGNAGE_UPDATE_FEED ?? null,
      log: (message) => console.error(message),
      stop: async () => {
        stopping = true;
        await stopWithin(server, 15000);
      },
      relaunch: () => {
        app.relaunch();
        app.exit(0);
      },
    });
  }

  // The port is read after any restore goes in, since a restore brings its own config.json.
  server = await createServer({
    dataDir: dataDir(),
    port: () => (port = readPort()),
    logger: { level: 'warn' },
    updater,
    ops: { canInstallUpdates: Boolean(updater) },
    restartsItself: true,
    onRestart: () => {
      stopping = true;
      return restartApp({ app, server });
    },
  });
  try {
    await server.start();
  } catch (err) {
    const message = err.code === 'EADDRINUSE'
      ? `Port ${port} is already in use by another program. Close it, or set a different port in config.json in the data folder:\n\n${dataDir()}`
      : err.message;
    dialog.showErrorBox('Network Signage could not start', message);
    app.exit(1);
    return;
  }

  powerSaveBlocker.start('prevent-app-suspension');
  const firstRun = enableAutostartOnce();
  createTray();
  if (firstRun || !app.isPackaged) showWindow();

  app.on('before-quit', (event) => {
    if (stopping) return;
    stopping = true;
    event.preventDefault();
    quitApp({ app, server });
  });
}

main().catch((err) => {
  dialog.showErrorBox('Network Signage could not start', String(err?.stack ?? err));
  app.exit(1);
});
