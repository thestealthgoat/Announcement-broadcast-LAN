import { h, api, guard, field, checkbox, toast, openDialog, thumb, TYPE_LABEL } from '../lib.js';

export async function libraryView(main) {
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
        : h('div', { class: 'muted small' }, TYPE_LABEL[m.type]);
    return h('button', { class: 'media-card', onclick: () => editDialog(m) },
      thumb(m, 'pic'),
      h('div', { class: 'meta' }, h('div', { class: 'title' }, m.name), status),
    );
  }

  async function refresh() {
    media = await api.get('/api/media');
    render();
  }

  function editDialog(m) {
    openDialog(m.name, (close) => {
      const name = h('input', { type: 'text', value: m.name, required: true });
      const title = h('input', { type: 'text', value: m.title ?? '' });
      const body = h('textarea', {}, m.body ?? '');
      const url = h('input', { type: 'url', value: m.url ?? '' });
      const chanBox = h('div', { class: 'list' });
      api.get('/api/channels').then((channels) => {
        const editable = channels.filter((c) => c.canEdit);
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
            if (m.type === 'web' || m.type === 'hls') patch.url = url.value;
            await api.patch(`/api/media/${m.id}`, patch);
            close();
            refresh();
          });
        },
      },
        m.thumb && h('img', { src: m.thumb, alt: '', style: 'width:100%;border-radius:8px;margin-bottom:12px' }),
        field('Name', name),
        m.type === 'text' && field('Title', title),
        m.type === 'text' && field('Message', body),
        (m.type === 'web' || m.type === 'hls') && field('Address', url),
        m.status === 'ready' && chanBox,
        h('div', { class: 'dialog-foot' },
          h('button', {
            type: 'button',
            class: 'danger-text left',
            onclick: () => guard(async () => {
              if (!confirm(`Delete ${m.name} from the library? It will come off every channel.`)) return;
              await api.del(`/api/media/${m.id}`);
              close();
              refresh();
            }),
          }, 'Delete'),
          h('button', { type: 'button', onclick: close }, 'Cancel'),
          h('button', { type: 'submit', class: 'primary' }, 'Save'),
        ),
      );
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

  const filterEl = h('select', {
    'aria-label': 'Filter by type',
    onchange: (e) => {
      filter = e.target.value;
      render();
    },
  }, h('option', { value: '' }, 'All types'), Object.entries(TYPE_LABEL).map(([k, v]) => h('option', { value: k }, v)));

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Library'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn primary', href: '#/upload' }, 'Upload'),
        h('button', { onclick: textDialog }, 'Text'),
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
