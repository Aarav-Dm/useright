-- 004: the address an invoice was actually sent to (B5 review 8). Batch 6's grant check compares
-- PayPal's primary recipient with this saved value, not with the client's current email.
alter table invoices add column recipient_email text;

-- B5 review 9: when an autopilot send actually went out. R3 counts sent rows by this time, so a send
-- reserved before midnight and sent after it counts on the day it was sent.
alter table autopilot_sends add column sent_at timestamptz;
