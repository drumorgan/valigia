-- community_stats — single-row table tracking community activity.
-- Encourages sharing by showing how many people are contributing.

create table community_stats (
  id            integer primary key default 1 check (id = 1),
  total_spins   integer not null default 0,
  deals_found   integer not null default 0,
  total_users   integer not null default 0
);

-- Seed the single row
insert into community_stats (id) values (1);

alter table community_stats enable row level security;

-- Anyone can read stats
create policy "Anyone can read community stats"
  on community_stats for select using (true);

-- Anyone can update stats (increment via function)
create policy "Anyone can update community stats"
  on community_stats for update using (true);

-- Atomic increment after each scan
create or replace function record_scan(found_deal boolean default false)
returns void as $$
begin
  update community_stats
  set total_spins = total_spins + 1,
      deals_found = deals_found + (case when found_deal then 1 else 0 end)
  where id = 1;
end;
$$ language plpgsql security definer;

-- Atomic increment for new users (called on first login only)
create or replace function record_new_user()
returns void as $$
begin
  update community_stats
  set total_users = total_users + 1
  where id = 1;
end;
$$ language plpgsql security definer;
