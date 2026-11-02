import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { requireUser, requirePermission, httpError, canAddToChannel, canEditMedia, mediaInScope } from '../auth.js';
import { hasPermission } from '../permissions.js';
import { sniffImage } from '../media.js';
import { addToChannel } from './channels.js';
import { parseStyle, validateStyle } from '../slide-style.js';
import { text } from './auth.js';

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|mpe?g|wmv|ts|mts|m2ts|3gp)$/i;

export function mediaJson(m) {
  return {
    id: m.id, type: m.type, name: m.name, status: m.status, error: m.error, progress: m.progress,
    thumb: m.thumb ? `/media/${m.id}/${m.thumb}` : null,
    src: m.file ? `/media/${m.id}/${m.file}` : m.url ?? null,
    duration: m.duration, pages: m.pages, url: m.url, title: m.title, body: m.body, size: m.size,
    style: parseStyle(m.style),
    createdAt: m.created_at,
    createdBy: m.created_by,
    live: isLiveFeedUrl(m.url),
  };
}

// parseWebUrl only accepts absolute addresses, so only a live feed's can look like this.
function isLiveFeedUrl(url) {
  return typeof url === 'string' && url.startsWith('/live/');
}

// Web pages are shown in an iframe, so only plain http(s) pages are allowed, and never YouTube.
export function parseWebUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? '').trim());
  } catch {
    throw httpError(400, 'Enter a full web address, starting with http:// or https://');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw httpError(400, 'Only http:// and https:// addresses are allowed.');
  if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i.test(url.hostname)) throw httpError(400, 'YouTube is not supported.');
  return url;
}

