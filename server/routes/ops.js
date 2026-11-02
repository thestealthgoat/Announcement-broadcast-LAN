import { requireUser, requireAdmin, httpError } from '../auth.js';

export default async function opsRoutes(app, { ops }) {
  app.get('/api/notices', { preHandler: requireUser }, async (req) => ops.notices(req.user));

  app.post('/api/notices/:id/dismiss', { preHandler: requireAdmin }, async (req) => {
    if (!ops.dismiss(req.params.id)) throw httpError(404, 'That notice is not active.');
    return { ok: true };
  });

  app.get('/api/ops/status', { preHandler: requireUser }, async () => ops.status());

  app.put('/api/ops/settings', { preHandler: requireAdmin }, async (req) => {
    const value = req.body?.checkForUpdates;
    if (typeof value !== 'boolean') throw httpError(400, 'Choose on or off for update checks.');
    ops.setCheckForUpdates(value);
    return ops.status();
  });
}
