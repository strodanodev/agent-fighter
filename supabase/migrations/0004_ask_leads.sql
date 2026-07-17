-- Landing-page Ask gate leads (email + reason). Optional table form of the
-- same data the marketing site can also store in the private `ask-leads`
-- Storage bucket when this table is not yet applied.
--
-- Run in the Supabase SQL editor (or `supabase db push`).

create table if not exists ask_leads (
  id         uuid primary key default gen_random_uuid(),
  email      text not null,
  reason     text not null
               check (reason in (
                 'Investor',
                 'VC',
                 'Brand Sponsor',
                 'Content Creator',
                 'Other'
               )),
  created_at timestamptz not null default now(),
  user_agent text,
  referrer   text
);

create index if not exists ask_leads_created_at_idx on ask_leads (created_at desc);
create index if not exists ask_leads_email_idx on ask_leads (lower(email));

alter table ask_leads enable row level security;

-- No anon/authenticated policies: only the service role (landing API) can
-- insert or read. Service role bypasses RLS.
