// Works out ahead of time whether a web page will show on a TV. Pages are shown in an iframe, and a
// site that refuses that gives no signal the page could read: the frame just stays blank.

const TIMEOUT_MS = 8000;
const BLOCKED = 'This site refuses to appear inside another page, so TVs will show a blank screen. Look for an embed version of the page, often under Share > Embed.';

// A browser obeys frame-ancestors over X-Frame-Options when a site sends both.
export function refusesFraming(headers) {
  const policies = (headers.get('content-security-policy') ?? '').split(',');
  const ancestors = policies
    .map((policy) => policy.split(';').map((d) => d.trim().split(/\s+/)).find((d) => d[0].toLowerCase() === 'frame-ancestors'))
    .filter(Boolean);
  if (ancestors.length) {
    // Only these can match a player on a plain LAN address that the site has never heard of.
    return !ancestors.every((d) => d.slice(1).some((source) => ['*', 'http:'].includes(source.toLowerCase())));
  }
  const frameOptions = (headers.get('x-frame-options') ?? '').toLowerCase();
  return /\b(deny|sameorigin)\b/.test(frameOptions);
}

export async function checkWebPage(url, { fetch = globalThis.fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
    });
    if (refusesFraming(res.headers)) return { status: 'blocked', message: BLOCKED };
    if (res.status >= 400) return { status: 'error', message: `The site answered with an error (${res.status}), so TVs may not show this page.` };
    return { status: 'ok', message: 'This site allows being shown on a TV. Check the picture below too, because a page can still load blank.' };
  } catch {
    return { status: 'unknown', message: "This computer couldn't reach the site, so it couldn't be checked. TVs may not reach it either." };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
