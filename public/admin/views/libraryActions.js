// Shared by the library and cleanup pages: the delete warning and reporting what bulk actions did.
import { h, api, guard, toast, openDialog } from '../lib.js';

const SHOW_NAMES = 30;

export function formatSize(bytes) {
  if (!bytes) return 'no space';
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// "Gym, Lobby, and an override on all channels"
export function usageText(usage) {
  const parts = usage.channels.map((c) => c.name);
  for (const o of usage.overrides) {
    const where = o.allChannels ? 'all channels' : o.channels.map((c) => c.name).join(', ');
    parts.push(`an active override on ${where}`);
  }
  if (parts.length < 2) return parts.join('');
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

function nameList(rows, line) {
  return h('ul', { class: 'lib-names' },
    rows.slice(0, SHOW_NAMES).map((r) => h('li', {}, line(r))),
    rows.length > SHOW_NAMES && h('li', { class: 'muted' }, `and ${rows.length - SHOW_NAMES} more`),
  );
}

const skippedLine = (r) => `${r.name ?? 'An item'}: ${r.message}`;

// Everything that went through is a toast. Anything skipped stays on screen until it's been read.
export function showResult(result) {
  if (!result.skipped) {
    toast(`${result.summary[0].toUpperCase()}${result.summary.slice(1)}.`);
    return;
  }
  openDialog(`${result.summary[0].toUpperCase()}${result.summary.slice(1)}`, (close) => [
    h('p', { class: 'small', style: 'font-weight:600' }, 'Skipped'),
    nameList(result.results.filter((r) => !r.ok), skippedLine),
    h('div', { class: 'dialog-foot' }, h('button', { class: 'primary', onclick: close }, 'OK')),
  ]);
}

// Asks the server what deleting these would do, names any channels using them, then asks for a yes.
// With keepUsed, as in the cleanup view, anything that has come into use is kept rather than offered.
export async function deleteFlow(ids, { keepUsed = false, onDone } = {}) {
  const plan = await guard(() => api.post('/api/library/bulk/delete', { ids, dryRun: true }));
  if (!plan) return;
  const allowed = plan.results.filter((r) => r.ok);
  const used = allowed.filter((r) => r.usage.inUse);
  const going = keepUsed ? allowed.filter((r) => !r.usage.inUse) : allowed;
  const unused = going.filter((r) => !r.usage.inUse);
  const bytes = going.reduce((sum, r) => sum + r.bytes, 0);
  const skipped = plan.results.filter((r) => !r.ok);
  const count = plural(going.length, 'item');

  openDialog(going.length ? `Delete ${count}?` : 'Nothing can be deleted', (close) => [
    going.length > 0 && h('p', {}, `This frees ${formatSize(bytes)} and can't be undone.`),
    !keepUsed && used.length > 0 && [
      h('p', { class: 'warn-text' }, `${plural(used.length, 'item')} in use will come off TVs right away:`),
      nameList(used, (r) => `${r.name}: ${usageText(r.usage)}`),
    ],
    unused.length > 0 && [
      h('p', { class: 'small', style: 'font-weight:600' }, used.length && !keepUsed ? 'Not in use' : 'Items'),
      nameList(unused, (r) => `${r.name}, takes ${formatSize(r.bytes)}`),
    ],
    keepUsed && used.length > 0 && [
      h('p', { class: 'warn-text' }, `Keeping ${plural(used.length, 'item')} that came into use since this list loaded:`),
      nameList(used, (r) => `${r.name}: ${usageText(r.usage)}`),
    ],
    skipped.length > 0 && [
      h('p', { class: 'small', style: 'font-weight:600' }, `${skipped.length} can't be deleted`),
      nameList(skipped, skippedLine),
    ],
    h('div', { class: 'dialog-foot' },
      h('button', { type: 'button', onclick: close }, going.length ? 'Cancel' : 'Close'),
      going.length > 0 && h('button', {
        type: 'button',
        class: 'danger',
        onclick: () => guard(async () => {
          const result = await api.post('/api/library/bulk/delete', {
            ids: going.map((r) => r.id),
            inUseConfirmed: going.filter((r) => r.usage.inUse).map((r) => r.id),
          });
          close();
          showResult(result);
          onDone?.(result);
        }),
      }, `Delete ${count}`),
    ),
  ]);
}
