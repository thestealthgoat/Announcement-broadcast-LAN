import { h, api, guard, field, toast, openDialog, thumb, TYPE_LABEL } from '../lib.js';
import { deleteFlow, showResult, usageText } from './libraryActions.js';

const LIVE_STATUS = { live: 'Live feed: on air', idle: 'Live feed: no signal', error: 'Live feed: has a problem', off: 'Live feed: turned off' };
const PAGE = 60;

export async function libraryView(main, ctx) {
  const grid = h('div', { class: 'grid' });
  const countEl = h('p', { class: 'muted small', role: 'status', style: 'margin:0' });
  const moreBtn = h('button', { style: 'width:100%;margin-top:12px', onclick: () => guard(() => load(items.length, PAGE)) }, 'Show more');
  const canOrganize = ctx.can('library.edit');
  const canTouchItems = canOrganize || ctx.can('library.own');
  const query = { q: '', sort: 'newest', type: '', status: '', folder: '', tag: '' };
  let items = [];
  let total = 0;
  let folders = [];
  let tags = [];
  let listsKey = null;
  let selecting = false;
  let requestSeq = 0;
  const selected = new Set();

  const params = (extra = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...extra })) if (v !== '' && v !== undefined) p.set(k, v);
    return p.toString();
  };

  function render() {
    const filtered = Object.entries(query).some(([k, v]) => k !== 'sort' && v);
    grid.replaceChildren(...(items.length ? items.map(card) : [h('p', { class: 'muted', style: 'grid-column:1/-1' }, filtered ? 'Nothing matches. Try clearing a filter.' : 'The library is empty. Upload something to get started.')]));
    countEl.textContent = `${total} ${total === 1 ? 'item' : 'items'}`;
    moreBtn.hidden = items.length >= total;
    renderBar();
  }

  function usageLine(m) {
    if (!m.usage.inUse) return h('div', { class: 'muted small lib-usage' }, 'Not on a channel');
    return h('div', { class: 'small lib-usage' },
      m.usage.overrides.length > 0 && h('span', { class: 'warn-text' }, 'Override now. '),
      m.usage.channels.length > 0 && `On ${m.usage.channels.map((c) => c.name).join(', ')}`);
  }

  function card(m) {
    const status = m.status === 'processing'
      ? h('div', {}, h('div', { class: 'muted small' }, m.progress != null ? `Converting ${m.progress}%` : 'Processing…'), h('div', { class: 'bar' }, h('div', { style: `width:${m.progress ?? 5}%` })))
      : m.status === 'failed'
        ? h('div', { class: 'err small' }, m.error ?? 'Failed')
        : h('div', { class: 'muted small' }, LIVE_STATUS[m.liveStatus] ?? TYPE_LABEL[m.type]);
    const on = selected.has(m.id);
    return h('button', {
      class: `media-card${on ? ' selected' : ''}`,
      'aria-pressed': selecting ? String(on) : undefined,
      onclick: () => {
        if (!selecting) return editDialog(m);
        if (on) selected.delete(m.id);
        else selected.add(m.id);
        return render();
      },
    },
      selecting && h('span', { class: `sel-mark${on ? ' on' : ''}`, 'aria-hidden': 'true' }, on ? '✓' : ''),
      thumb(m, 'pic'),
      h('div', { class: 'meta' },
        h('div', { class: 'title' }, m.name),
        status,
        usageLine(m),
        m.tags.length > 0 && h('div', { class: 'lib-tags' }, m.tags.map((t) => h('span', { class: 'lib-tag' }, t.name))),
      ),
    );
  }

  // A newer request wins, so a slow answer can't overwrite what someone just searched for.
  async function load(offset, limit) {
    const seq = ++requestSeq;
    const data = await api.get(`/api/library?${params({ limit, offset })}`);
    if (seq !== requestSeq) return;
    items = offset ? [...items, ...data.items] : data.items;
    total = data.total;
    render();
  }

  // Only redraws the filters when a list changed, so a refresh can't close a menu someone has open.
  async function loadLists() {
    [folders, tags] = await Promise.all([api.get('/api/folders'), api.get('/api/tags')]);
    const key = JSON.stringify([folders.map((f) => [f.id, f.name]), tags.map((t) => [t.id, t.name])]);
    if (key !== listsKey) {
      listsKey = key;
      renderFilters();
    }
  }

  // Keeps however much was already showing, without moving someone back to the top.
  async function refresh() {
    await Promise.all([load(0, Math.min(Math.max(items.length, PAGE), 500)), loadLists()]);
  }

  function setQuery(key, value) {
    query[key] = value;
    selected.clear();
    guard(() => load(0, PAGE));
  }

  const howMany = (ids) => (ids.length === 1 ? 'this item' : `${ids.length} items`);

  function moveDialog(ids, done) {
    openDialog(`Move ${howMany(ids)}`, (close) => {
      const select = h('select', {},
        h('option', { value: '' }, 'Top level (no folder)'),
        folders.map((f) => h('option', { value: f.id }, f.name)),
      );
      const fresh = h('input', { type: 'text', maxlength: 80, placeholder: 'Leave empty to use the list above' });
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            const folderId = fresh.value.trim() ? (await api.post('/api/folders', { name: fresh.value })).id : select.value || null;
            const result = await api.post('/api/library/bulk/move', { ids, folderId });
            close();
            showResult(result);
            done();
          });
        },
      },
        field('Folder', select),
        canOrganize && field('Or make a new folder', fresh),
        h('div', { class: 'dialog-foot' },
          h('button', { type: 'button', onclick: close }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Move')),
      );
    });
  }

  function tagDialog(ids, done) {
    openDialog(`Tag ${howMany(ids)}`, (close) => {
      const select = h('select', {}, h('option', { value: '' }, 'Choose a tag'), tags.map((t) => h('option', { value: t.id }, t.name)));
      const fresh = h('input', { type: 'text', maxlength: 80, placeholder: 'Leave empty to use the list above' });
      const apply = (key) => guard(async () => {
        let tagId = Number(select.value);
        if (key === 'add' && fresh.value.trim()) tagId = (await api.post('/api/tags', { name: fresh.value })).id;
        if (!tagId) return toast('Choose a tag first.', true);
        const result = await api.post('/api/library/bulk/tag', { ids, [key]: [tagId] });
        close();
        showResult(result);
        return done();
      });
      return [
        field('Tag', select),
        canOrganize && field('Or make a new tag', fresh),
        !canOrganize && !tags.length && h('p', { class: 'muted small' }, 'No tags yet. Someone who can edit the whole library can add them.'),
        h('div', { class: 'dialog-foot' },
          h('button', { type: 'button', class: 'left', onclick: close }, 'Cancel'),
          h('button', { type: 'button', onclick: () => apply('remove') }, 'Remove tag'),
          h('button', { type: 'button', class: 'primary', onclick: () => apply('add') }, 'Add tag')),
      ];
    });
  }

  function channelDialog(ids, done) {
    openDialog(`Add ${howMany(ids)} to a channel`, (close) => {
      const box = h('div', { class: 'list' }, h('p', { class: 'muted' }, 'Loading…'));
      guard(async () => {
        const usable = (await api.get('/api/channels')).filter((c) => c.canAdd);
        box.replaceChildren(...(usable.length ? usable.map((c) => h('button', {
          type: 'button',
          onclick: () => guard(async () => {
            const result = await api.post('/api/library/bulk/add-to-channel', { ids, channelId: c.id });
            close();
            showResult(result);
            done();
          }),
        }, c.name)) : [h('p', { class: 'muted' }, 'You have no channels you can add to.')]));
      });
      return [box, h('div', { class: 'dialog-foot' }, h('button', { type: 'button', onclick: close }, 'Cancel'))];
    });
  }

  const afterBulk = () => {
    selected.clear();
    guard(refresh);
  };
  const selectedIds = () => [...selected];

  const selCount = h('div', { class: 'grow small', role: 'status', style: 'font-weight:600' });
  const selAll = h('button', {
    onclick: () => guard(async () => {
      const { ids, total: matching } = await api.get(`/api/library?${params({ idsOnly: 1 })}`);
      ids.forEach((id) => selected.add(id));
      render();
      if (matching > ids.length) toast(`Selected the first ${ids.length} of ${matching}.`);
    }),
  }, 'Select all');
  const selBar = h('div', { class: 'sel-bar' },
    selCount,
    selAll,
    canTouchItems && h('button', { onclick: () => moveDialog(selectedIds(), afterBulk) }, 'Move'),
    canTouchItems && h('button', { onclick: () => tagDialog(selectedIds(), afterBulk) }, 'Tag'),
    ctx.can('channels.add') && h('button', { onclick: () => channelDialog(selectedIds(), afterBulk) }, 'Add to channel'),
    (canTouchItems || ctx.can('live.manage')) && h('button', { class: 'danger-text', onclick: () => deleteFlow(selectedIds(), { onDone: afterBulk }) }, 'Delete'),
  );
  const selectBtn = h('button', {
    onclick: () => {
      selecting = !selecting;
      if (!selecting) selected.clear();
      render();
    },
  }, 'Select');

  function renderBar() {
    selBar.hidden = !selecting;
    selCount.textContent = `${selected.size} selected`;
    for (const b of selBar.querySelectorAll('button')) if (b !== selAll) b.disabled = !selected.size;
    selectBtn.textContent = selecting ? 'Done' : 'Select';
  }

  function editDialog(m) {
    const canChange = m.canEdit;
    openDialog(m.name, (close) => {
      const name = h('input', { type: 'text', value: m.name, required: true, disabled: !canChange });
      const title = h('input', { type: 'text', value: m.title ?? '', disabled: !canChange });
      const body = h('textarea', { disabled: !canChange }, m.body ?? '');
      const url = h('input', { type: 'url', value: m.url ?? '', disabled: !canChange });
      const folder = h('select', { disabled: !canChange },
        h('option', { value: '', selected: !m.folderId }, 'Top level (no folder)'),
        folders.map((f) => h('option', { value: f.id, selected: f.id === m.folderId }, f.name)),
      );
      const tagBoxes = tags.map((t) => ({
        tag: t,
        input: h('input', { type: 'checkbox', checked: m.tags.some((x) => x.id === t.id), disabled: !canChange }),
      }));
      const chanBox = h('div', { class: 'list' });
      api.get('/api/channels').then((channels) => {
        const editable = channels.filter((c) => c.canAdd);
        chanBox.replaceChildren(
          h('div', { class: 'small', style: 'font-weight:600' }, 'Add to a channel'),
          h('div', { class: 'actions' }, editable.map((c) => h('button', {
            type: 'button',
            onclick: () => guard(async () => {
              await api.post(`/api/channels/${c.id}/items`, { mediaId: m.id });
              toast(`Added to ${c.name}.`);
            }),
          }, c.name))),
        );
      });
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            const patch = { name: name.value };
            if (m.type === 'text') Object.assign(patch, { title: title.value, body: body.value });
            if ((m.type === 'web' || m.type === 'hls') && !m.live) patch.url = url.value;
            await api.patch(`/api/media/${m.id}`, patch);
            const folderId = folder.value ? Number(folder.value) : null;
            if (folderId !== m.folderId) await api.post('/api/library/bulk/move', { ids: [m.id], folderId });
            const wasOn = (t) => m.tags.some((x) => x.id === t.id);
            const add = tagBoxes.filter((b) => b.input.checked && !wasOn(b.tag)).map((b) => b.tag.id);
            const remove = tagBoxes.filter((b) => !b.input.checked && wasOn(b.tag)).map((b) => b.tag.id);
            if (add.length || remove.length) await api.post('/api/library/bulk/tag', { ids: [m.id], add, remove });
            close();
            refresh();
          });
        },
      },
        m.thumb && h('img', { src: m.thumb, alt: '', style: 'width:100%;border-radius:8px;margin-bottom:12px' }),
        field('Name', name),
        m.type === 'text' && field('Title', title),
        m.type === 'text' && field('Message', body),
        (m.type === 'web' || m.type === 'hls') && !m.live && field('Address', url),
        m.live && h('p', { class: 'muted small' }, 'This is a live feed. It only shows on TVs while it is on air.'),
        h('p', { class: 'small' }, h('strong', {}, "Where it's used: "), m.usage.inUse ? `${usageText(m.usage)}.` : 'Nowhere right now.'),
        field('Folder', folder),
        tagBoxes.length > 0 && h('div', { class: 'small', style: 'margin-bottom:12px' },
          h('div', { style: 'font-weight:600' }, 'Tags'),
          h('div', { class: 'lib-tag-boxes' }, tagBoxes.map((b) => h('label', { class: 'check' }, b.input, h('span', {}, b.tag.name))))),
        m.status === 'ready' && ctx.can('channels.add') && chanBox,
        h('div', { class: 'dialog-foot' },
          m.canDelete && h('button', {
            type: 'button',
            class: 'danger-text left',
            onclick: () => deleteFlow([m.id], {
              onDone: () => {
                close();
                guard(refresh);
              },
            }),
          }, 'Delete'),
          h('button', { type: 'button', onclick: close }, canChange ? 'Cancel' : 'Close'),
          canChange && h('button', { type: 'submit', class: 'primary' }, 'Save'),
        ),
      );
    });
  }

  function organizeDialog() {
    openDialog('Folders and tags', (close) => {
      const box = h('div', {});
      const adder = (route) => {
        const input = h('input', { type: 'text', maxlength: 80, placeholder: 'New name', 'aria-label': 'New name', required: true });
        return h('form', {
          class: 'row',
          style: 'margin:8px 0 16px',
          onsubmit: (e) => {
            e.preventDefault();
            guard(async () => {
              await api.post(route, { name: input.value });
              await draw();
            });
          },
        }, input, h('button', { type: 'submit' }, 'Add'));
      };
      const section = (label, route, rows, afterDelete) => [
        h('h3', { class: 'lib-sub' }, label),
        ...(rows.length ? rows.map((r) => h('div', { class: 'attention-row' },
          h('div', { class: 'grow' }, r.name, h('div', { class: 'muted small' }, `${r.count} ${r.count === 1 ? 'item' : 'items'}`)),
          h('button', {
            type: 'button',
            onclick: () => guard(async () => {
              const next = prompt('New name', r.name);
              if (!next) return;
              await api.patch(`${route}/${r.id}`, { name: next });
              await draw();
            }),
          }, 'Rename'),
          h('button', {
            type: 'button',
            class: 'danger-text',
            onclick: () => guard(async () => {
              if (!confirm(`Delete ${r.name}? ${afterDelete}`)) return;
              await api.del(`${route}/${r.id}`);
              await draw();
            }),
          }, 'Delete'),
        )) : [h('p', { class: 'muted small' }, 'None yet.')]),
        adder(route),
      ];
      async function draw() {
        await loadLists();
        box.replaceChildren(
          ...section('Folders', '/api/folders', folders, 'Its items move to the top level, and none are deleted.'),
          ...section('Tags', '/api/tags', tags, 'It comes off its items, and none are deleted.'),
        );
      }
      guard(draw);
      return [box, h('div', { class: 'dialog-foot' }, h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => {
          close();
          guard(refresh);
        },
      }, 'Done'))];
    });
  }

  function textDialog() {
    openDialog('New text announcement', (close) => {
      const title = h('input', { type: 'text', required: true, maxlength: 200 });
      const body = h('textarea', { maxlength: 2000 });
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            await api.post('/api/media/text', { title: title.value, body: body.value });
            close();
            refresh();
          });
        },
      },
        field('Title', title),
        field('Message (optional)', body),
        h('div', { class: 'dialog-foot' },
          h('button', { type: 'button', onclick: close }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Add')),
      );
    });
  }

  function urlDialog() {
    openDialog('Add a web page', (close) => {
      const url = h('input', { type: 'url', required: true, placeholder: 'https://', autocapitalize: 'none' });
      const name = h('input', { type: 'text' });
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            await api.post('/api/media/url', { url: url.value, name: name.value });
            close();
            refresh();
          });
        },
      },
        field('Address', url),
        field('Name (optional)', name),
        h('p', { class: 'muted small' }, 'Some sites refuse to appear inside another page, and those will show blank or an error. YouTube is not supported. An address ending in .m3u8 is added as a live stream.'),
        h('div', { class: 'dialog-foot' },
          h('button', { type: 'button', onclick: close }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Add')),
      );
    });
  }

  const filterSelect = (key, label, options) => h('select', {
    'aria-label': label,
    onchange: (e) => setQuery(key, e.target.value),
  }, options.map(([value, text]) => h('option', { value, selected: query[key] === String(value) }, text)));

  const filtersEl = h('div', { class: 'lib-filters' });
  function renderFilters() {
    filtersEl.replaceChildren(
      filterSelect('sort', 'Sort', [['newest', 'Newest first'], ['name', 'Name'], ['size', 'Largest first']]),
      filterSelect('type', 'Filter by type', [['', 'All types'], ...Object.entries(TYPE_LABEL)]),
      filterSelect('folder', 'Filter by folder', [['', 'All folders'], ['none', 'Not in a folder'], ...folders.map((f) => [f.id, f.name])]),
      filterSelect('tag', 'Filter by tag', [['', 'All tags'], ...tags.map((t) => [t.id, t.name])]),
      filterSelect('status', 'Filter by status', [['', 'Any status'], ['ready', 'Ready'], ['processing', 'Processing'], ['failed', 'Failed']]),
    );
  }

  let searchTimer = null;
  const searchEl = h('input', {
    type: 'text',
    placeholder: 'Search by name',
    'aria-label': 'Search by name',
    style: 'width:100%',
    oninput: (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => setQuery('q', e.target.value.trim()), 250);
    },
  });

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Library'),
      h('div', { class: 'actions' },
        ctx.can('library.upload') && h('a', { class: 'btn primary', href: '#/upload' }, 'Upload'),
        ctx.can('library.upload') && h('button', { onclick: textDialog }, 'Text'),
        ctx.can('library.upload') && h('button', { onclick: urlDialog }, 'Web page'),
        canOrganize && h('button', { onclick: organizeDialog }, 'Folders and tags'),
        canTouchItems && h('a', { class: 'btn', href: '#/library/cleanup' }, 'Clean up'),
      )),
    h('div', { style: 'margin-bottom:8px' }, searchEl),
    // Folded on a phone, so the items come first.
    h('details', { class: 'lib-more', open: matchMedia('(min-width: 800px)').matches }, h('summary', {}, 'Sort and filter'), filtersEl),
    h('div', { class: 'lib-count' }, countEl, (canTouchItems || ctx.can('channels.add') || ctx.can('live.manage')) && selectBtn),
    grid,
    moreBtn,
    selBar,
  );
  await refresh();

  // A link from the upload page's duplicate warning opens that item.
  const openId = new URLSearchParams(location.hash.split('?')[1] ?? '').get('item');
  if (openId) {
    const item = await guard(() => api.get(`/api/library/${encodeURIComponent(openId)}`));
    if (item) editDialog(item);
  }

  return {
    refresh: (s) => {
      if ((s.includes('media') || s.includes('channels') || s.includes('overrides')) && !document.querySelector('dialog[open]')) guard(refresh);
    },
    destroy: () => clearTimeout(searchTimer),
  };
}
