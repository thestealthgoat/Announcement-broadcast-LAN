-- A live feed is a library item of the existing `hls` type plus one row here.
-- The feed's name lives on the media row, so a rename from the library needs no sync.
CREATE TABLE live_feeds (
  media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
  input TEXT NOT NULL CHECK (input IN ('rtmp','srt','device')),
  port INTEGER UNIQUE,
  device TEXT,
  audio_device TEXT,
  encoder TEXT NOT NULL DEFAULT 'auto',
  max_bitrate INTEGER NOT NULL DEFAULT 6000,
  enabled INTEGER NOT NULL DEFAULT 1,
  CHECK ((input = 'device' AND port IS NULL AND device IS NOT NULL) OR (input <> 'device' AND port IS NOT NULL))
);
