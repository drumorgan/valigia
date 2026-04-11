-- Drop unused tables
-- secret_audit_log: write-only, never read, grows on every API call
-- abroad_prices: replaced by YATA community API, table is empty

drop table if exists secret_audit_log;
drop table if exists abroad_prices;
