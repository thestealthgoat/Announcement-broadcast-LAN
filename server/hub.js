import { randomInt } from 'node:crypto';
import { VERSION } from './version.js';
import { wallClock } from './schedule.js';

const PING_MS = 15000;
const DEAD_MS = 45000;
const DEFAULT_STILL_SECONDS = 10;
const DEFAULT_LIVE_SECONDS = 60;

// A playlist row's schedule, or null when it runs all the time.
function scheduleOf(r) {
  if (r.start_date === null && r.end_date === null && r.start_time === null && r.end_time === null && r.days === null) return null;
  return { startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time, days: r.days };
}

// Turns one library item into the slides a player shows. A PDF becomes one slide per page.
export function toSlides(media, placement) {
  const base = {
    mediaId: media.id,
    type: media.type,
    name: media.name,
    transition: placement.transition ?? 'fade',
    audio: !!placement.audio,
    size: media.size ?? null,
    schedule: placement.schedule ?? null,
  };
  const key = `${placement.key}:${media.id}:${media.rev}`;
  const still = placement.duration ?? DEFAULT_STILL_SECONDS;
  const src = media.file ? `/media/${media.id}/${media.file}` : null;
  switch (media.type) {
    case 'image':
      return [{ ...base, key, src, duration: still }];
    case 'video':
      return [{ ...base, key, src, duration: placement.duration ?? null }];
    case 'pdf':
      return Array.from({ length: media.pages ?? 0 }, (_, i) => ({
        ...base,
        type: 'image',
        name: `${media.name} (page ${i + 1})`,
        key: `${key}:${i + 1}`,
        src: `/media/${media.id}/page-${i + 1}.jpg`,
        duration: still,
        size: null,
      }));
    case 'web':
      return [{ ...base, key, src: media.url, duration: still }];
    case 'hls':
      return [{ ...base, key, src: media.url, duration: placement.duration ?? DEFAULT_LIVE_SECONDS }];
    case 'text':
      return [{ ...base, key, title: media.title ?? '', body: media.body ?? '', duration: still }];
    default:
      return [];
  }
}

