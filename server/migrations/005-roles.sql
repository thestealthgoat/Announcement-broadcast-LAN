-- Roles replace the fixed admin and editor pair. users.role and users.can_override stay,
-- because rebuilding users would cascade into sessions and user_channels, and they keep a
-- downgrade working. Access is decided from role_id only. server/permissions.js must list
-- these same built-in roles, and test/roles.test.js checks that it does.
CREATE TABLE roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  builtin INTEGER NOT NULL DEFAULT 0,
  permissions TEXT NOT NULL DEFAULT '[]'
);

INSERT INTO roles (id, name, builtin, permissions) VALUES
  (1, 'Admin', 1, '["library.upload","library.own","library.edit","channels.add","channels.edit","channels.manage","channels.all","overrides.push","screens.manage","live.manage","settings.manage","users.manage"]'),
  (2, 'Editor', 1, '["library.upload","library.edit","channels.add","channels.edit"]'),
  (3, 'Editor with Override', 1, '["library.upload","library.edit","channels.add","channels.edit","overrides.push"]'),
  (4, 'Uploader', 1, '["library.upload","library.own","channels.add"]');

ALTER TABLE users ADD COLUMN role_id INTEGER REFERENCES roles(id);

UPDATE users SET role_id = CASE
  WHEN role = 'admin' THEN 1
  WHEN can_override <> 0 THEN 3
  ELSE 2
END;
