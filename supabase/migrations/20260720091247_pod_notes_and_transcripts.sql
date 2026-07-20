-- Shared Pod notes and meeting transcripts. Content is available only to
-- current Pod members; authors retain control over their own entries.
create table public.pod_notes (
  id uuid primary key default gen_random_uuid(),
  pod_id uuid not null references public.pods(id) on delete cascade,
  kind text not null default 'note' check (kind in ('note', 'meeting_transcript')),
  title text not null default '' check (char_length(title) <= 240),
  content text not null check (char_length(btrim(content)) > 0 and char_length(content) <= 500000),
  meeting_date date,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pod_notes_meeting_date_check check (kind = 'meeting_transcript' or meeting_date is null)
);

create index pod_notes_pod_updated_idx on public.pod_notes (pod_id, updated_at desc);
create index pod_notes_pod_kind_updated_idx on public.pod_notes (pod_id, kind, updated_at desc);

create trigger pod_notes_set_updated_at
before update on public.pod_notes
for each row execute function public.set_updated_at();

alter table public.pod_notes enable row level security;

create policy pod_notes_select_members
on public.pod_notes for select to authenticated
using (public.is_pod_visible(pod_id));

create policy pod_notes_insert_members
on public.pod_notes for insert to authenticated
with check (
  created_by = (select auth.uid())
  and public.is_pod_visible(pod_id)
);

create policy pod_notes_update_own
on public.pod_notes for update to authenticated
using (
  created_by = (select auth.uid())
  and public.is_pod_visible(pod_id)
)
with check (
  created_by = (select auth.uid())
  and public.is_pod_visible(pod_id)
);

create policy pod_notes_delete_own
on public.pod_notes for delete to authenticated
using (
  created_by = (select auth.uid())
  and public.is_pod_visible(pod_id)
);

-- New public tables are not implicitly exposed to API roles. Keep grants
-- explicit so PostgREST can serve the table while RLS remains authoritative.
grant select, insert, update, delete on public.pod_notes to authenticated;
grant all on public.pod_notes to service_role;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'pod_notes'
  ) then
    alter publication supabase_realtime add table public.pod_notes;
  end if;
end $$;

comment on table public.pod_notes is
  'Shared short notes and meeting transcripts scoped to a Pod.';
