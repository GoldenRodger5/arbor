-- Add unique constraint on pair_id so upsert(onConflict: 'pair_id') works correctly.
-- Deduplicate first — keep the row with the latest last_seen_at for each pair_id.
DELETE FROM spread_events
WHERE id NOT IN (
  SELECT DISTINCT ON (pair_id) id
  FROM spread_events
  ORDER BY pair_id, last_seen_at DESC NULLS LAST
);

ALTER TABLE spread_events
  ADD CONSTRAINT spread_events_pair_id_unique UNIQUE (pair_id);
