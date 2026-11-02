import { requireUser, requirePermission, httpError } from '../auth.js';
import { parseStyle, validateStyle } from '../slide-style.js';
import { wallClock } from '../schedule.js';
import { text } from './auth.js';

const json = (t) => ({ id: t.id, name: t.name, builtin: !!t.builtin, style: parseStyle(t.style) ?? {} });

export default async function templateRoutes(app, { db, hub }) {
  const requireSettings = requirePermission('settings.manage');

  const getEditable = (id) => {
    const row = db.get('SELECT * FROM slide_templates WHERE id = ?', Number(id));
    if (!row) throw httpError(404, 'Template not found.');
    if (row.builtin) throw httpError(403, 'Built-in templates cannot be changed or deleted.');
    return row;
  };
  const name = (value, ownId = null) => {
    const v = text(value, 'Name', { max: 60 });
    const clash = db.get('SELECT id FROM slide_templates WHERE name = ?', v);
    if (clash && clash.id !== ownId) throw httpError(409, 'A template with that name already exists.');
    return v;
  };
  // A template doesn't start from another template, so a leftover id is dropped rather than refused.
  const style = (value = null) => {
    const look = Object.prototype.toString.call(value) === '[object Object]' ? { ...value, template: null } : value;
    return JSON.stringify(validateStyle(db, look) ?? {});
  };

  // Everyone signed in can read these: anyone who makes announcements or overrides uses them.
  // The clock lets the designer's preview run a countdown on the host's time, as a TV does.
  app.get('/api/slide-templates', { preHandler: requireUser }, async () => ({
    templates: db.all('SELECT * FROM slide_templates ORDER BY builtin DESC, id').map(json),
    clock: wallClock(),
  }));

  app.post('/api/slide-templates', { preHandler: requireSettings }, async (req) => {
    const b = req.body ?? {};
    const { lastInsertRowid } = db.run('INSERT INTO slide_templates (name, builtin, style) VALUES (?, 0, ?)', name(b.name), style(b.style));
    hub.adminRefresh('templates');
    return json(db.get('SELECT * FROM slide_templates WHERE id = ?', Number(lastInsertRowid)));
  });

  app.patch('/api/slide-templates/:id', { preHandler: requireSettings }, async (req) => {
    const row = getEditable(req.params.id);
    const b = req.body ?? {};
    const newName = b.name === undefined ? row.name : name(b.name, row.id);
    const newStyle = b.style === undefined ? row.style : style(b.style);
    db.run('UPDATE slide_templates SET name = ?, style = ? WHERE id = ?', newName, newStyle, row.id);
    hub.adminRefresh('templates');
    return json(db.get('SELECT * FROM slide_templates WHERE id = ?', row.id));
  });

  // Items keep the look they were given: a style is copied from its template, not linked to it.
  app.delete('/api/slide-templates/:id', { preHandler: requireSettings }, async (req) => {
    const row = getEditable(req.params.id);
    db.run('DELETE FROM slide_templates WHERE id = ?', row.id);
    hub.adminRefresh('templates');
    return { ok: true };
  });
}
