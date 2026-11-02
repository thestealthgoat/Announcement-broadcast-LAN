import os from 'node:os';
import net from 'node:net';

// True for loopback, RFC1918, link-local and IPv6 ULA addresses.
export function isLocalAddress(ip) {
  if (!ip) return false;
  let addr = ip.split('%')[0];
  if (addr.toLowerCase().startsWith('::ffff:')) addr = addr.slice(7);
  if (net.isIPv4(addr)) {
    const [a, b] = addr.split('.').map(Number);
    return (
      a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    );
  }
  if (net.isIPv6(addr)) {
    const lower = addr.toLowerCase();
    return lower === '::1' || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower);
  }
  return false;
}

// LAN IPv4 addresses of this machine, likeliest first.
export function lanAddresses() {
  const found = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (/^(utun|awdl|llw|bridge|vmnet|vboxnet|docker|veth|tun|tap)/i.test(name)) continue;
    if (/virtual|vmware|hyper-v|loopback/i.test(name)) continue;
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
        found.push(a.address);
      }
    }
  }
  const rank = (ip) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return found.sort((x, y) => rank(x) - rank(y));
}

export function baseUrls(port) {
  const addrs = lanAddresses();
  return (addrs.length ? addrs : ['localhost']).map((a) => `http://${a}:${port}`);
}
