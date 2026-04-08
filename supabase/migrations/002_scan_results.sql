-- scan_results: latest scanner output written by the edge function.
-- The edge function trims the table to the most recent 10 rows after each insert.

create table scan_results (
  id uuid primary key default gen_random_uuid(),
  opportunities jsonb not null default '[]',
  kalshi_count int default 0,
  poly_count int default 0,
  matched_count int default 0,
  opportunity_count int default 0,
  scanned_at timestamptz default now()
);

create index scan_results_scanned_at_desc on scan_results (scanned_at desc);

-- Anon role can read latest results for the frontend.
alter table scan_results enable row level security;

create policy "scan_results readable by anon"
  on scan_results
  for select
  to anon
  using (true);
