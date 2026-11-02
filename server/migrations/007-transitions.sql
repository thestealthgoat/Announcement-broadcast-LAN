-- More transitions. Added columns only: rebuilding playlist_items or channels could cascade
-- into playlists. playlist_items.transition keeps its CHECK of cut, fade, or slide, and stays
-- as the fallback. NULL here means "no setting": an item follows its channel, then that fallback.
ALTER TABLE playlist_items ADD COLUMN transition_style TEXT;
ALTER TABLE playlist_items ADD COLUMN transition_ms INTEGER;
ALTER TABLE channels ADD COLUMN default_transition_style TEXT;
ALTER TABLE channels ADD COLUMN default_transition_ms INTEGER;
