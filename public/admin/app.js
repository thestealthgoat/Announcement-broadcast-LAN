import { h, svg, api, guard } from './lib.js';
import { setupView, loginView } from './views/auth.js';
import { screensView } from './views/screens.js';
import { channelsView, channelView } from './views/channels.js';
import { libraryView } from './views/library.js';
import { uploadView } from './views/uploadPage.js';
import { overrideView } from './views/override.js';
import { usersView } from './views/users.js';
import { settingsView } from './views/settings.js';

const root = document.getElementById('app');
const ICONS = {
  screens: 'M3 5h18v11H3zM8 20h8M12 16v4',
  channels: 'M4 6h16M4 12h16M4 18h10',
  library: 'M4 4h16v16H4zM4 16l5-5 4 4 3-3 4 4M9 9h.01',
  override: 'M12 3 2 20h20L12 3zM12 10v4M12 17h.01',
  users: 'M16 20v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  settings: 'M4 7h10M18 7h2M4 17h2M10 17h10M16 5v4M8 15v4',
};

const ctx = { me: null, branding: null, view: null };
let socket = null;

function navItems() {
  return [
    ['#/', 'Screens', ICONS.screens],
    ['#/channels', 'Channels', ICONS.channels],
    ['#/library', 'Library', ICONS.library],
    ctx.me.canOverride && ['#/override', 'Override', ICONS.override],
    ctx.me.role === 'admin' && ['#/users', 'Users', ICONS.users],
    ['#/settings', 'Settings', ICONS.settings],
  ].filter(Boolean);
}

function isActive(hash, current) {
  if (hash === '#/') return current === '#/' || current === '';
  return current.startsWith(hash) || (hash === '#/library' && current.startsWith('#/upload'));
}

function route() {
  const hash = location.hash || '#/';
  const [path] = hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean);
  const admin = ctx.me.role === 'admin';
  switch (parts[0]) {
    case undefined: return screensView;
    case 'channels': return parts[1] ? (c, x) => channelView(c, x, Number(parts[1])) : channelsView;
    case 'library': return libraryView;
    case 'upload': return uploadView;
    case 'override': return ctx.me.canOverride ? overrideView : screensView;
    case 'users': return admin ? usersView : screensView;
    case 'settings': return settingsView;
    default: return screensView;
  }
}

async function renderBanner() {
  const slot = document.getElementById('banner');
  if (!slot) return;
  const active = await guard(() => api.get('/api/overrides'));
  if (!active) return;
  slot.replaceChildren(...active.map((o) => {
    const what = o.mediaName ?? o.title ?? 'Announcement';
    const where = o.allChannels ? 'all channels' : `${o.channelIds.length} channel${o.channelIds.length === 1 ? '' : 's'}`;
    const until = o.endsAt ? `until ${new Date(o.endsAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : 'until cleared';
    return h('div', { class: 'banner', role: 'alert' },
      h('div', {}, `Override active: ${what} `, h('span', { class: 'sub' }, `on ${where}, ${until}`)),
      ctx.me.canOverride && h('button', {
        onclick: () => guard(async () => {
          await api.del(`/api/overrides/${o.id}`);
          renderBanner();
          ctx.view?.refresh?.(['overrides']);
        }),
      }, 'Clear'),
    );
  }));
}

let noticesSeq = 0;

async function renderNotices() {
  const seq = ++noticesSeq;
  const notices = await api.get('/api/notices').catch(() => null);
  const slot = document.getElementById('notices');
  if (!notices || !slot || seq !== noticesSeq) return;
  slot.replaceChildren(...notices.filter((n) => n.kind !== 'screens').map((n) => {
    const external = n.link?.href.startsWith('https://');
    return h('div', { class: `notice ${n.severity}`, role: 'status' },
      h('div', { class: 'notice-text' }, n.text),
      n.link && h('a', { class: 'notice-link', href: n.link.href, target: external ? '_blank' : undefined, rel: external ? 'noopener noreferrer' : undefined }, n.link.label),
      n.dismissible && h('button', {
        class: 'ghost',
        onclick: () => api.post(`/api/notices/${encodeURIComponent(n.id)}/dismiss`).catch(() => {}).then(renderNotices),
      }, 'Dismiss'),
    );
  }));
  const count = notices.find((n) => n.kind === 'screens')?.count ?? 0;
  const badge = document.getElementById('screens-badge');
  if (badge) {
    badge.hidden = !count;
    badge.textContent = count;
    badge.title = `${count} offline for more than 5 minutes`;
  }
}

function renderShell() {
  const current = location.hash || '#/';
  const { logo, orgName } = ctx.branding;
  root.replaceChildren(
    h('div', { class: 'shell' },
      h('nav', { class: 'nav', 'aria-label': 'Main' },
        h('div', { class: 'brand' }, logo && h('img', { src: logo, alt: '' }), h('span', {}, orgName)),
        navItems().map(([href, label, icon]) => h('a', {
          href,
          class: isActive(href, current) ? 'active' : '',
          'aria-current': isActive(href, current) ? 'page' : undefined,
        }, svg(icon), h('span', {}, label),
          href === '#/' && h('span', { class: 'nav-badge', id: 'screens-badge', hidden: true }))),
        h('div', { class: 'nav-foot' }, ctx.me.name),
      ),
      h('div', { style: 'flex:1;min-width:0' },
        h('div', { id: 'banner' }),
        h('div', { class: 'notices', id: 'notices' }),
        h('main', { class: 'main', id: 'main' }),
      ),
    ),
  );
  document.title = orgName;
}

async function showPage() {
  renderShell();
  renderBanner();
  renderNotices();
  ctx.view?.destroy?.();
  const main = document.getElementById('main');
  ctx.view = (await route()(main, ctx)) ?? null;
}

function connectSocket() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  socket = new WebSocket(`${proto}${location.host}/ws/admin`);
  socket.onmessage = async (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type !== 'refresh') return;
    if (msg.scopes.includes('overrides')) renderBanner();
    if (msg.scopes.includes('notices')) renderNotices();
    if (msg.scopes.includes('branding')) {
      ctx.branding = await api.get('/api/branding');
      applyAccent();
    }
    ctx.view?.refresh?.(msg.scopes);
  };
  socket.onclose = () => setTimeout(connectSocket, 2000);
}

function applyAccent() {
  document.documentElement.style.setProperty('--accent', ctx.branding.accentColor);
}

async function refreshBranding() {
  ctx.branding = await api.get('/api/branding');
  applyAccent();
}

ctx.refreshBranding = async () => {
  await refreshBranding();
  renderShell();
  renderBanner();
  renderNotices();
};
ctx.signedOut = () => location.reload();

async function start() {
  await refreshBranding();
  const { needsSetup } = await api.get('/api/setup/status');
  if (needsSetup) return setupView(root, () => location.reload());
  try {
    ctx.me = await api.get('/api/me');
  } catch {
    return loginView(root, ctx.branding, () => location.reload());
  }
  window.addEventListener('hashchange', showPage);
  connectSocket();
  showPage();
}

start().catch((err) => {
  root.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card' }, h('h1', {}, 'Cannot reach the server'), h('p', { class: 'muted' }, err.message))));
});
