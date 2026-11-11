-- 006: when a send or recovery last claimed this invoice row (batch-5 review re-check 2). A claim younger than
-- 2 minutes blocks Retry, Cancel and a second recovery; an older one is treated as abandoned.
alter table invoices add column attempt_at timestamptz;
