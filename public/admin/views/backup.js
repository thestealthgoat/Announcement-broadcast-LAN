// Backup and restore screens, for both Settings and the first-run page.
import { h, api, field, guard, toast } from '../lib.js';
import { send } from '../upload.js';

const CONFIRM_WORD = 'REPLACE';
const POLL_MS = 1500;
const SLOW_AFTER_MS = 3 * 60 * 1000;
export const RESTORED_FLAG = 'signage.restored';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function status() {
  try {
    const res = await fetch('/api/backup/status', { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

function rememberRestored() {
  try {
    sessionStorage.setItem(RESTORED_FLAG, '1');
  } catch {}
}

// The server drops offline during a restart, so this keeps trying until a new copy of the server
// answers, then reloads. `id` is null if the browser lost track of which restore this was.
async function waitForRestart({ id, bootId, manual, say, fail }) {
  say(manual
    ? 'The backup is checked and ready. Start Network Signage again on the signage computer to finish. This page will carry on by itself.'
    : 'The backup is checked and ready. Network Signage is restarting to finish. This usually takes under a minute, and this page will carry on by itself.');
  const started = Date.now();
  let warned = false;
  for (;;) {
    await sleep(POLL_MS);
    const s = await status();
    if (s && s.bootId !== bootId && !s.restarting) {
      const result = s.lastRestore;
      if (id && result?.id === id && !result.ok) {
        fail(result.message);
        return;
      }
      if (result?.ok && (!id || result.id === id)) rememberRestored();
      location.reload();
      return;
    }
    if (!warned && !manual && Date.now() - started > SLOW_AFTER_MS) {
      warned = true;
      say('This is taking longer than usual. If Network Signage is not running on the signage computer, start it again. This page will carry on by itself.');
    }
  }
}

// Sends the file with a progress bar, then follows the restart. Returns once it has failed, as a
// page that succeeds gets reloaded.
async function runRestore(url, file, { bar, say, fail }) {
  const before = await status();
  say('Uploading the backup. Keep this page open.');
  let result;
  try {
    result = await send(url, file, file.name, (p) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      if (p >= 1) say('Checking the backup. Nothing has changed yet.');
    });
  } catch (err) {
    // Losing the connection right as the server restarts looks the same as a failed upload.
    const now = await status();
    if (before && (!now || now.restarting)) {
      await waitForRestart({ id: null, bootId: before.bootId, manual: false, say, fail });
      return;
    }
    fail(err.message);
    return;
  }
  bar.style.width = '100%';
  await waitForRestart({ id: result.id, bootId: result.bootId, manual: result.restart === 'manual', say, fail });
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

export function backupCard() {
  const backUp = h('button', {
    class: 'primary',
    onclick: () => guard(async () => {
      backUp.disabled = true;
      try {
        // Asks first, as a browser download can only say that it failed, not why.
        const summary = await api.get('/api/backup/summary');
        if (summary.blocked) {
          toast(summary.blocked, true);
          return;
        }
        const link = h('a', { href: '/api/backup/export', download: '', hidden: true });
        document.body.append(link);
        link.click();
        link.remove();
        toast(`Your backup is downloading, about ${formatBytes(summary.totalSize)}.`);
      } finally {
        backUp.disabled = false;
      }
    }),
  }, 'Back Up');

  const file = h('input', { type: 'file', accept: '.signagebackup,.tar', onchange: () => sync() });
  const confirm = h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', oninput: () => sync() });
  const restore = h('button', { type: 'submit', class: 'danger', disabled: true }, 'Restore and replace everything');
  const bar = h('div', {});
  const progress = h('div', { class: 'bar', hidden: true }, bar);
  const message = h('p', { class: 'small', role: 'status', hidden: true });
  const error = h('p', { class: 'err', role: 'alert', hidden: true });
  const sync = () => {
    restore.disabled = !file.files[0] || confirm.value.trim().toUpperCase() !== CONFIRM_WORD;
  };

  const form = h('form', {
    onsubmit: (e) => {
      e.preventDefault();
      if (restore.disabled) return;
      restore.disabled = true;
      file.disabled = true;
      confirm.disabled = true;
      error.hidden = true;
      progress.hidden = false;
      bar.style.width = '0%';
      runRestore('/api/backup/restore?confirm=replace-everything', file.files[0], {
        bar,
        say: (text) => {
          message.textContent = text;
          message.hidden = false;
        },
        fail: (text) => {
          error.textContent = text;
          error.hidden = false;
          message.hidden = true;
          progress.hidden = true;
          file.disabled = false;
          confirm.disabled = false;
          sync();
        },
      });
    },
  },
    h('h3', {}, 'Restore from a backup'),
    h('p', { class: 'small warn-text' }, 'This replaces everything on this server with what is in the backup: media, channels, schedules, TVs, and accounts. Everyone is signed out. TVs pick up the restored content once it has restarted.'),
    field('Backup file', file),
    field(`Type ${CONFIRM_WORD} to confirm`, confirm),
    restore,
    progress,
    message,
    error,
  );

  return h('section', { class: 'card', id: 'backup' },
    h('h2', {}, 'Backup and restore'),
    h('p', { class: 'small' }, 'Downloads one file with all your media, channels, schedules, TVs, and accounts. TVs keep playing while it runs.'),
    h('p', { class: 'small warn-text' }, 'The file holds your private media and hashed passwords, so store it somewhere safe.'),
    h('p', { class: 'muted small' }, 'If your browser says the download failed, the library may have changed while it ran. Delete that file and back up again.'),
    backUp,
    h('hr', { style: 'border:0;border-top:1px solid var(--border);margin:16px 0' }),
    form,
  );
}

// The first-run page has no typed confirmation, as there is nothing here yet to replace.
export function firstRunRestore() {
  const file = h('input', { type: 'file', accept: '.signagebackup,.tar', required: true });
  const submit = h('button', { type: 'submit', style: 'width:100%' }, 'Restore');
  const bar = h('div', {});
  const progress = h('div', { class: 'bar', hidden: true }, bar);
  const message = h('p', { class: 'small', role: 'status', hidden: true });
  const error = h('p', { class: 'err', role: 'alert', hidden: true });
  const form = h('form', {
    hidden: true,
    onsubmit: (e) => {
      e.preventDefault();
      if (!file.files[0]) return;
      submit.disabled = true;
      error.hidden = true;
      progress.hidden = false;
      bar.style.width = '0%';
      runRestore('/api/setup/restore', file.files[0], {
        bar,
        say: (text) => {
          message.textContent = text;
          message.hidden = false;
        },
        fail: (text) => {
          error.textContent = text;
          error.hidden = false;
          message.hidden = true;
          progress.hidden = true;
          submit.disabled = false;
        },
      });
    },
  },
    h('p', { class: 'muted small' }, 'Choose a backup from your old computer. Accounts and passwords come across, so everyone signs in as before.'),
    field('Backup file', file),
    submit,
    progress,
    message,
    error,
  );
  const open = h('button', {
    type: 'button',
    style: 'width:100%',
    onclick: () => {
      open.hidden = true;
      form.hidden = false;
      form.scrollIntoView({ block: 'nearest' });
    },
  }, 'Restore from a backup');
  return h('div', { style: 'margin-top:12px' },
    h('p', { class: 'muted small', style: 'margin:0 0 8px' }, 'Moving from another computer?'),
    open,
    form,
  );
}
