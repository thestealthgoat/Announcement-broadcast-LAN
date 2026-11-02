import fs from 'node:fs';
import path from 'node:path';
import { requirePermission, httpError } from '../auth.js';
import { sniffImage } from '../media.js';
import { text } from './auth.js';

const HEX = /^#[0-9a-f]{6}$/i;
const FONT_EXT = /\.(woff2?|ttf|otf)$/i;

export default async function settingsRoutes(app, { db, hub, mediaDir }) {
  const requireSettings = requirePermission('settings.manage');
  const brandDir = path.join(mediaDir, 'branding');
  const save = (patch) => {
    db.setSetting('branding', { ...db.branding(), ...patch });
    hub.pushAll();
    hub.adminRefresh('branding');
    return db.branding();
  };
  const replaceFile = (previous, name, buf) => {
    fs.mkdirSync(brandDir, { recursive: true });
    fs.writeFileSync(path.join(brandDir, name), buf);
    if (previous) fs.rmSync(path.join(brandDir, path.basename(previous)), { force: true });
    return `/media/branding/${name}`;
  };

  app.get('/api/branding', async () => db.branding());

  app.put('/api/branding', { preHandler: requireSettings }, async (req) => {
    const b = req.body ?? {};
    const patch = {};
    if (b.orgName !== undefined) patch.orgName = text(b.orgName, 'Organization name', { max: 100 });
    for (const key of ['primaryColor', 'accentColor', 'textColor']) {
      if (b[key] !== undefined) {
        if (!HEX.test(b[key])) throw httpError(400, 'Colors must look like #1f2937.');
        patch[key] = b[key];
      }
    }
    if (b.fontMode !== undefined) {
      if (!['system', 'google', 'upload'].includes(b.fontMode)) throw httpError(400, 'Unknown font mode.');
      patch.fontMode = b.fontMode;
    }
    if (b.fontFamily !== undefined) {
      const family = String(b.fontFamily).trim();
      if (family && !/^[A-Za-z0-9 -]{1,60}$/.test(family)) throw httpError(400, 'Enter a Google Font name, like Roboto Slab.');
      patch.fontFamily = family;
    }
    if (patch.fontMode === 'google' && !(patch.fontFamily ?? db.branding().fontFamily)) throw httpError(400, 'Enter a Google Font name.');
    return save(patch);
  });

  app.post('/api/branding/logo', { preHandler: requireSettings }, async (req) => {
    const part = await req.file();
    if (!part) throw httpError(400, 'No file was sent.');
    const buf = await part.toBuffer();
    const ext = sniffImage(buf);
    if (!ext) throw httpError(415, 'Logos must be PNG, JPG, WebP or GIF.');
    return save({ logo: replaceFile(db.branding().logo, `logo-${Date.now()}.${ext}`, buf) });
  });

  app.delete('/api/branding/logo', { preHandler: requireSettings }, async () => {
    const { logo } = db.branding();
    if (logo) fs.rmSync(path.join(brandDir, path.basename(logo)), { force: true });
    return save({ logo: null });
  });

  app.post('/api/branding/font', { preHandler: requireSettings }, async (req) => {
    const part = await req.file();
    if (!part) throw httpError(400, 'No file was sent.');
    const match = String(part.filename).match(FONT_EXT);
    if (!match) throw httpError(415, 'Fonts must be WOFF2, WOFF, TTF or OTF.');
    const buf = await part.toBuffer();
    const fontFile = replaceFile(db.branding().fontFile, `font-${Date.now()}${match[0].toLowerCase()}`, buf);
    return save({ fontFile, fontMode: 'upload' });
  });
}
