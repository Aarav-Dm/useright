-- 008: batch-6 fix round 2 (docs/reviews/b6-review-code.md "Fix check - 5a32095" major 1, minor 18).

-- A quote PayPal shows paid but that grant refused (stale branch, withdrawn, refunded before grant) records the
-- PayPal capture it holds, so a later refund of that capture can close the quote. withdraw_state gains 'refunded':
-- the locked payment was refunded/reversed in PayPal and the quote is closed (superseded).
alter table licence_versions
  add column locked_capture_id text,
  drop constraint licence_versions_withdraw_state_check,
  add constraint licence_versions_withdraw_state_check check (withdraw_state in ('done', 'paid', 'refunded'));
create index licence_versions_locked_capture_idx on licence_versions (locked_capture_id) where locked_capture_id is not null;

-- rate_hits is pruned by age on every public request; index it so the prune does not scan the table.
create index rate_hits_at_idx on rate_hits (at);
