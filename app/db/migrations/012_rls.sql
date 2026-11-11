-- Deny API-role access by default. The server's database owner bypasses RLS.
-- No public policies: clients use the authenticated application routes.
alter table public.schema_migrations enable row level security;
alter table public.creators enable row level security;
alter table public.creator_settings enable row level security;
alter table public.clients enable row level security;
alter table public.assets enable row level security;
alter table public.rate_card_options enable row level security;
alter table public.briefs enable row level security;
alter table public.transcripts enable row level security;
alter table public.extractions enable row level security;
alter table public.licence_versions enable row level security;
alter table public.invoices enable row level security;
alter table public.orders enable row level security;
alter table public.payments enable row level security;
alter table public.approvals enable row level security;
alter table public.autopilot_sends enable row level security;
alter table public.scheduled_actions enable row level security;
alter table public.receipts enable row level security;
alter table public.events enable row level security;
alter table public.webhook_events enable row level security;
alter table public.email_verifications enable row level security;
alter table public.download_tokens enable row level security;
alter table public.rate_hits enable row level security;
alter table public.capture_reversals enable row level security;
alter table public.demo_clock enable row level security;
