-- sell_prices — shared cache of Torn item market sell prices.
-- Any user who fetches a sell price writes it here for everyone.

create table sell_prices (
  item_id      integer primary key,
  price        integer,
  updated_at   timestamptz not null default now()
);

alter table sell_prices enable row level security;

create policy "Anyone can read sell prices"
  on sell_prices for select using (true);

create policy "Anyone can upsert sell prices"
  on sell_prices for insert with check (true);

create policy "Anyone can update sell prices"
  on sell_prices for update using (true);
