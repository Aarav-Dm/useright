-- 005_payments: grantIfPaid, client pay page, downloads, receipts, webhooks (batch-6 §1-§6, §8 fix 1).

-- Invoice lifecycle adds paid and refunded. The pay page token is stored hashed (lookup) and encrypted with
-- APP_SECRET (so the deal room can show the same link again, fix 9). last_checked_at throttles PayPal re-checks.
alter table invoices drop constraint invoices_state_check;
alter table invoices
  add constraint invoices_state_check check (state in ('creating', 'created', 'sent', 'paid', 'refunded', 'cancelled')),
  add column pay_token_hash  text unique,
  add column pay_token_enc   text,
  add column last_checked_at timestamptz;

-- Payment date from PayPal (licence start is that date's midnight in the creator's timezone).
alter table payments add column paid_at timestamptz;

-- Download tokens (fixes 12, 22): 32 random bytes, sha256 at rest, 3 uses within 5 minutes.
create table download_tokens (
  token_hash text primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  version_id uuid not null,
  file       text not null check (file in ('web', 'print')),
  expires_at timestamptz not null,
  uses       integer not null default 0,
  voided_at  timestamptz,
  created_at timestamptz not null default now(),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);
create index download_tokens_version_idx on download_tokens (version_id);

-- Webhook processing state (fix 8): processed_at only on success; failures in error.
alter table webhook_events
  add column resource_id  text,
  add column processed_at timestamptz,
  add column error        text;

-- Per-IP request budgets for public pages (fix 10). Only a hash of the address is stored.
create table rate_hits (
  kind    text not null,
  ip_hash text not null,
  at      timestamptz not null default now()
);
create index rate_hits_idx on rate_hits (kind, ip_hash, at);

create index receipts_version_idx on receipts (version_id, created_at);
