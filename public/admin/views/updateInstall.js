import { h, api, openDialog } from '../lib.js';

const POLL_MS = 1000;
const GIVE_UP_MS = 5 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A plain fetch, since the server going away here is expected. Null while it's restarting.
async function readStatus() {
  try {
    const res = await fetch('/api/updates/status');
    if (res.status === 401) location.reload();
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export function installUpdateDialog(notice) {
  openDialog(`Install version ${notice.version}`, (close) => {
    const status = h('p', { role: 'status' }, 'The app restarts on the host computer. TVs reload on their own afterward, and live feeds stop until it is back, usually under a minute. Avoid installing during a game.');
    const release = h('a', { href: notice.link.href, target: '_blank', rel: 'noopener noreferrer', hidden: true }, 'Open the release page');
    const cancel = h('button', { type: 'button', onclick: close }, 'Not now');
    const install = h('button', { type: 'button', class: 'primary', onclick: () => run() }, 'Install now');

    async function run() {
      install.disabled = true;
      cancel.disabled = true;
      status.textContent = 'Starting the download…';
      try {
        await api.post('/api/updates/install');
      } catch (err) {
        failed(err.message);
        return;
      }
      const started = Date.now();
      while (Date.now() - started < GIVE_UP_MS) {
        await sleep(POLL_MS);
        const now = await readStatus();
        if (now?.current === notice.version) {
          status.textContent = 'Update installed. Reloading…';
          location.reload();
          return;
        }
        if (now?.phase === 'error') {
          failed(now.error);
          return;
        }
        status.textContent = now?.phase === 'downloading' ? `Downloading… ${now.percent}%` : 'Installing and restarting…';
      }
      failed('This is taking longer than it should. Check the host computer, or install by hand from the release page.');
    }

    function failed(message) {
      status.textContent = message;
      release.hidden = false;
      cancel.disabled = false;
      cancel.textContent = 'Close';
      install.hidden = true;
    }

    return h('div', {}, status, release, h('div', { class: 'dialog-foot' }, cancel, install));
  });
}
