-- The announcement designer. A NULL style means the slide follows branding, as it always has.
-- The built-in template styles must pass validateStyle in server/slide-style.js, and
-- test/designer.test.js checks that they do.
ALTER TABLE media ADD COLUMN style TEXT;
ALTER TABLE overrides ADD COLUMN style TEXT;

CREATE TABLE slide_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  builtin INTEGER NOT NULL DEFAULT 0,
  style TEXT NOT NULL DEFAULT '{}'
);

INSERT INTO slide_templates (id, name, builtin, style) VALUES
  (1, 'Emergency', 1, '{"background":{"type":"solid","color":"#b91c1c"},"textColor":"#ffffff","accentColor":"#fde047","titleSize":"large","bodySize":"large"}'),
  (2, 'Weather', 1, '{"background":{"type":"gradient","from":"#0c4a6e","to":"#1e293b"},"textColor":"#ffffff","accentColor":"#7dd3fc"}'),
  (3, 'Schedule change', 1, '{"background":{"type":"solid","color":"#fbbf24"},"textColor":"#111827","accentColor":"#111827"}'),
  (4, 'Game day', 1, '{"background":{"type":"gradient","from":"#7f1d1d","to":"#111827"},"textColor":"#ffffff","accentColor":"#fbbf24","titleSize":"large"}'),
  (5, 'General', 1, '{}');
