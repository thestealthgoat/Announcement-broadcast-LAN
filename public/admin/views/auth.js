import { h, api, field } from '../lib.js';

function form(onSubmit, ...children) {
  const error = h('p', { class: 'err', hidden: true, role: 'alert' });
  return h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      error.hidden = true;
      const button = e.target.querySelector('button[type=submit]');
      button.disabled = true;
      try {
        await onSubmit();
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        button.disabled = false;
      }
    },
  }, ...children, error);
}

export function setupView(root, done) {
  const org = h('input', { type: 'text', required: true, autocomplete: 'organization', placeholder: 'Your school or organization' });
  const name = h('input', { type: 'text', required: true, autocomplete: 'name' });
  const username = h('input', { type: 'text', required: true, autocomplete: 'username', autocapitalize: 'none' });
  const password = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
    h('h1', { style: 'margin-bottom:.4rem' }, 'Welcome'),
    h('p', { class: 'muted' }, 'Set up your organization and create the admin account.'),
    form(
      async () => {
        await api.post('/api/setup', { orgName: org.value, name: name.value, username: username.value, password: password.value });
        done();
      },
      field('Organization name', org),
      field('Your name', name),
      field('Username', username),
      field('Password (8 or more characters)', password),
      h('button', { type: 'submit', class: 'primary', style: 'width:100%' }, 'Finish setup'),
    ),
  )));
  org.focus();
}

export function loginView(root, branding, done) {
  const username = h('input', { type: 'text', required: true, autocomplete: 'username', autocapitalize: 'none' });
  const password = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' },
    branding.logo && h('img', { class: 'logo', src: branding.logo, alt: '' }),
    h('h1', { style: 'margin-bottom:1rem' }, branding.orgName),
    form(
      async () => {
        await api.post('/api/login', { username: username.value, password: password.value });
        done();
      },
      field('Username', username),
      field('Password', password),
      h('button', { type: 'submit', class: 'primary', style: 'width:100%' }, 'Sign in'),
    ),
    h('p', { class: 'muted small', style: 'margin:.75rem 0 0' }, 'Need an account? Ask your admin.'),
  )));
  username.focus();
}
