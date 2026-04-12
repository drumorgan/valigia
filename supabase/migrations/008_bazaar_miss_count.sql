-- Add miss_count to bazaar_prices so the scanner can prune dead entries.
-- A bazaar that returns no watchlist items on 3 consecutive checks is
-- likely closed, moved inventory, or never actually stocked the item we
-- thought it did. Pruning keeps the pool lean and the check budget focused.

alter table bazaar_prices
  add column if not exists miss_count integer not null default 0;

-- Allow anyone to delete (pruning runs from the client).
drop policy if exists "Anyone can delete bazaar prices" on bazaar_prices;
create policy "Anyone can delete bazaar prices"
  on bazaar_prices for delete using (true);
