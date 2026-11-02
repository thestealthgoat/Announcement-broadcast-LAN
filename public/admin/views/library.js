import { h, api, guard, field, checkbox, toast, openDialog, thumb, TYPE_LABEL } from '../lib.js';
import { createDesigner, loadDesignerData } from '../designer.js';

const LIVE_STATUS = { live: 'Live feed: on air', idle: 'Live feed: no signal', error: 'Live feed: has a problem', off: 'Live feed: turned off' };

export async function libraryView(main, ctx) {
  const grid = h('div', { class: 'grid' });
  let filter = '';
  let media = [];

  function render() {
    const shown = media.filter((m) => !filter || m.type === filter);
    grid.replaceChildren(...(shown.length ? shown.map(card) : [h('p', { class: 'muted', style: 'grid-column:1/-1' }, media.length ? 'Nothing of that type.' : 'The library is empty. Upload something to get started.')]));
  }

  function card(m) {
    const status = m.status === 'processing'
      ? h('div', {}, h('div', { class: 'muted small' }, m.progress != null ? `Converting ${m.progress}%` : 'Processing…'), h('div', { class: 'bar' }, h('div', { style: `width:${m.progress ?? 5}%` })))
      : m.status === 'failed'
        ? h('div', { class: 'err small' }, m.error ?? 'Failed')
        : h('div', { class: 'muted small' }, LIVE_STATUS[m.liveStatus] ?? TYPE_LABEL[m.type]);
    return h('button', { class: 'media-card', onclick: () => guard(async () => editDialog(m, m.type === 'text' ? await loadDesignerData() : null)) },
      thumb(m, 'pic'),
      h('div', { class: 'meta' }, h('div', { class: 'title' }, m.name), status),
    );
  }

  async function refresh() {
    media = await api.get('/api/media');
    render();
  }

  function editDialog(m, designerData) {
    const canChange = ctx.can('library.edit') || (ctx.can('library.own') && m.createdBy === ctx.me.id);
    const canDelete = m.live ? ctx.can('live.manage') : canChange;
    openDialog(m.name, (close) => {
      const name = h('input', { type: 'text', value: m.name, required: true, disabled: !canChange });
      const title = h('input', { type: 'text', value: m.title ?? '', disabled: !canChange, oninput: () => designer?.update() });
      const body = h('textarea', { disabled: !canChange, oninput: () => designer?.update() }, m.body ?? '');
      const url = h('input', { type: 'url', value: m.url ?? '', disabled: !canChange });
      const designer = designerData && createDesigner({
        data: designerData,
        initial: m.style,
        readOnly: !canChange,
        canManage: canChange && ctx.can('settings.manage'),
        getText: () => ({ title: title.value, body: body.value }),
      });
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
            if (m.type === 'text') Object.assign(patch, { title: title.value, body: body.value, style: designer.getStyle() });
            if ((m.type === 'web' || m.type === 'hls') && !m.live) patch.url = url.value;
            await api.patch(`/api/media/${m.id}`, patch);
            close();
            refresh();
          });
        },
      },
        m.thumb && h('img', { src: m.thumb, alt: '', style: 'width:100%;border-radius:8px;margin-bottom:12px' }),
        field('Name', name),
        designer && canChange && designer.chips,
        m.type === 'text' && field('Title', title),
        m.type === 'text' && field('Message', body),
        designer && designer.preview,
        designer && canChange && designer.controls,
        (m.type === 'web' || m.type === 'hls') && !m.live && field('Address', url),
        m.live && h('p', { class: 'muted small' }, 'This is a live feed. It only shows on TVs while it is on air.'),
        m.status === 'ready' && ctx.can('channels.add') && chanBox,
        h('div', { class: 'dialog-foot' },
          canDelete && h('button', {
            type: 'button',
            class: 'danger-text left',
            onclick: () => guard(async () => {
              if (!confirm(`Delete ${m.name} from the library? It will come off every channel.`)) return;
              await api.del(`/api/media/${m.id}`);
              close();
              refresh();
            }),
          }, 'Delete'),
          h('button', { type: 'button', onclick: close }, canChange ? 'Cancel' : 'Close'),
          canChange && h('button', { type: 'submit', class: 'primary' }, 'Save'),
        ),
      );
    });
  }

  async function textDialog() {
    const designerData = await loadDesignerData();
    openDialog('New text announcement', (close) => {
      const title = h('input', { type: 'text', required: true, maxlength: 200, oninput: () => designer.update() });
      const body = h('textarea', { maxlength: 2000, oninput: () => designer.update() });
      const designer = createDesigner({
        data: designerData,
        canManage: ctx.can('settings.manage'),
        getText: () => ({ title: title.value, body: body.value }),
      });
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            await api.post('/api/media/text', { title: title.value, body: body.value, style: designer.getStyle() });
            close();
            refresh();
          });
        },
      },
        designer.chips,
        field('Title', title),
        field('Message (optional)', body),
        designer.preview,
        designer.controls,
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

  const filterEl = h('select', {
    'aria-label': 'Filter by type',
    onchange: (e) => {
      filter = e.target.value;
      render();
    },
  }, h('option', { value: '' }, 'All types'), Object.entries(TYPE_LABEL).map(([k, v]) => h('option', { value: k }, v)));

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Library'),
      ctx.can('library.upload') && h('div', { class: 'actions' },
        h('a', { class: 'btn primary', href: '#/upload' }, 'Upload'),
        h('button', { onclick: () => guard(textDialog) }, 'Text'),
        h('button', { onclick: urlDialog }, 'Web page'),
      )),
    h('div', { style: 'margin-bottom:12px' }, filterEl),
    grid,
  );
  await refresh();
  return {
    refresh: (s) => {
      if (s.includes('media') && !document.querySelector('dialog[open]')) guard(refresh);
    },
  };
}
