import { h, api, guard, field, toast, ago } from '../lib.js';

export async function screensView(main, ctx) {
  const isAdmin = ctx.me.role === 'admin';
  const info = await guard(() => api.get('/api/info'));
  const base = info?.urls[0] ?? location.origin;
  const listEl = h('div', { class: 'list' });
  let channels = [];

  const code = h('input', { type: 'text', inputmode: 'numeric', maxlength: 4, placeholder: '1234', required: true, 'aria-label': 'Code on the TV' });
  const name = h('input', { type: 'text', placeholder: 'Gym Lobby TV' });
  const channel = h('select', { required: true });

  async function refresh() {
    const [screens, chans] = await Promise.all([api.get('/api/screens'), api.get('/api/channels')]);
    channels = chans;
    const chosen = channel.value;
    channel.replaceChildren(...channels.map((c) => h('option', { value: c.id }, c.name)));
    if (chosen) channel.value = chosen;

    if (document.activeElement?.closest?.('.screen-row')) return;
    listEl.replaceChildren(...(screens.length ? screens.map(row) : [
      h('p', { class: 'muted' }, 'No TVs yet. Open the address above on a TV to add one.'),
    ]));
  }

  function row(s) {
    const status = s.online
      ? (s.pairCode ? `Waiting to pair (code ${s.pairCode})` : s.currentItem ? `Playing: ${s.currentItem}` : 'Online, nothing playing')
      : `Offline, last seen ${ago(s.lastSeen)}`;
    return h('div', { class: 'tile screen-row', style: 'flex-wrap:wrap' },
      h('span', { class: `dot${s.online ? ' on' : ''}`, title: s.online ? 'Online' : 'Offline' }),
      h('div', { class: 'grow', style: 'flex-basis:160px' },
        h('div', { class: 'title' }, s.name),
        h('div', { class: 'muted small' }, status),
      ),
      isAdmin ? [
        h('select', {
          'aria-label': `Channel for ${s.name}`,
          onchange: (e) => guard(async () => {
            await api.patch(`/api/screens/${s.id}`, { channelId: e.target.value || null });
            e.target.blur();
          }),
        },
          h('option', { value: '', selected: !s.channelId }, 'No channel'),
          channels.map((c) => h('option', { value: c.id, selected: c.id === s.channelId }, c.name)),
        ),
        h('button', {
          class: 'ghost',
          onclick: () => guard(async () => {
            const next = prompt('Name this screen', s.name);
            if (next) await api.patch(`/api/screens/${s.id}`, { name: next });
          }),
        }, 'Rename'),
        h('button', {
          class: 'ghost danger-text',
          onclick: () => guard(async () => {
            if (confirm(`Remove ${s.name}? If that TV is on, it will go back to showing a pairing code.`)) await api.del(`/api/screens/${s.id}`);
          }),
        }, 'Remove'),
      ] : h('span', { class: 'muted small' }, s.channelName ?? 'No channel'),
    );
  }

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Screens'),
      h('div', { class: 'actions' }, h('a', { class: 'btn primary', href: '#/upload' }, 'Upload'))),
    isAdmin && h('section', { class: 'card' },
      h('h2', {}, 'Add a TV'),
      h('p', {}, 'On the TV, open ', h('strong', { class: 'code' }, `${base}/tv`), ' and enter the 4-digit code it shows.'),
      h('form', {
        class: 'row',
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            await api.post('/api/pair', { code: code.value, channelId: Number(channel.value), name: name.value });
            toast('TV paired.');
            code.value = '';
            name.value = '';
          });
        },
      },
        field('Code on the TV', code),
        field('Channel', channel),
        field('Name (optional)', name),
        h('button', { type: 'submit', class: 'primary' }, 'Pair'),
      ),
    ),
    h('section', {}, listEl),
  );
  await refresh();

  return { refresh: (scopes) => (scopes.includes('screens') || scopes.includes('channels')) && guard(refresh) };
}
