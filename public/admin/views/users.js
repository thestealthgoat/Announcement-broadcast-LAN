import { h, api, guard, field, checkbox, openDialog } from '../lib.js';

export async function usersView(main, ctx) {
  const listEl = h('div', { class: 'list' });
  let channels = [];

  function dialog(user) {
    openDialog(user ? `Edit ${user.name}` : 'New user', (close) => {
      const name = h('input', { type: 'text', required: true, value: user?.name ?? '' });
      const username = h('input', { type: 'text', required: true, autocapitalize: 'none', value: user?.username ?? '', disabled: !!user });
      const password = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: !user });
      const role = h('select', {}, h('option', { value: 'editor', selected: user?.role !== 'admin' }, 'Editor'), h('option', { value: 'admin', selected: user?.role === 'admin' }, 'Admin'));
      const override = h('input', { type: 'checkbox', checked: user?.canOverride });
      const boxes = channels.map((c) => ({ c, box: h('input', { type: 'checkbox', checked: user?.channelIds.includes(c.id) }) }));
      const editorOnly = h('div', {},
        h('label', { class: 'check' }, override, h('span', {}, 'Can push overrides')),
        h('div', { class: 'small', style: 'font-weight:600;margin-top:8px' }, 'Channels they manage'),
        boxes.map(({ c, box }) => h('label', { class: 'check' }, box, h('span', {}, c.name))),
      );
      const sync = () => { editorOnly.hidden = role.value === 'admin'; };
      role.addEventListener('change', sync);
      sync();
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            const payload = {
              name: name.value, role: role.value, canOverride: override.checked,
              channelIds: boxes.filter((b) => b.box.checked).map((b) => b.c.id),
            };
            if (password.value) payload.password = password.value;
            if (user) await api.patch(`/api/users/${user.id}`, payload);
            else await api.post('/api/users', { ...payload, username: username.value });
            close();
            refresh();
          });
        },
      },
        field('Name', name),
        field('Username', username),
        field(user ? 'New password (blank keeps the current one)' : 'Password (8 or more characters)', password),
        field('Role', role),
        editorOnly,
        h('div', { class: 'dialog-foot' },
          user && user.id !== ctx.me.id && h('button', {
            type: 'button',
            class: 'danger-text left',
            onclick: () => guard(async () => {
              if (!confirm(`Delete ${user.name}?`)) return;
              await api.del(`/api/users/${user.id}`);
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

  async function refresh() {
    const [users, chans] = await Promise.all([api.get('/api/users'), api.get('/api/channels')]);
    channels = chans;
    listEl.replaceChildren(...users.map((u) => {
      const scope = u.role === 'admin'
        ? 'Admin'
        : `Editor, ${u.channelIds.length} channel${u.channelIds.length === 1 ? '' : 's'}${u.canOverride ? ', can override' : ''}`;
      return h('button', { class: 'tile', style: 'width:100%;text-align:left;font-weight:400', onclick: () => dialog(u) },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, u.name), h('div', { class: 'muted small' }, `${u.username}: ${scope}`)),
        h('span', { class: 'muted' }, 'Edit'),
      );
    }));
  }

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Users'), h('button', { class: 'primary', onclick: () => dialog(null) }, 'New user')),
    listEl,
  );
  await refresh();
  return null;
}
