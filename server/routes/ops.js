import { requireUser, requirePermission, httpError } from '../auth.js';

export default async function opsRoutes(app, { ops, updater }) {
  app.get('/api/notices', { preHandler: requireUser }, async (req) => ops.notices(req.user));

  app.post('/api/notices/:id/dismiss', { preHandler: requirePermission('screens.manage', 'settings.manage') }, async (req) => {
    if (!ops.dismiss(req.params.id, req.user)) throw httpError(404, 'That notice is not active.');
    return { ok: true };
  });

  app.post('/api/updates/install', { preHandler: requirePermission('settings.manage') }, async () => {
    if (!updater) throw httpError(409, 'This copy can only be updated by hand, from the release page.');
    const update = ops.availableUpdate();
    if (!update) throw httpError(409, 'There is no update to install.');
    return updater.start(update);
  });

  // The admin page polls this through a restart, and reads the new version from it to know it's done.
  app.get('/api/updates/status', { preHandler: requirePermission('settings.manage') }, async () => (
    updater ? updater.status() : { current: ops.version, phase: 'idle', version: null, percent: 0, error: null }
  ));

  app.get('/api/ops/status', { preHandler: requireUser }, async () => ops.status());

  app.put('/api/ops/settings', { preHandler: requirePermission('settings.manage') }, async (req) => {
    const value = req.body?.checkForUpdates;
    if (typeof value !== 'boolean') throw httpError(400, 'Choose on or off for update checks.');
    ops.setCheckForUpdates(value);
    return ops.status();
  });
}
