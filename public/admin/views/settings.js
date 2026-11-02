import { h, api, guard, field, checkbox, toast } from '../lib.js';

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

export async function settingsView(main, ctx) {
  const canSettings = ctx.can('settings.manage');
  const b = await api.get('/api/branding');
  const info = await guard(() => api.get('/api/info'));
  const ops = await guard(() => api.get('/api/ops/status'));

  const orgName = h('input', { type: 'text', value: b.orgName, required: true });
  const primary = h('input', { type: 'color', value: b.primaryColor });
  const accent = h('input', { type: 'color', value: b.accentColor });
  const textColor = h('input', { type: 'color', value: b.textColor });
  const fontMode = h('select', {},
    h('option', { value: 'system', selected: b.fontMode === 'system' }, 'Default'),
    h('option', { value: 'google', selected: b.fontMode === 'google' }, 'Google Font'),
    h('option', { value: 'upload', selected: b.fontMode === 'upload' }, 'Uploaded font'),
  );
  const fontFamily = h('input', { type: 'text', value: b.fontFamily, placeholder: 'Roboto Slab' });
  const googleRow = field('Google Font name', fontFamily);
  const fontInput = h('input', { type: 'file', accept: '.woff2,.woff,.ttf,.otf' });
  const uploadRow = h('div', {},
    field('Font file (WOFF2, WOFF, TTF or OTF)', fontInput),
    b.fontFile && h('p', { class: 'muted small' }, 'A font is uploaded.'),
  );
  const logoPreview = h('div', {}, b.logo && h('img', { src: b.logo, alt: 'Current logo', style: 'max-height:64px;max-width:200px;margin-bottom:8px;display:block' }));
  const logoInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  const sampleTitle = h('div', { class: 't' }, 'Announcement title');
  const sampleRule = h('div', { style: 'width:64px;height:4px;border-radius:2px;margin:0 auto 12px' });
  const sample = h('div', { class: 'brand-sample' }, sampleRule, sampleTitle, h('div', {}, 'This is how text slides look on TVs.'));

  const syncForm = () => {
    googleRow.hidden = fontMode.value !== 'google';
    uploadRow.hidden = fontMode.value !== 'upload';
    sample.style.background = primary.value;
    sample.style.color = textColor.value;
    sampleRule.style.background = accent.value;
  };
  [primary, accent, textColor, fontMode].forEach((el) => el.addEventListener('input', syncForm));

  const upload = (url, input) => {
    const form = new FormData();
    form.append('file', input.files[0]);
    return api.post(url, form);
  };

  const current = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = h('input', { type: 'password', required: true, minlength: 8, autocomplete: 'new-password' });

  main.replaceChildren(
    h('div', { class: 'page-head' }, h('h1', {}, 'Settings')),
    canSettings && h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        guard(async () => {
          if (logoInput.files[0]) await upload('/api/branding/logo', logoInput);
          if (fontMode.value === 'upload' && fontInput.files[0]) await upload('/api/branding/font', fontInput);
          await api.put('/api/branding', {
            orgName: orgName.value, primaryColor: primary.value, accentColor: accent.value, textColor: textColor.value,
            fontMode: fontMode.value, fontFamily: fontFamily.value,
          });
          toast('Branding saved. TVs update right away.');
          await ctx.refreshBranding();
          location.hash = '#/settings';
          settingsView(document.getElementById('main'), ctx);
        });
      },
    },
      h('h2', {}, 'Branding'),
      sample,
      field('Organization name', orgName),
      h('div', { class: 'row' }, field('Background', primary), field('Accent', accent), field('Text', textColor)),
      h('div', { style: 'height:12px' }),
      logoPreview,
      field('Logo', logoInput),
      b.logo && h('button', {
        type: 'button', class: 'ghost danger-text',
        onclick: () => guard(async () => {
          await api.del('/api/branding/logo');
          await ctx.refreshBranding();
          settingsView(document.getElementById('main'), ctx);
        }),
      }, 'Remove logo'),
      field('Font', fontMode),
      googleRow,
      uploadRow,
      h('p', { class: 'muted small' }, 'Google Fonts need the TVs to have internet access. Otherwise they use the default font.'),
      h('button', { type: 'submit', class: 'primary' }, 'Save branding'),
    ),
    h('form', {
      class: 'card',
      onsubmit: (e) => {
        e.preventDefault();
        guard(async () => {
          await api.post('/api/me/password', { current: current.value, next: next.value });
          current.value = '';
          next.value = '';
          toast('Password changed.');
        });
      },
    },
      h('h2', {}, 'Your password'),
      field('Current password', current),
      field('New password (8 or more characters)', next),
      h('button', { type: 'submit' }, 'Change password'),
    ),
    ops && h('section', { class: 'card' },
      h('h2', {}, 'Storage'),
      h('p', { class: 'small' }, `Library size: ${formatBytes(ops.librarySize)}`, h('br'),
        ops.storage ? `Free space on this computer: ${formatBytes(ops.storage.free)} of ${formatBytes(ops.storage.total)}` : 'Free space on this computer: not known yet'),
    ),
    canSettings && ops && h('section', { class: 'card' },
      h('h2', {}, 'Updates'),
      checkbox('Check for updates', {
        checked: ops.checkForUpdates,
        onchange: (e) => guard(() => api.put('/api/ops/settings', { checkForUpdates: e.target.checked })),
      }),
      h('p', { class: 'muted small' }, 'Once a day, this computer asks GitHub if there is a newer version and tells you here. Nothing installs by itself. Turn this off and the server makes no internet requests.'),
    ),
    h('section', { class: 'card' },
      h('h2', {}, 'About'),
      info && h('p', { class: 'small' }, 'Admin address: ', h('span', { class: 'code' }, `${info.urls[0]}/admin/`), h('br'), `Version ${info.version}`),
      h('button', {
        onclick: () => guard(async () => {
          await api.post('/api/logout');
          ctx.signedOut();
        }),
      }, 'Sign out'),
    ),
  );
  syncForm();
  return null;
}
