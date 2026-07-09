-- enneo OS — Routinen/Scheduler (2026-07-09, Tristan-Roadmap Punkt 6)
-- Wiederkehrende Enni-Läufe ("jeden Morgen offene Tickets von Instanz X als Report
-- in den Pod"). Der Ticker läuft im Railway-Backend (Berlin-Zeit); jedes Ergebnis
-- ist eine normale Konversation (privat beim Ersteller oder im Ziel-Pod).

create table routines (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  prompt text not null,                 -- die Nachricht an Enni, darf /skill enthalten
  cron text not null,                   -- 5-Feld-Cron (Minute Stunde Tag Monat Wochentag), Europe/Berlin
  schedule_label text not null default '',   -- menschenlesbar ("Werktags 08:00")
  pod_id uuid references pods (id) on delete cascade,  -- null = private Konversation des Erstellers
  model text not null default 'claude-haiku-4-5',
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_result text,                     -- 'ok' oder Fehlermeldung des letzten Laufs
  created_by uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index routines_enabled_idx on routines (enabled);

create trigger routines_updated_at before update on routines
  for each row execute function set_updated_at();

alter table routines enable row level security;

-- Jeder verwaltet seine eigenen Routinen; Admins sehen und verwalten alle.
create policy routines_select on routines for select to authenticated
  using (created_by = auth.uid() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy routines_insert on routines for insert to authenticated
  with check (created_by = auth.uid());
create policy routines_update on routines for update to authenticated
  using (created_by = auth.uid() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy routines_delete on routines for delete to authenticated
  using (created_by = auth.uid() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
