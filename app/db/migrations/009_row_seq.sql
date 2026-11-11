-- 009: insertion order (batch-6 round 2 test stability).
-- "Latest row" lookups ordered by created_at, then by a random uuid. created_at ties whenever two rows are written in
-- the same clock tick (PGlite's clock has millisecond resolution) or in one transaction (now() is the transaction
-- start), so "latest" was a coin toss: e.g. the draft transcript instead of the confirmed one. seq is a monotonic
-- insertion counter; every "latest" / "in order" query uses it. Existing rows are numbered in created_at order.
alter table briefs              add column seq bigint;
alter table transcripts         add column seq bigint;
alter table extractions         add column seq bigint;
alter table licence_versions    add column seq bigint;
alter table invoices            add column seq bigint;
alter table payments            add column seq bigint;
alter table receipts            add column seq bigint;
alter table events              add column seq bigint;
alter table autopilot_sends     add column seq bigint;
alter table email_verifications add column seq bigint;

create sequence row_seq;
update briefs              set seq = s.n from (select id, row_number() over (order by created_at, id) as n from briefs) s where s.id = briefs.id;
update transcripts         set seq = s.n from (select id, row_number() over (order by created_at, id) as n from transcripts) s where s.id = transcripts.id;
update extractions         set seq = s.n from (select id, row_number() over (order by created_at, id) as n from extractions) s where s.id = extractions.id;
update licence_versions    set seq = s.n from (select id, row_number() over (order by created_at, id) as n from licence_versions) s where s.id = licence_versions.id;
update invoices            set seq = s.n from (select id, row_number() over (order by created_at, id) as n from invoices) s where s.id = invoices.id;
update payments            set seq = s.n from (select id, row_number() over (order by created_at, id) as n from payments) s where s.id = payments.id;
update receipts            set seq = s.n from (select id, row_number() over (order by created_at, id) as n from receipts) s where s.id = receipts.id;
update events              set seq = s.n from (select id, row_number() over (order by created_at, id) as n from events) s where s.id = events.id;
update autopilot_sends     set seq = s.n from (select id, row_number() over (order by created_at, id) as n from autopilot_sends) s where s.id = autopilot_sends.id;
update email_verifications set seq = s.n from (select token, row_number() over (order by created_at, token) as n from email_verifications) s where s.token = email_verifications.token;
select setval('row_seq', greatest(1, (select coalesce(max(m), 0) from (
  select max(seq) as m from briefs union all select max(seq) from transcripts union all select max(seq) from extractions
  union all select max(seq) from licence_versions union all select max(seq) from invoices union all select max(seq) from payments
  union all select max(seq) from receipts union all select max(seq) from events union all select max(seq) from autopilot_sends
  union all select max(seq) from email_verifications) x)));

alter table briefs              alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table transcripts         alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table extractions         alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table licence_versions    alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table invoices            alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table payments            alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table receipts            alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table events              alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table autopilot_sends     alter column seq set default nextval('row_seq'), alter column seq set not null;
alter table email_verifications alter column seq set default nextval('row_seq'), alter column seq set not null;

create index transcripts_brief_seq_idx      on transcripts (brief_id, seq);
create index extractions_brief_seq_idx      on extractions (brief_id, seq);
create index licence_versions_brief_seq_idx on licence_versions (brief_id, seq);
create index invoices_version_seq_idx       on invoices (version_id, seq);
create index events_creator_seq_idx         on events (creator_id, seq);
