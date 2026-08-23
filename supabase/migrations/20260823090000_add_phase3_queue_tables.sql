alter table public.analysis_requests
  drop constraint if exists analysis_requests_status_check;

alter table public.analysis_requests
  add constraint analysis_requests_status_check
  check (status in ('queued', 'processing', 'retrying', 'completed', 'failed', 'dead_lettered'));

create table if not exists public.analysis_queue_jobs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null unique references public.analysis_requests(id) on delete cascade,
  owner text not null,
  repo text not null,
  kafka_topic text not null,
  kafka_key text not null,
  status text not null check (status in ('queued', 'processing', 'retrying', 'completed', 'failed', 'dead_lettered')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  next_retry_at timestamptz,
  last_published_topic text,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analysis_queue_jobs_status_created_idx
  on public.analysis_queue_jobs (status, created_at desc);

create table if not exists public.analysis_dead_letter_events (
  id bigint generated always as identity primary key,
  queue_job_id uuid references public.analysis_queue_jobs(id) on delete set null,
  request_id uuid references public.analysis_requests(id) on delete set null,
  owner text not null,
  repo text not null,
  payload jsonb not null,
  error_message text not null,
  attempts integer not null,
  created_at timestamptz not null default now()
);

drop trigger if exists trg_analysis_queue_jobs_updated_at on public.analysis_queue_jobs;
create trigger trg_analysis_queue_jobs_updated_at
before update on public.analysis_queue_jobs
for each row
execute function public.set_updated_at_timestamp();

alter table public.analysis_queue_jobs enable row level security;
alter table public.analysis_dead_letter_events enable row level security;

create policy "service role full access analysis_queue_jobs"
on public.analysis_queue_jobs
as permissive
for all
to service_role
using (true)
with check (true);

create policy "service role full access analysis_dead_letter_events"
on public.analysis_dead_letter_events
as permissive
for all
to service_role
using (true)
with check (true);
