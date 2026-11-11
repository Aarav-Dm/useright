-- 001_init: UseRight schema (batch-2 §5, spec §7). Plain Postgres 16; runs on Supabase and PGlite.
-- Money is integer cents. Every creator-owned table carries creator_id, and child rows are
-- tied to their parent's creator by composite foreign keys so rows cannot cross creators.

create type licence_status as enum ('draft', 'pending', 'active', 'superseded', 'expired', 'refunded');

create table creators (
  id         uuid primary key default gen_random_uuid(),
  slug       text not null unique,
  name       text not null,
  email      text not null,
  created_at timestamptz not null default now()
);

create table creator_settings (
  creator_id          uuid primary key references creators(id) on delete cascade,
  per_deal_cap_cents  integer not null check (per_deal_cap_cents >= 0),
  daily_max_sends     integer not null check (daily_max_sends >= 0),
  rolling30_cap_cents integer not null check (rolling30_cap_cents >= 0),
  auto_channels       text[] not null default '{}',
  ask_channels        text[] not null default '{}',
  timezone            text not null
);

create table clients (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  name       text not null,
  email      text not null,
  allowed    boolean not null default false,
  created_at timestamptz not null default now(),
  unique (id, creator_id)
);
create unique index clients_creator_email_uq on clients (creator_id, lower(email));

create table assets (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references creators(id) on delete cascade,
  title        text not null,
  key_original text not null,
  key_web      text not null,
  key_print    text not null,
  key_preview  text not null,
  file_hash    text not null,
  is_public    boolean not null default false,
  created_at   timestamptz not null default now(),
  unique (id, creator_id)
);

create table rate_card_options (
  creator_id uuid not null references creators(id) on delete cascade,
  option_id  text not null,
  kind       text not null check (kind in ('channel', 'territory', 'duration')),
  cents      integer not null check (cents >= 0),
  primary key (creator_id, option_id)
);

create table briefs (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  client_id  uuid,
  source     text not null,
  raw        text not null,
  created_at timestamptz not null default now(),
  foreign key (client_id, creator_id) references clients(id, creator_id)
);

create table transcripts (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  client_id  uuid,
  source     text not null,
  raw        text not null,
  created_at timestamptz not null default now(),
  foreign key (client_id, creator_id) references clients(id, creator_id)
);

create table extractions (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  client_id  uuid,
  source     text not null,
  raw        jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (client_id, creator_id) references clients(id, creator_id)
);

create table licence_versions (
  id             uuid primary key default gen_random_uuid(),
  creator_id     uuid not null references creators(id) on delete cascade,
  client_id      uuid not null,
  asset_id       uuid not null,
  parent_id      uuid,
  version_no     integer not null check (version_no >= 1),
  scope          jsonb not null,
  rate_card      jsonb not null, -- frozen at creation
  total_cents    integer not null check (total_cents >= 0),
  paid_cents     integer not null default 0 check (paid_cents >= 0),
  rail           text check (rail in ('invoice', 'order')),
  start_at       timestamptz,
  end_at         timestamptz,
  renewal_opt_in boolean not null default false,
  content_hash   text,
  status         licence_status not null default 'draft',
  created_at     timestamptz not null default now(),
  unique (id, creator_id),
  check ((version_no = 1) = (parent_id is null)),
  check (end_at is null or start_at is null or end_at > start_at),
  foreign key (client_id, creator_id) references clients(id, creator_id),
  foreign key (asset_id, creator_id) references assets(id, creator_id),
  foreign key (parent_id, creator_id) references licence_versions(id, creator_id)
);
create index licence_versions_client_idx on licence_versions (creator_id, client_id);

-- Payable objects. A version has at most one non-cancelled payable object across both rails (spec Y1).
-- The app stores state 'cancelled' for a cancelled invoice and a voided order.
create table invoices (
  id                uuid primary key default gen_random_uuid(),
  creator_id        uuid not null,
  version_id        uuid not null,
  invoice_number    text not null unique check (invoice_number ~ '^UR-[0-9a-f]{22}$'), -- 25 chars
  paypal_invoice_id text unique,
  state             text not null,
  created_at        timestamptz not null default now(),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);
create unique index invoices_one_open_per_version on invoices (version_id) where state <> 'cancelled';

create table orders (
  id              uuid primary key default gen_random_uuid(),
  creator_id      uuid not null,
  version_id      uuid not null,
  paypal_order_id text unique,
  custom_id       text not null,
  state           text not null,
  created_at      timestamptz not null default now(),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);
create unique index orders_one_open_per_version on orders (version_id) where state <> 'cancelled';

-- The partial indexes cover each table; this trigger covers the pair. It locks the version row
-- first so two concurrent inserts on different rails cannot both pass.
create function enforce_one_payable() returns trigger language plpgsql as $$
begin
  if new.state = 'cancelled' then
    return new;
  end if;
  perform 1 from licence_versions where id = new.version_id for update;
  if tg_table_name = 'invoices' then
    if exists (select 1 from orders where version_id = new.version_id and state <> 'cancelled') then
      raise exception 'version % already has an open order', new.version_id using errcode = 'unique_violation';
    end if;
  else
    if exists (select 1 from invoices where version_id = new.version_id and state <> 'cancelled') then
      raise exception 'version % already has an open invoice', new.version_id using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end $$;

create trigger invoices_one_payable before insert or update of state, version_id on invoices
  for each row execute function enforce_one_payable();
create trigger orders_one_payable before insert or update of state, version_id on orders
  for each row execute function enforce_one_payable();

create table payments (
  id            uuid primary key default gen_random_uuid(),
  creator_id    uuid not null,
  version_id    uuid not null,
  paypal_txn_id text not null unique,
  amount_cents  integer not null check (amount_cents >= 0),
  currency      char(3) not null,
  payer_email   text,
  created_at    timestamptz not null default now(),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);

create table approvals (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null,
  version_id   uuid not null,
  version_hash text not null,
  amount_cents integer not null check (amount_cents >= 0),
  recipient    text not null,
  created_at   timestamptz not null default now(),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);

create table autopilot_sends (
  id           uuid primary key default gen_random_uuid(),
  creator_id   uuid not null references creators(id) on delete cascade,
  client_id    uuid not null,
  version_id   uuid not null,
  status       text not null check (status in ('reserved', 'sent', 'released')),
  amount_cents integer not null check (amount_cents >= 0),
  expires_at   timestamptz,
  created_at   timestamptz not null default now(),
  foreign key (client_id, creator_id) references clients(id, creator_id),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);
create index autopilot_sends_window_idx on autopilot_sends (creator_id, client_id, created_at);

create table scheduled_actions (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  version_id uuid,
  kind       text not null,
  run_at     timestamptz not null,
  done_at    timestamptz,
  created_at timestamptz not null default now(),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);
create index scheduled_actions_due_idx on scheduled_actions (run_at) where done_at is null;

create table receipts (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null,
  version_id uuid not null,
  status     licence_status not null,
  public_id  text not null unique,
  body       jsonb not null,
  created_at timestamptz not null default now(),
  foreign key (version_id, creator_id) references licence_versions(id, creator_id)
);

create table events (
  id         uuid primary key default gen_random_uuid(),
  creator_id uuid not null references creators(id) on delete cascade,
  kind       text not null,
  rule       text,
  detail     jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index events_creator_idx on events (creator_id, created_at);

create table webhook_events (
  event_id    text primary key,
  type        text not null,
  received_at timestamptz not null default now()
);
