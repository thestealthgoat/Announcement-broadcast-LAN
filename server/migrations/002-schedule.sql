-- Per-placement schedules. All empty means the item runs all the time.
ALTER TABLE playlist_items ADD COLUMN start_date TEXT;
ALTER TABLE playlist_items ADD COLUMN end_date TEXT;
ALTER TABLE playlist_items ADD COLUMN start_time TEXT;
ALTER TABLE playlist_items ADD COLUMN end_time TEXT;
ALTER TABLE playlist_items ADD COLUMN days INTEGER;
