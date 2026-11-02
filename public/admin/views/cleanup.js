import { h, api, guard, thumb, ago, TYPE_LABEL } from '../lib.js';
import { deleteFlow, formatSize } from './libraryActions.js';

const PAGE = 100;

export async function cleanupView(main) {
  let items = [];
  let shown = PAGE;
  const picked = new Set();
  const listEl = h('div', { class: 'list' });
  const totalEl = h('p', { class: 'muted' });
  const pickedEl = h('div', { class: 'grow small', role: 'status' });
  const deleteBtn = h('button', { class: 'danger', onclick: () => deleteFlow([...picked], { keepUsed: true, onDone: refresh }) }, 'Delete');
  const allBtn = h('button', {
    onclick: () => {
      if (picked.size === items.length) picked.clear();
      else items.forEach((m) => picked.add(m.id));
      render();
    },
  });
  const bar = h('div', { class: 'sel-bar', hidden: true }, pickedEl, allBtn, deleteBtn);

  function row(m) {
    return h('label', { class: 'tile lib-row' },
      h('input', {
        type: 'checkbox',
        checked: picked.has(m.id),
        'aria-label': `Select ${m.name}`,
        onchange: (e) => {
          if (e.target.checked) picked.add(m.id);
          else picked.delete(m.id);
          renderBar();
        },
      }),
      thumb(m),
      h('div', { class: 'grow' },
        h('div', { class: 'title' }, m.name),
        h('div', { class: 'muted small' }, `${TYPE_LABEL[m.type]}, added ${ago(m.createdAt)}, frees ${formatSize(m.bytes)}`),
        m.status === 'failed' && h('div', { class: 'err small' }, m.error ?? 'Failed'),
      ),
    );
  }

  function renderBar() {
    const bytes = items.filter((m) => picked.has(m.id)).reduce((sum, m) => sum + m.bytes, 0);
    pickedEl.textContent = picked.size ? `${picked.size} selected, ${formatSize(bytes)}` : 'None selected';
    deleteBtn.disabled = !picked.size;
    allBtn.textContent = picked.size === items.length ? 'Select none' : 'Select all';
  }

  function render() {
    const totalBytes = items.reduce((sum, m) => sum + m.bytes, 0);
    totalEl.textContent = items.length
      ? `${items.length} ${items.length === 1 ? 'item isn\'t' : 'items aren\'t'} on any channel or active override. Deleting ${items.length === 1 ? 'it' : 'them all'} would free ${formatSize(totalBytes)}.`
      : 'Nothing to clean up. Every item you can delete is in use.';
    bar.hidden = !items.length;
    listEl.replaceChildren(
      ...items.slice(0, shown).map(row),
      ...(items.length > shown ? [h('button', { onclick: () => { shown += PAGE; render(); } }, `Show more (${items.length - shown} left)`)] : []),
    );
    renderBar();
  }

  async function refresh() {
    const data = await api.get('/api/library/cleanup');
    items = data.items;
    const ids = new Set(items.map((m) => m.id));
    for (const id of picked) if (!ids.has(id)) picked.delete(id);
    render();
  }

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('div', {}, h('a', { href: '#/library', class: 'small' }, '‹ Library'), h('h1', {}, 'Clean up'))),
    totalEl,
    h('p', { class: 'muted small' }, 'Oldest first. Live feeds and anything still processing are never listed. Nothing is deleted until you confirm.'),
    listEl,
    bar,
  );
  await refresh();
  return {
    refresh: (s) => {
      if ((s.includes('media') || s.includes('channels') || s.includes('overrides')) && !document.querySelector('dialog[open]')) guard(refresh);
    },
  };
}
