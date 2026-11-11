-- Page confirmation acknowledges the request; it never proves ownership of an email address.
alter table email_verifications add column confirmation_channel text not null default 'email'
  check (confirmation_channel in ('email', 'page'));
alter table briefs add column confirmed_on_page boolean not null default false;
