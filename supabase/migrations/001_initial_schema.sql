create table market_pairs (
  id uuid primary key default gen_random_uuid(),
  kalshi_market_id text not null,
  kalshi_title text not null,
  kalshi_resolution_criteria text,
  poly_market_id text not null,
  poly_title text not null,
  poly_resolution_criteria text,
  resolution_verdict text check (
    resolution_verdict in
    ('SAFE','CAUTION','SKIP','PENDING')
  ) default 'PENDING',
  verdict_reasoning text,
  risk_factors jsonb,
  match_score float,
  created_at timestamptz default now(),
  last_verified_at timestamptz,
  unique(kalshi_market_id, poly_market_id)
);

create table spread_logs (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid references market_pairs(id),
  poly_yes_price float,
  poly_no_price float,
  kalshi_yes_price float,
  kalshi_no_price float,
  raw_spread float,
  estimated_fees float,
  net_spread float,
  available_quantity float,
  max_profit_dollars float,
  scanned_at timestamptz default now()
);

create table positions (
  id uuid primary key default gen_random_uuid(),
  pair_id uuid references market_pairs(id),
  poly_leg text,
  poly_entry_price float,
  kalshi_leg text,
  kalshi_entry_price float,
  contracts float,
  capital_deployed float,
  status text check (
    status in ('OPEN','SETTLED','DISPUTED')
  ) default 'OPEN',
  unrealized_pnl float default 0,
  realized_pnl float,
  expected_settlement timestamptz,
  opened_at timestamptz default now(),
  settled_at timestamptz
);

create table capital_ledger (
  id uuid primary key default gen_random_uuid(),
  total_capital float not null default 500,
  deployed_capital float default 0,
  safety_reserve_pct float default 0.20,
  realized_pnl float default 0,
  updated_at timestamptz default now()
);
