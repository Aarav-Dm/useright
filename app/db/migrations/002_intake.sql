-- 002_intake: intake, transcript and extraction columns (batch-3 §1, §7 fix 1) + email verifications.

-- Composite keys so child rows stay inside one creator.
alter table briefs add constraint briefs_id_creator_uq unique (id, creator_id);
alter table transcripts add constraint transcripts_id_creator_uq unique (id, creator_id);

alter table briefs
  alter column raw drop not null,
  add column asset_id       uuid,
  add column claimed_sender text,
  add column upload_path    text,
  add column state          text not null default 'awaiting_transcript'
    check (state in ('awaiting_verification', 'awaiting_transcript', 'extracted')),
  add constraint briefs_asset_fk foreign key (asset_id, creator_id) references assets(id, creator_id);
alter table briefs alter column state drop default;
create index briefs_creator_created_idx on briefs (creator_id, created_at); -- rate limit window

alter table transcripts
  add column brief_id     uuid,
  add column lines        jsonb not null default '[]',
  add column confirmed_at timestamptz,
  add constraint transcripts_brief_fk foreign key (brief_id, creator_id) references briefs(id, creator_id);
create index transcripts_brief_idx on transcripts (brief_id, created_at);

alter table extractions
  add column brief_id              uuid,
  add column transcript_id         uuid,
  add column status                text check (status in ('ready', 'needs_creator', 'clarify')),
  add column reasons               text[] not null default '{}',
  add column model                 text,
  add column suggested_price_cents integer, -- stored, never priced (spec §4.4)
  add column clarifying_question   text,
  add column raw_model             jsonb,
  add constraint extractions_brief_fk foreign key (brief_id, creator_id) references briefs(id, creator_id),
  add constraint extractions_transcript_fk foreign key (transcript_id, creator_id) references transcripts(id, creator_id);
create index extractions_brief_idx on extractions (brief_id, created_at);

-- `token` holds the sha256 hex of the one-time token; the raw token only travels in the link.
create table email_verifications (
  token      text primary key,
  creator_id uuid not null references creators(id) on delete cascade,
  email      text not null,
  brief_id   uuid not null,
  expires_at timestamptz not null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  foreign key (brief_id, creator_id) references briefs(id, creator_id)
);
