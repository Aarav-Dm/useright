-- 007: batch-6 review fixes (docs/reviews/b6-final-fixes.md F1, F3, F4).

-- F1: a pending quote built on a licence that was refunded is withdrawn under the creator lock before its PayPal
-- invoice is cancelled. withdrawn_at makes it ineligible for grant at once; withdraw_state records the cleanup:
-- null = still to cancel at PayPal (retried), 'done' = cancelled and its reservation released, 'paid' = PayPal
-- already shows a payment (creator alert, never activated).
alter table licence_versions
  add column withdrawn_at   timestamptz,
  add column withdraw_state text check (withdraw_state in ('done', 'paid'));
create index licence_versions_withdraw_idx on licence_versions (creator_id) where withdrawn_at is not null and withdraw_state is null;

-- F3: one current licence branch per client + photo. Grant supersedes the parent before activating the child.
create unique index licence_versions_one_active on licence_versions (client_id, asset_id) where status = 'active';

-- F4: a verified refund/reversal whose capture is not mapped to a payment yet. Grant checks this table (under a
-- per-capture advisory lock shared with the webhook) so a capture PayPal already revoked never becomes a usable grant.
create table capture_reversals (
  capture_id  text primary key,
  status      text not null,
  event_id    text,
  received_at timestamptz not null default now(),
  resolved_at timestamptz
);
