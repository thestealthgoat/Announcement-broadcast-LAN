import { h, api, guard, field, openDialog } from '../lib.js';

// What a role allows, in the order and wording of the server's permission list.
export function allowsList(catalog, permissions) {
  const items = catalog.filter((p) => permissions.includes(p.key));
  if (!items.length) return h('p', { class: 'muted small' }, 'This role can only look around. It cannot change anything.');
  return h('ul', { class: 'perm-list small' }, items.map((p) => h('li', {}, p.label)));
}

export const peopleCount = (n) => `${n} ${n === 1 ? 'person' : 'people'}`;

export async function rolesView(main, ctx) {
  const listEl = h('div', { class: 'list' });
  let catalog = [];

  function viewDialog(role) {
    openDialog(role.name, (close) => [
      h('p', { class: 'muted small' }, 'Built-in roles cannot be changed. To make a different mix, create a new role.'),
      allowsList(catalog, role.permissions),
      h('div', { class: 'dialog-foot' }, h('button', { type: 'button', onclick: close }, 'Close')),
    ]);
  }

  function editDialog(role) {
    openDialog(role ? `Edit ${role.name}` : 'New role', (close) => {
      const name = h('input', { type: 'text', required: true, maxlength: 60, value: role?.name ?? '', placeholder: 'Coach' });
      const boxes = catalog.map((p) => ({
        p,
        box: h('input', { type: 'checkbox', checked: role?.permissions.includes(p.key), disabled: !ctx.can(p.key) }),
      }));
      const groups = [...new Set(catalog.map((p) => p.group))];
      const missing = boxes.some(({ box }) => box.disabled);
      return h('form', {
        onsubmit: (e) => {
          e.preventDefault();
          guard(async () => {
            const payload = { name: name.value, permissions: boxes.filter((b) => b.box.checked).map((b) => b.p.key) };
            if (role) await api.patch(`/api/roles/${role.id}`, payload);
            else await api.post('/api/roles', payload);
            close();
            refresh();
          });
        },
      },
        field('Name', name),
        h('p', { class: 'small', style: 'font-weight:600;margin-bottom:0' }, 'What people with this role can do'),
        groups.map((group) => h('div', {},
          h('div', { class: 'small perm-group' }, group),
          boxes.filter(({ p }) => p.group === group).map(({ p, box }) => h('label', { class: 'check' }, box, h('span', {}, p.label))),
        )),
        missing && h('p', { class: 'muted small' }, 'You can only give a role what you can do yourself, so some boxes are locked.'),
        h('div', { class: 'dialog-foot' },
          role && h('button', {
            type: 'button',
            class: 'danger-text left',
            onclick: () => guard(async () => {
              if (!confirm(`Delete the ${role.name} role?`)) return;
              await api.del(`/api/roles/${role.id}`);
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
    const data = await api.get('/api/roles');
    catalog = data.permissions;
    listEl.replaceChildren(...data.roles.map((role) => {
      const detail = [
        role.builtin ? 'Built-in' : 'Custom',
        role.fullAccess ? 'full access' : null,
        peopleCount(role.userCount),
      ].filter(Boolean).join(', ');
      const editable = !role.builtin && role.canAssign;
      return h('button', {
        class: 'tile',
        style: 'width:100%;text-align:left;font-weight:400',
        onclick: () => (editable ? editDialog(role) : viewDialog(role)),
      },
        h('div', { class: 'grow' }, h('div', { class: 'title' }, role.name), h('div', { class: 'muted small' }, detail)),
        h('span', { class: 'muted' }, editable ? 'Edit' : 'View'),
      );
    }));
  }

  main.replaceChildren(
    h('div', { class: 'page-head' },
      h('div', {}, h('a', { href: '#/users', class: 'small' }, '‹ Users'), h('h1', {}, 'Roles')),
      h('button', { class: 'primary', onclick: () => editDialog(null) }, 'New role'),
    ),
    h('p', { class: 'muted' }, 'A role is a set of things someone is allowed to do. Choose one for each person under Users.'),
    listEl,
  );
  await refresh();
  return { refresh: (s) => s.includes('users') && !document.querySelector('dialog[open]') && guard(refresh) };
}
