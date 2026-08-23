create extension if not exists pgcrypto;

create table if not exists public.analysis_requests (
  id uuid primary key default gen_random_uuid(),
  owner text not null,
  repo text not null,
  requester text,
  status text not null check (status in ('processing', 'completed', 'failed')),
  idempotency_key text,
  from_cache boolean not null default false,
  github_stats jsonb,
  github_issues jsonb,
  readme_excerpt text,
  analysis_markdown text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists analysis_requests_idempotency_key_uq
  on public.analysis_requests (idempotency_key)
  where idempotency_key is not null;

create index if not exists analysis_requests_owner_repo_created_idx
  on public.analysis_requests (owner, repo, created_at desc);

create table if not exists public.analysis_idempotency_keys (
  key text primary key,
  owner text not null,
  repo text not null,
  request_hash text,
  request_id uuid references public.analysis_requests(id) on delete set null,
  status text not null check (status in ('processing', 'completed', 'failed')),
  response_markdown text,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.agent_event_logs (
  id bigint generated always as identity primary key,
  request_id uuid references public.analysis_requests(id) on delete set null,
  level text not null check (level in ('info', 'warn', 'error')),
  event_type text not null,
  message text not null,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create or replace function public.set_updated_at_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_analysis_requests_updated_at on public.analysis_requests;
create trigger trg_analysis_requests_updated_at
before update on public.analysis_requests
for each row
execute function public.set_updated_at_timestamp();

drop trigger if exists trg_analysis_idempotency_keys_updated_at on public.analysis_idempotency_keys;
create trigger trg_analysis_idempotency_keys_updated_at
before update on public.analysis_idempotency_keys
for each row
execute function public.set_updated_at_timestamp();

alter table public.analysis_requests enable row level security;
alter table public.analysis_idempotency_keys enable row level security;
alter table public.agent_event_logs enable row level security;

create policy "service role full access analysis_requests"
on public.analysis_requests
as permissive
for all
to service_role
using (true)
with check (true);

create policy "service role full access analysis_idempotency_keys"
on public.analysis_idempotency_keys
as permissive
for all
to service_role
using (true)
with check (true);

create policy "service role full access agent_event_logs"
on public.agent_event_logs
as permissive
for all
to service_role
using (true)
with check (true);
