// Small helpers shared by the admin views.
export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'multiple' || k === 'required') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c);
  }
}

export function svg(path) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', '0 0 24 24');
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', 'currentColor');
  el.setAttribute('stroke-width', '1.8');
  el.setAttribute('stroke-linecap', 'round');
  el.setAttribute('stroke-linejoin', 'round');
  el.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', path);
  el.append(p);
  return el;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function request(method, url, body) {
  const isForm = body instanceof FormData;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body !== undefined && !isForm ? { 'Content-Type': 'application/json' } : {},
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'Could not reach the server.');
  }
  const data = (res.headers.get('content-type') ?? '').includes('json') ? await res.json() : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/me')) location.reload();
    throw new ApiError(res.status, data?.error ?? 'Something went wrong.');
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b = {}) => request('POST', u, b),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),
  del: (u) => request('DELETE', u),
};

export function toast(message, bad = false) {
  const el = h('div', { class: `toast${bad ? ' bad' : ''}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 2500);
}

// Runs an action, showing any failure as a toast.
export async function guard(fn) {
  try {
    return await fn();
  } catch (err) {
    toast(err.message || 'Something went wrong.', true);
    return undefined;
  }
}

export function field(label, control) {
  return h('label', { class: 'field' }, label, control);
}

export function checkbox(label, props) {
  return h('label', { class: 'check' }, h('input', { type: 'checkbox', ...props }), h('span', {}, label));
}

export function openDialog(title, build) {
  const dlg = h('dialog', {});
  const close = () => {
    dlg.close();
    dlg.remove();
  };
  dlg.append(h('h2', {}, title));
  append(dlg, [build(close)]);
  dlg.addEventListener('cancel', () => dlg.remove());
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  document.body.append(dlg);
  dlg.showModal();
  return { close };
}

export function ago(ms) {
  if (!ms) return 'never';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

export const TYPE_LABEL = { image: 'Image', video: 'Video', pdf: 'PDF', web: 'Web page', text: 'Text', hls: 'Live stream' };

export function thumb(media, cls = 'thumb') {
  if (media.thumb) return h('img', { class: cls, src: media.thumb, alt: '', loading: 'lazy' });
  if (media.type === 'text') return h('div', { class: cls }, media.title ?? 'Text');
  return h('div', { class: cls }, TYPE_LABEL[media.type] ?? media.type);
}
