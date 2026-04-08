-- Add capital-efficiency stats columns to scan_results.
-- avg_days_to_close: mean days-to-settlement across all matched pairs
--                    (computed before the date filter is applied)
-- pairs_filtered_by_date: number of pairs dropped because either market
--                         closes outside the [MIN_DAYS_TO_CLOSE,
--                         MAX_DAYS_TO_CLOSE] window
-- The edge function falls back gracefully if these columns are missing,
-- so the migration is safe to run lazily.

alter table scan_results
  add column if not exists avg_days_to_close numeric default 0,
  add column if not exists pairs_filtered_by_date int default 0;