export default async function mediaRoutes(app, { db, hub, processor, live, mediaDir }) {
  const requireUpload = requirePermission('library.upload');
  const insert = (fields) => {
    const id = fields.id ?? randomUUID();
    db.run(
      `INSERT INTO media (id, type, name, status, file, pages, url, title, body, size, style, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, fields.type, fields.name, fields.status ?? 'ready', fields.file ?? null, fields.pages ?? null,
      fields.url ?? null, fields.title ?? null, fields.body ?? null, fields.size ?? null, fields.style ?? null, fields.userId, Date.now(),
    );
    return id;
  };
  const getMedia = (id) => {
    const m = db.get('SELECT * FROM media WHERE id = ?', String(id));
    if (!m) throw httpError(404, 'Library item not found.');
    return m;
  };
  const targetChannel = (req) => {
    if (req.query.channelId === undefined || req.query.channelId === '') return null;
    const id = Number(req.query.channelId);
    if (!db.get('SELECT 1 AS x FROM channels WHERE id = ?', id)) throw httpError(404, 'Channel not found.');
    if (!canAddToChannel(req.user, id)) throw httpError(403, 'You cannot add items to this channel.');
    return id;
  };
  const finish = (id, channelId) => {
    if (channelId) {
      addToChannel(db, channelId, id);
      hub.pushChannel(channelId);
      hub.adminRefresh('channels');
    }
    hub.adminRefresh('media');
    return mediaJson(getMedia(id));
  };
  const styleJson = (value) => {
    const style = validateStyle(db, value ?? null);
    return style ? JSON.stringify(style) : null;
  };
  const assertCanEdit = (req, id) => {
    if (canEditMedia(db, req.user, id)) return;
    throw httpError(403, mediaInScope(db, req.user, id) ? 'You can only change items you uploaded.' : 'This item is also used on channels you do not manage.');
  };

  app.get('/api/media', { preHandler: requireUser }, async () =>
    db.all('SELECT * FROM media ORDER BY created_at DESC, rowid DESC').map((m) => ({ ...mediaJson(m), liveStatus: live.statusOf(m.id) })),
  );

  // Image or video upload, streamed straight to disk.
  app.post('/api/media', { preHandler: requireUpload }, async (req) => {
    const channelId = targetChannel(req);
    const part = await req.file();
    if (!part) throw httpError(400, 'No file was sent.');
    const id = randomUUID();
    const dir = path.join(mediaDir, id);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, 'upload.tmp');
    try {
      await pipeline(part.file, fs.createWriteStream(tmp));
      if (part.file.truncated) throw httpError(413, 'That file is too large.');
      const head = Buffer.alloc(16);
      const fd = fs.openSync(tmp, 'r');
      fs.readSync(fd, head, 0, 16, 0);
      fs.closeSync(fd);

      const original = path.basename(part.filename || 'upload');
      const name = original.replace(/\.[^.]+$/, '').slice(0, 120) || 'Untitled';
      const imageExt = sniffImage(head);
      let type;
      let file;
      if (imageExt) {
        type = 'image';
        file = `image.${imageExt}`;
      } else if (VIDEO_EXT.test(original) || String(part.mimetype).startsWith('video/')) {
        type = 'video';
        file = 'source.bin';
      } else {
        throw httpError(415, 'Use JPG, PNG, WebP or GIF images, or a video file. PDFs upload from the admin page.');
      }
      fs.renameSync(tmp, path.join(dir, file));
      insert({ id, type, name, status: 'processing', file, size: fs.statSync(path.join(dir, file)).size, userId: req.user.id });
      processor.enqueue(id);
      return finish(id, channelId);
    } catch (err) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  });

  // PDFs are rendered to page images by the browser, which keeps the server
  // free of native PDF libraries. Create the item, send each page, then finish.
  app.post('/api/media/pdf', { preHandler: requireUpload }, async (req) => {
    const name = text(req.body?.name, 'Name', { max: 120 });
    const pages = Number(req.body?.pages);
    if (!Number.isInteger(pages) || pages < 1 || pages > 500) throw httpError(400, 'A PDF can have 1 to 500 pages.');
    const id = insert({ type: 'pdf', name, status: 'processing', pages, userId: req.user.id });
    fs.mkdirSync(path.join(mediaDir, id), { recursive: true });
    hub.adminRefresh('media');
    return mediaJson(getMedia(id));
  });

  const getPdfUpload = (req) => {
    const m = getMedia(req.params.id);
    if (m.type !== 'pdf' || m.status !== 'processing') throw httpError(409, 'This PDF is not accepting pages.');
    if (m.created_by !== req.user.id) throw httpError(403, 'Only the uploader can add pages.');
    return m;
  };

  app.post('/api/media/:id/pages/:n', { preHandler: requireUpload }, async (req) => {
    const m = getPdfUpload(req);
    const n = Number(req.params.n);
    if (!Number.isInteger(n) || n < 1 || n > m.pages) throw httpError(400, 'Bad page number.');
    const part = await req.file();
    if (!part) throw httpError(400, 'No page image was sent.');
    const buf = await part.toBuffer();
    if (sniffImage(buf) !== 'jpg') throw httpError(415, 'Page images must be JPEG.');
    fs.writeFileSync(path.join(mediaDir, m.id, `page-${n}.jpg`), buf);
    return { ok: true };
  });

  app.post('/api/media/:id/finish', { preHandler: requireUpload }, async (req) => {
    const channelId = targetChannel(req);
    const m = getPdfUpload(req);
    const dir = path.join(mediaDir, m.id);
    let size = 0;
    for (let n = 1; n <= m.pages; n++) {
      const p = path.join(dir, `page-${n}.jpg`);
      if (!fs.existsSync(p)) throw httpError(400, `Page ${n} is missing.`);
      size += fs.statSync(p).size;
    }
    db.run("UPDATE media SET status = 'ready', thumb = 'page-1.jpg', size = ? WHERE id = ?", size, m.id);
    return finish(m.id, channelId);
  });

  app.post('/api/media/text', { preHandler: requireUpload }, async (req) => {
    const channelId = targetChannel(req);
    const title = text(req.body?.title, 'Title', { max: 200 });
    const body = text(req.body?.body, 'Message', { max: 2000, required: false });
    const style = styleJson(req.body?.style);
    return finish(insert({ type: 'text', name: title.slice(0, 120), title, body, style, userId: req.user.id }), channelId);
  });

  app.post('/api/media/url', { preHandler: requireUpload }, async (req) => {
    const channelId = targetChannel(req);
    const url = parseWebUrl(req.body?.url);
    const name = text(req.body?.name, 'Name', { max: 120, required: false }) || url.hostname;
    const type = url.pathname.toLowerCase().endsWith('.m3u8') ? 'hls' : 'web';
    return finish(insert({ type, name, url: url.href, userId: req.user.id }), channelId);
  });

  app.patch('/api/media/:id', { preHandler: requirePermission('library.edit', 'library.own') }, async (req) => {
    const m = getMedia(req.params.id);
    assertCanEdit(req, m.id);
    const b = req.body ?? {};
    const name = b.name === undefined ? m.name : text(b.name, 'Name', { max: 120 });
    let { title, body, url, style } = m;
    if (m.type === 'text') {
      if (b.title !== undefined) title = text(b.title, 'Title', { max: 200 });
      if (b.body !== undefined) body = text(b.body, 'Message', { max: 2000, required: false });
      if (b.style !== undefined) style = styleJson(b.style);
    } else if (b.style !== undefined) {
      throw httpError(400, 'Only text announcements have a design.');
    }
    if (live.isFeed(m.id)) {
      if (b.url !== undefined && b.url !== m.url) throw httpError(400, "A live feed's address cannot be changed.");
    } else if ((m.type === 'web' || m.type === 'hls') && b.url !== undefined) {
      url = parseWebUrl(b.url).href;
    }
    db.run('UPDATE media SET name = ?, title = ?, body = ?, url = ?, style = ?, rev = rev + 1 WHERE id = ?', name, title, body, url, style, m.id);
    hub.pushMedia(m.id);
    hub.adminRefresh('media');
    hub.adminRefresh('channels');
    return mediaJson(getMedia(m.id));
  });

  // A live feed belongs to whoever manages live feeds, so library permissions alone can't delete one.
  app.delete('/api/media/:id', { preHandler: requirePermission('library.edit', 'library.own', 'live.manage') }, async (req) => {
    const m = getMedia(req.params.id);
    if (!live.isFeed(m.id)) assertCanEdit(req, m.id);
    else if (!hasPermission(req.user, 'live.manage')) throw httpError(403, 'You do not have permission to delete a live feed.');
    else if (!mediaInScope(db, req.user, m.id)) throw httpError(403, 'This item is also used on channels you do not manage.');
    const channels = db.all('SELECT DISTINCT channel_id FROM playlist_items WHERE media_id = ?', m.id);
    const wasOverride = db.get('SELECT 1 AS x FROM overrides WHERE media_id = ? AND cleared_at IS NULL', m.id);
    await live.remove(m.id);
    db.run('DELETE FROM media WHERE id = ?', m.id);
    fs.rmSync(path.join(mediaDir, m.id), { recursive: true, force: true });
    // Any text slide or override might have used a deleted picture as its background.
    if (wasOverride || m.type === 'image') hub.pushAll();
    else for (const c of channels) hub.pushChannel(c.channel_id);
    hub.adminRefresh('media');
    hub.adminRefresh('channels');
    hub.adminRefresh('overrides');
    hub.adminRefresh('live');
    return { ok: true };
  });
}
