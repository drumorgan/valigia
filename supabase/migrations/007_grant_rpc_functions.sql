-- Grant execute on stats functions to anon and authenticated roles.
-- Without this, the Supabase client (using anon key) can't call them.

grant execute on function record_scan(boolean) to anon;
grant execute on function record_scan(boolean) to authenticated;
grant execute on function get_player_count() to anon;
grant execute on function get_player_count() to authenticated;
