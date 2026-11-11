-- 010_b8_renewal: batch 8 (renewal + demo clock, docs/batch-8.md). Add only: one column, one index, one table.

-- A renewal version points at the licence it renews. At most one renewal per licence, ever: the tick never makes a
-- second one, even after the first was rejected or withdrawn.
alter table licence_versions add column renewal_of uuid references licence_versions(id);
create unique index licence_versions_one_renewal on licence_versions (renewal_of) where renewal_of is not null;

-- The demo clock: one row, an offset added to real time in demo mode only. It only moves forward.
create table demo_clock (
  id         boolean primary key default true check (id),
  offset_ms  bigint not null default 0 check (offset_ms >= 0),
  updated_at timestamptz not null default now()
);
