-- Library organization. Only adds columns, tables, and indexes: rebuilding media would cascade into playlists.

-- One flat list of folders, which is what fits a picker on a phone.
CREATE TABLE folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

-- Deleting a folder moves its items back to the top level.
ALTER TABLE media ADD COLUMN folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;

-- The uploaded file's hash, for spotting duplicates. NULL for PDFs, text, and web items, and until
-- the background pass reaches an item from before this version.
ALTER TABLE media ADD COLUMN sha256 TEXT;

CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  created_at INTEGER NOT NULL
);

-- Removing an item or a tag only removes the link between them.
CREATE TABLE media_tags (
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (media_id, tag_id)
);

CREATE INDEX media_tags_tag ON media_tags(tag_id);
CREATE INDEX media_folder ON media(folder_id);
CREATE INDEX media_sha256 ON media(sha256);
CREATE INDEX media_created ON media(created_at);
CREATE INDEX playlist_items_media ON playlist_items(media_id);
CREATE INDEX overrides_media ON overrides(media_id);
