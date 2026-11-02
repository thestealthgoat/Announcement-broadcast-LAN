import { h, api, guard, field, toast } from '../lib.js';
import { uploadFile } from '../upload.js';

export async function uploadView(main, ctx) {
  const channels = (await guard(() => api.get('/api/channels'))) ?? [];
  const preselect = Number(new URLSearchParams(location.hash.split('?')[1] ?? '').get('channel')) || null;
  const channel = h('select', {},
    h('option', { value: '' }, 'Library only'),
    channels.filter((c) => c.canAdd).map((c) => h('option', { value: c.id, selected: c.id === preselect }, c.name)),
  );
  const queueEl = h('div', { class: 'list', style: 'margin-top:12px' });
  let queue = Promise.resolve();

  // A match never stops an upload. Whether two copies were wanted is for the person to decide.
  function duplicateNotice(item, row) {
    return h('div', { class: 'small lib-dup', role: 'status' },
      h('div', { class: 'warn-text' }, 'This looks like a file already in the library: ', h('a', { href: `#/library?item=${item.duplicateOf.id}` }, item.duplicateOf.name), '.'),
      (ctx.can('library.edit') || ctx.can('library.own')) && h('button', {
        type: 'button',
        onclick: () => guard(async () => {
          await api.del(`/api/media/${item.id}`);
          row.remove();
          toast('Removed the new copy.');
        }),
      }, 'Discard this copy'),
    );
  }

  function addFiles(files) {
    for (const file of files) {
      const status = h('div', { class: 'muted small' }, 'Waiting…');
      const bar = h('div', {});
      const row = h('div', { class: 'tile' }, h('div', { class: 'grow' },
        h('div', { class: 'title' }, file.name), status, h('div', { class: 'bar' }, bar)));
      queueEl.prepend(row);
      const channelId = channel.value;
      queue = queue.then(async () => {
        try {
          const item = await uploadFile(file, {
            channelId,
            onProgress: (p) => { bar.style.width = `${Math.round(p * 100)}%`; },
            onStatus: (s) => { status.textContent = s; },
          });
          bar.style.width = '100%';
          status.textContent = item.status === 'processing' ? 'Uploaded. The server is finishing it, so you can leave this page.' : 'Done.';
          if (item.duplicateOf) status.after(duplicateNotice(item, row));
        } catch (err) {
          status.textContent = err.message;
          status.className = 'err small';
        }
      });
    }
  }

  const input = h('input', {
    type: 'file', multiple: true, accept: 'image/*,video/*,application/pdf,.pdf',
    onchange: (e) => {
      addFiles([...e.target.files]);
      e.target.value = '';
    },
  });
  const zone = h('label', {
    class: 'dropzone',
    ondragover: (e) => { e.preventDefault(); zone.classList.add('over'); },
    ondragleave: () => zone.classList.remove('over'),
    ondrop: (e) => {
      e.preventDefault();
      zone.classList.remove('over');
      addFiles([...e.dataTransfer.files]);
    },
  }, input, h('span', {}, 'Choose photos, videos or PDFs'), h('span', { class: 'muted small', style: 'font-weight:400' }, 'From your camera roll or files'));

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Upload'), h('a', { class: 'btn', href: '#/library' }, 'Go to library')),
    h('section', { class: 'card' },
      field('Also add to', channel),
      zone,
      queueEl,
    ),
    h('section', { class: 'card', style: 'display:flex;gap:16px;align-items:center;flex-wrap:wrap' },
      h('img', { class: 'qr', src: '/api/qr.svg?path=/upload', alt: 'QR code that opens this upload page' }),
      h('div', { style: 'flex:1 1 200px' }, h('h2', {}, 'Upload from your phone'), h('p', { class: 'muted', style: 'margin:0' }, 'Scan this with your phone camera while on the same network, then sign in.')),
    ),
  );
  return null;
}