export function createHub(db, log) {
  const players = new Set();
  const admins = new Set();
  let expiryTimer = null;
  let adminTimer = null;
  const pendingScopes = new Set();

  const send = (socket, msg) => {
    if (socket.readyState === 1) socket.send(JSON.stringify(msg));
  };

  function activeOverrides() {
    const now = Date.now();
    return db.all(
      `SELECT * FROM overrides WHERE cleared_at IS NULL AND (ends_at IS NULL OR ends_at > ?)
       ORDER BY started_at DESC, id DESC`,
      now,
    );
  }

  function overrideChannelIds(id) {
    return db.all('SELECT channel_id FROM override_channels WHERE override_id = ?', id).map((r) => r.channel_id);
  }

  function overrideFor(channelId) {
    for (const o of activeOverrides()) {
      if (!o.all_channels && !overrideChannelIds(o.id).includes(channelId)) continue;
      const placement = { key: `o${o.id}`, audio: o.audio, transition: 'cut' };
      let slides;
      if (o.media_id) {
        const media = db.get("SELECT * FROM media WHERE id = ? AND status = 'ready'", o.media_id);
        if (!media) continue;
        slides = toSlides(media, placement);
      } else {
        slides = [{
          key: `o${o.id}`, mediaId: null, type: 'text', name: o.title || 'Announcement',
          title: o.title ?? '', body: o.body ?? '', transition: 'cut', audio: false, duration: DEFAULT_STILL_SECONDS,
        }];
      }
      return { id: o.id, slides, remainingMs: o.ends_at ? o.ends_at - Date.now() : null };
    }
    return null;
  }

  function channelState(channel) {
    const rows = db.all(
      `SELECT p.id AS pid, p.duration AS p_duration, p.transition, p.audio,
              p.start_date, p.end_date, p.start_time, p.end_time, p.days, m.*
       FROM playlist_items p JOIN media m ON m.id = p.media_id
       WHERE p.channel_id = ? AND p.enabled = 1 AND m.status = 'ready'
       ORDER BY p.position, p.id`,
      channel.id,
    );
    const slides = rows.flatMap((r) =>
      toSlides(r, { key: `p${r.pid}`, duration: r.p_duration, transition: r.transition, audio: r.audio, schedule: scheduleOf(r) }),
    );
    return {
      type: 'state',
      version: VERSION,
      clock: wallClock(),
      channel: { id: channel.id, slug: channel.slug, name: channel.name },
      slides,
      override: overrideFor(channel.id),
      branding: db.branding(),
    };
  }

  function pushChannel(channelId) {
    const channel = db.get('SELECT * FROM channels WHERE id = ?', channelId);
    if (!channel) return;
    const state = channelState(channel);
    for (const p of players) if (p.channelId === channelId) send(p.socket, state);
  }

  function pushAll() {
    for (const c of db.all('SELECT * FROM channels')) pushChannel(c.id);
    scheduleOverrideExpiry();
  }

  function pushMedia(mediaId) {
    for (const r of db.all('SELECT DISTINCT channel_id FROM playlist_items WHERE media_id = ?', mediaId)) {
      pushChannel(r.channel_id);
    }
    if (activeOverrides().some((o) => o.media_id === mediaId)) pushAll();
  }

  function scheduleOverrideExpiry() {
    clearTimeout(expiryTimer);
    const next = activeOverrides().filter((o) => o.ends_at).map((o) => o.ends_at).sort((a, b) => a - b)[0];
    if (!next) return;
    expiryTimer = setTimeout(() => {
      pushAll();
      adminRefresh('overrides');
    }, Math.min(Math.max(next - Date.now(), 0) + 50, 2 ** 31 - 1));
    expiryTimer.unref?.();
  }

  // Tell admin UIs to refetch; bursts (like heartbeats) collapse into one message.
  function adminRefresh(scope) {
    pendingScopes.add(scope);
    if (adminTimer) return;
    adminTimer = setTimeout(() => {
      adminTimer = null;
      const scopes = [...pendingScopes];
      pendingScopes.clear();
      for (const a of admins) send(a, { type: 'refresh', scopes });
    }, 200);
    adminTimer.unref?.();
  }

  function newPairCode() {
    for (let i = 0; i < 200; i++) {
      const code = String(randomInt(1000, 10000));
      if (!db.get('SELECT 1 AS x FROM screens WHERE pair_code = ?', code)) return code;
    }
    throw new Error('No free pairing codes');
  }

  function hello(conn, msg) {
    const slug = typeof msg.slug === 'string' ? msg.slug : null;
    const channel = slug ? db.get('SELECT * FROM channels WHERE slug = ?', slug) : null;

    if (msg.preview) {
      if (!channel) return send(conn.socket, { type: 'error', message: 'Channel not found' });
      conn.preview = true;
      conn.channelId = channel.id;
      return send(conn.socket, channelState(channel));
    }

    const deviceId = String(msg.deviceId ?? '');
    if (!/^[A-Za-z0-9-]{8,64}$/.test(deviceId)) {
      return send(conn.socket, { type: 'error', message: 'Bad device id' });
    }
    conn.deviceId = deviceId;
    let screen = db.get('SELECT * FROM screens WHERE id = ?', deviceId);
    if (!screen) {
      const count = db.get('SELECT COUNT(*) AS n FROM screens').n;
      db.run(
        'INSERT INTO screens (id, name, created_at, last_seen) VALUES (?, ?, ?, ?)',
        deviceId, `Screen ${count + 1}`, Date.now(), Date.now(),
      );
      screen = db.get('SELECT * FROM screens WHERE id = ?', deviceId);
    }
    if (channel) {
      db.run('UPDATE screens SET channel_id = ?, pair_code = NULL, last_seen = ? WHERE id = ?', channel.id, Date.now(), deviceId);
      conn.channelId = channel.id;
      send(conn.socket, channelState(channel));
    } else if (screen.channel_id) {
      const assigned = db.get('SELECT slug FROM channels WHERE id = ?', screen.channel_id);
      send(conn.socket, { type: 'assign', slug: assigned.slug });
    } else {
      const code = screen.pair_code ?? newPairCode();
      db.run('UPDATE screens SET pair_code = ?, last_seen = ? WHERE id = ?', code, Date.now(), deviceId);
      send(conn.socket, { type: 'pair', code, branding: db.branding(), version: VERSION });
    }
    adminRefresh('screens');
  }

  function heartbeat(conn, msg) {
    if (!conn.deviceId) return;
    const item = typeof msg.item === 'string' ? msg.item.slice(0, 200) : null;
    db.run('UPDATE screens SET last_seen = ?, current_item = ? WHERE id = ?', Date.now(), item, conn.deviceId);
    if (item !== conn.item) adminRefresh('screens');
    conn.item = item;
  }

  function addPlayer(socket) {
    const conn = { socket, channelId: null, deviceId: null, preview: false, item: null, lastMessage: Date.now() };
    players.add(conn);
    socket.on('message', (raw) => {
      conn.lastMessage = Date.now();
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      try {
        if (msg.type === 'hello') hello(conn, msg);
        else if (msg.type === 'hb') heartbeat(conn, msg);
      } catch (err) {
        log.error(err);
      }
    });
    socket.on('close', () => {
      players.delete(conn);
      if (conn.deviceId) adminRefresh('screens');
    });
    socket.on('error', () => {});
  }

  function addAdmin(socket) {
    admins.add(socket);
    socket.on('close', () => admins.delete(socket));
    socket.on('error', () => {});
  }

  const ticker = setInterval(() => {
    const now = Date.now();
    // Pings carry the clock so TVs stay in step across daylight saving and clock changes.
    const clock = wallClock();
    for (const p of players) {
      if (now - p.lastMessage > DEAD_MS) p.socket.terminate();
      else send(p.socket, { type: 'ping', clock });
    }
    for (const a of admins) send(a, { type: 'ping' });
  }, PING_MS);
  ticker.unref?.();

  function sendToDevice(deviceId, msg) {
    for (const p of players) if (p.deviceId === deviceId) send(p.socket, msg);
  }

  // Sent after a screen's channel changes in the admin.
  function assignScreen(deviceId) {
    const screen = db.get('SELECT * FROM screens WHERE id = ?', deviceId);
    if (!screen) return;
    if (screen.channel_id) {
      const c = db.get('SELECT slug FROM channels WHERE id = ?', screen.channel_id);
      sendToDevice(deviceId, { type: 'assign', slug: c.slug });
    } else {
      sendToDevice(deviceId, { type: 'unassign' });
    }
  }

  return {
    addPlayer, addAdmin, pushChannel, pushAll, pushMedia, adminRefresh, assignScreen,
    activeOverrides, overrideChannelIds, scheduleOverrideExpiry,
    isOnline: (deviceId) => [...players].some((p) => p.deviceId === deviceId),
    closeAll() {
      clearInterval(ticker);
      clearTimeout(expiryTimer);
      clearTimeout(adminTimer);
      for (const p of players) p.socket.terminate();
      for (const a of admins) a.terminate();
    },
  };
}
