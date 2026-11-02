import { h, api, guard, field, openDialog } from '../lib.js';
import { allowsList } from './roles.js';

export async function usersView(main, ctx) {
  const listEl = h('div', { class: 'list' });
  let channels = [];
  let roles = [];
  let catalog = [];

  // The server refuses changes to anyone with more access, so don't offer them.
  const withinMe = (u) => u.permissions.every(ctx.can)
    && (ctx.me.allChannels || u.channelIds.every((id) => ctx.me.channelIds.includes(id)));
  const defaultRole = () => roles.find((r) => r.name === 'Editor' && r.canAssign) ?? roles.find((r) => r.canAssign);

  function dialog(user) {
    openDialog(user ? `Edit ${user.name}` : 'New user', (close) => {
      const name = h('input', { type: 'text', required: true, value: user?.name ?? '' });
      const username = h('input', { type: 'text', required: true, autocapitalize: 'none', value: user?.username ?? '', disabled: !!user });
      const password = h('input', { type: 'password', autocomplete: 'new-password', minlength: 8, required: !user });
      const selected = user?.roleId ?? defaultRole()?.id;
      const role = h('select', {}, roles.filter((r) => r.canAssign).map((r) => h('option', { value: r.id, selected: r.id === selected }, r.name)));
      const boxes = channels.filter((c) => c.canAccess).map((c) => ({ c, box: h('input', { type: 'checkbox', checked: user?.channelIds.includes(c.id) }) }));
      const allows = h('div', {});
      const channelPicker = h('div', {},
        h('div', { class: 'small', style: 'font-weight:600;margin-top:8px' }, 'Channels they work on'),
        boxes.length ? boxes.map(({ c, box }) => h('label', { class: 'check' }, box, h('span', {}, c.name))) : h('p', { class: 'muted small' }, 'There are no channels to choose from.'),
      );
      const current = () => roles.find((r) => r.id === Number(role.value));
      const sync = () => {
        const chosen = current();
        allows.replaceChildren(
          h('div', { class: 'small', style: 'font-weight:600' }, 'This role can'),
          allowsList(catalog, chosen?.permissions ?? []),
        );
        channelPicker.hidden = !!chosen?.permissions.includes('channels.all');
      };
      role.addEventListener('change', sync);
      sync();
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            const payload = { name: name.value, roleId: Number(role.value) };
            if (!channelPicker.hidden) payload.channelIds = boxes.filter((b) => b.box.checked).map((b) => b.c.id);
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
        allows,
        channelPicker,
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

  function summary(u) {
    const scope = u.allChannels ? 'all channels' : `${u.channelIds.length} channel${u.channelIds.length === 1 ? '' : 's'}`;
    return `${u.username}: ${u.roleName ?? 'No role'}, ${scope}`;
  }

  async function refresh() {
    const [users, chans, data] = await Promise.all([api.get('/api/users'), api.get('/api/channels'), api.get('/api/roles')]);
    channels = chans;
    roles = data.roles;
    catalog = data.permissions;
    listEl.replaceChildren(...users.map((u) => {
      const text = h('div', { class: 'grow' }, h('div', { class: 'title' }, u.name), h('div', { class: 'muted small' }, summary(u)));
      if (!withinMe(u)) return h('div', { class: 'tile' }, text, h('span', { class: 'muted small' }, 'Has more access than you'));
      return h('button', { class: 'tile', style: 'width:100%;text-align:left;font-weight:400', onclick: () => dialog(u) }, text, h('span', { class: 'muted' }, 'Edit'));
    }));
  }

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Users'),
      h('div', { class: 'actions' },
        h('a', { class: 'btn', href: '#/roles' }, 'Roles'),
        h('button', { class: 'primary', onclick: () => dialog(null) }, 'New user'),
      )),
    listEl,
  );
  await refresh();
  return { refresh: (s) => (s.includes('users') || s.includes('channels')) && !document.querySelector('dialog[open]') && guard(refresh) };
}
