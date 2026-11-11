-- 003_policy: licence version drafts, policy results, invoice send lifecycle (batch-5 §1-§4, §7 fixes 1, 2).

alter table licence_versions
  add column brief_id      uuid,
  add column extraction_id uuid references extractions(id),
  add column policy        jsonb,                          -- last evaluate() result
  add column send_state    text not null default 'idle' check (send_state in ('idle', 'sending', 'sent', 'failed')),
  add column send_error    text,                           -- plain words, never secrets or emails
  add column rejected_at   timestamptz,
  add constraint licence_versions_brief_fk foreign key (brief_id, creator_id) references briefs(id, creator_id);
-- Fix 1: one pending version per extraction, so a duplicate decide/approve reuses it (same invoice_number).
create unique index licence_versions_one_pending_per_extraction on licence_versions (extraction_id) where status = 'pending';
create index licence_versions_brief_idx on licence_versions (brief_id, created_at);

-- Rejection with or without a version (batch-5 §3, fix 7).
alter table briefs add column rejected_at timestamptz;

-- Fix 2. invoices_one_open_per_version (001) stays the one-invoice backstop.
alter table invoices
  add column payer_url text,
  add column sent_at   timestamptz,
  add column error     text,
  add constraint invoices_state_check check (state in ('creating', 'created', 'sent', 'cancelled'));

-- At most one live autopilot reservation or send per version.
create unique index autopilot_sends_one_live_per_version on autopilot_sends (version_id) where status in ('reserved', 'sent');
