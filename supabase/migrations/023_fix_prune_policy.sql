-- Valigia — fix the bazaar_prices prune DELETE policy.
--
-- Migration 021 (rls_hardening) narrowed the anon DELETE policy to USING (miss_count >= 3)
-- on the assumption that MAX_MISS_COUNT = 3 meant rows are deletable once
-- their stored miss_count reaches 3. That misread the scanner's flow.
--
-- In src/bazaar-scanner.js the prune gate is:
--   if (pair.miss_count + 1 >= MAX_MISS_COUNT) toPrune.push(pair)
--
-- So a row whose stored miss_count is MAX_MISS_COUNT - 1 (i.e. 2) is what
-- the scanner tries to delete — it would be its third consecutive miss, so
-- instead of incrementing to 3 we remove it. With MAX_MISS_COUNT held
-- constant at 3, the policy needs to allow deletes at miss_count >= 2.
--
-- Without this fix those rows silently fail to delete (Supabase RLS returns
-- no error, just 0 rows affected), so the pool accumulates stuck-at-2
-- entries instead of pruning them.
--
-- Run this in the Supabase Dashboard SQL Editor.

drop policy if exists "Anyone can delete stale bazaar prices" on bazaar_prices;
create policy "Anyone can delete stale bazaar prices"
  on bazaar_prices for delete
  using (miss_count >= 2);
