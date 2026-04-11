-- Simplify community stats: just spins + live player count from player_secrets.

-- Drop unused columns
alter table community_stats drop column if exists deals_found;
alter table community_stats drop column if exists total_users;

-- Simplify record_scan — no longer tracks deals separately
create or replace function record_scan(found_deal boolean default false)
returns void as $$
begin
  update community_stats
  set total_spins = total_spins + 1
  where id = 1;
end;
$$ language plpgsql security definer;

-- Drop unused function
drop function if exists record_new_user();

-- Live player count from player_secrets (bypasses RLS via security definer)
create or replace function get_player_count()
returns integer as $$
  select count(*)::integer from player_secrets;
$$ language sql security definer;
