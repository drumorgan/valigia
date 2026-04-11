-- bazaar_prices — shared crowd-sourced pool of bazaar listings.
-- Every user's scan contributes data; every user benefits from the pool.
-- Over time the system learns which bazaars carry which items and at what price.

create table bazaar_prices (
  item_id         integer not null,
  bazaar_owner_id integer not null,
  price           integer,
  quantity        integer default 1,
  checked_at      timestamptz not null default now(),
  primary key (item_id, bazaar_owner_id)
);

-- Index for efficient "cheapest bazaar for item X" queries
create index idx_bazaar_prices_item_price on bazaar_prices (item_id, price)
  where price is not null;

-- Index for "least recently checked" rotation strategy
create index idx_bazaar_prices_staleness on bazaar_prices (checked_at);

alter table bazaar_prices enable row level security;

create policy "Anyone can read bazaar prices"
  on bazaar_prices for select using (true);

create policy "Anyone can insert bazaar prices"
  on bazaar_prices for insert with check (true);

create policy "Anyone can update bazaar prices"
  on bazaar_prices for update using (true);
