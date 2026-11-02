import net from 'node:net';
import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import { requirePermission, httpError } from '../auth.js';
import { ENCODERS } from '../live/ffmpeg-args.js';
import { text } from './auth.js';

const DEFAULT_KBPS = 6000;
const MIN_KBPS = 500;
const MAX_KBPS = 20000;
const INPUTS = ['rtmp', 'srt', 'device'];
const FIRST_PORT = { rtmp: 1935, srt: 9000 };

// RTMP listens on TCP and SRT on UDP, so the check has to match the protocol.
function portIsFree(port, input) {
  return new Promise((resolve) => {
    if (input === 'srt') {
      const s = dgram.createSocket('udp4');
      s.once('error', () => resolve(false));
      s.bind(port, '0.0.0.0', () => s.close(() => resolve(true)));
    } else {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.listen(port, '0.0.0.0', () => s.close(() => resolve(true)));
    }
  });
}

export default async function liveRoutes(app, { db, hub, live, port: serverPort }) {
  const requireLive = requirePermission('live.manage');
  const json = (row) => {
    const m = db.get('SELECT name, url FROM media WHERE id = ?', row.media_id);
    return {
      id: row.media_id, name: m.name, url: m.url, input: row.input, port: row.port,
      device: row.device, audioDevice: row.audio_device, encoderPreference: row.encoder,
      maxBitrate: row.max_bitrate, enabled: !!row.enabled,
      ...live.describe(row.media_id),
    };
  };
  const getRow = (id) => {
    const row = db.get('SELECT * FROM live_feeds WHERE media_id = ?', String(id));
    if (!row) throw httpError(404, 'Live feed not found.');
    return row;
  };

  // Merges the request onto the current settings, then checks the whole result.
  async function validate(b, current) {
    const merged = {
      input: b.input ?? current?.input,
      port: b.port !== undefined ? b.port : current?.port,
      device: b.device !== undefined ? b.device : current?.device,
      audio_device: b.audioDevice !== undefined ? b.audioDevice : current?.audio_device,
      encoder: b.encoderPreference ?? current?.encoder ?? 'auto',
      max_bitrate: b.maxBitrate ?? current?.max_bitrate ?? DEFAULT_KBPS,
      enabled: b.enabled !== undefined ? (b.enabled ? 1 : 0) : current?.enabled ?? 1,
    };
    if (!INPUTS.includes(merged.input)) throw httpError(400, 'Choose an input type.');
    if (merged.encoder !== 'auto' && !Object.hasOwn(ENCODERS, merged.encoder)) throw httpError(400, 'Unknown encoder.');
    const kbps = Number(merged.max_bitrate);
    if (!Number.isInteger(kbps) || kbps < MIN_KBPS || kbps > MAX_KBPS) throw httpError(400, 'Maximum bitrate must be between 0.5 and 20 Mbps.');
    merged.max_bitrate = kbps;

    if (merged.input === 'device') {
      merged.port = null;
      merged.device = text(merged.device, 'Capture device', { max: 200 });
      merged.audio_device = merged.audio_device ? text(merged.audio_device, 'Audio device', { max: 200 }) : null;
      return merged;
    }
    merged.device = null;
    merged.audio_device = null;
    const port = Number(merged.port);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw httpError(400, 'Port must be a number from 1024 to 65535.');
    if (port === serverPort()) throw httpError(400, `Port ${port} is used by this app's web server. Choose a different port.`);
    const other = db.get('SELECT media_id FROM live_feeds WHERE port = ? AND media_id <> ?', port, current?.media_id ?? '');
    if (other) throw httpError(409, `Port ${port} is already used by another live feed.`);
    merged.port = port;
    const keepsOwnPort = current && current.port === port && current.input === merged.input && current.enabled;
    if (merged.enabled && !keepsOwnPort && !(await portIsFree(port, merged.input))) {
      throw httpError(409, `Port ${port} is being used by another program on this computer. Choose a different port or close that program.`);
    }
    return merged;
  }

  async function assertInputAvailable(input) {
    if (input === 'device') return;
    const caps = await live.capabilities();
    if (!caps[input]) throw httpError(400, `This computer's copy of ffmpeg cannot receive ${input.toUpperCase()}. Choose a different input type.`);
  }

  app.get('/api/live-feeds', { preHandler: requireLive }, async () =>
    db.all('SELECT f.* FROM live_feeds f JOIN media m ON m.id = f.media_id ORDER BY m.created_at, f.media_id').map(json),
  );

  // Only what works on this computer, so the form can hide everything else.
  app.get('/api/live-feeds/options', { preHandler: requireLive }, async () => {
    const [caps, devices] = await Promise.all([live.capabilities(), live.devices()]);
    const used = new Set(db.all('SELECT port FROM live_feeds WHERE port IS NOT NULL').map((r) => r.port));
    const suggest = (start) => {
      let p = start;
      while (used.has(p) || p === serverPort()) p += 1;
      return p;
    };
    return {
      inputs: { rtmp: caps.rtmp, srt: caps.srt, device: devices.supported && devices.video.length > 0 },
      encoders: caps.encoders.map((id) => ({ id, label: ENCODERS[id].label })),
      best: caps.best,
      devices: { video: devices.video, audio: devices.audio },
      suggestedPorts: { rtmp: suggest(FIRST_PORT.rtmp), srt: suggest(FIRST_PORT.srt) },
      maxBitrate: { min: MIN_KBPS, max: MAX_KBPS, default: DEFAULT_KBPS },
    };
  });

  app.post('/api/live-feeds', { preHandler: requireLive }, async (req) => {
    const b = req.body ?? {};
    const name = text(b.name, 'Name', { max: 120 });
    const f = await validate(b, null);
    await assertInputAvailable(f.input);
    const id = randomUUID();
    db.tx(() => {
      db.run(
        `INSERT INTO media (id, type, name, status, url, created_by, created_at) VALUES (?, 'hls', ?, 'ready', ?, ?, ?)`,
        id, name, `/live/${id}/index.m3u8`, req.user.id, Date.now(),
      );
      db.run(
        `INSERT INTO live_feeds (media_id, input, port, device, audio_device, encoder, max_bitrate, enabled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        id, f.input, f.port, f.device, f.audio_device, f.encoder, f.max_bitrate, f.enabled,
      );
    });
    await live.reload(id);
    hub.adminRefresh('media');
    hub.adminRefresh('live');
    return json(getRow(id));
  });

  app.patch('/api/live-feeds/:id', { preHandler: requireLive }, async (req) => {
    const row = getRow(req.params.id);
    const b = req.body ?? {};
    const name = b.name === undefined ? null : text(b.name, 'Name', { max: 120 });
    const f = await validate(b, row);
    if (f.input !== row.input) await assertInputAvailable(f.input);
    const changed = ['input', 'port', 'device', 'audio_device', 'encoder', 'max_bitrate', 'enabled'].some((k) => f[k] !== row[k]);
    if (changed) {
      db.run(
        `UPDATE live_feeds SET input = ?, port = ?, device = ?, audio_device = ?, encoder = ?, max_bitrate = ?, enabled = ? WHERE media_id = ?`,
        f.input, f.port, f.device, f.audio_device, f.encoder, f.max_bitrate, f.enabled, row.media_id,
      );
      await live.reload(row.media_id);
    }
    if (name !== null) {
      db.run('UPDATE media SET name = ?, rev = rev + 1 WHERE id = ? AND name <> ?', name, row.media_id, name);
      hub.pushMedia(row.media_id);
    }
    hub.adminRefresh('media');
    hub.adminRefresh('live');
    hub.adminRefresh('channels');
    return json(getRow(row.media_id));
  });
}
