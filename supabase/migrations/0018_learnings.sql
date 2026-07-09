-- enneo OS — Learnings-Layer (2026-07-09)
-- Persönliche Learnings wirken SOFORT für den eigenen Account (Prompt-Injection).
-- Team-weite Gültigkeit erst nach Admin-Freigabe (share_status-Flow):
--   'none'     = rein persönlich (Nutzer wollte nicht teilen)
--   'proposed' = wartet auf Admin-Review (Learning-Card im Admin-Bereich)
--   'approved' = gilt für ALLE Accounts
--   'rejected' = Admin abgelehnt — bleibt aber persönlich aktiv beim Urheber
-- Quellen: Feedback-Button unter Enni-Antworten ('feedback') und
-- "Lernen & Schließen" beim Chat-Schließen ('conversation', Haiku-Extraktion).

create table learnings (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  content text not null,
  source text not null check (source in ('feedback', 'conversation')),
  source_conversation_id uuid references conversations (id) on delete set null,
  share_status text not null default 'none'
    check (share_status in ('none', 'proposed', 'approved', 'rejected')),
  enabled boolean not null default true,
  reviewed_by uuid references auth.users (id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create index learnings_user_idx on learnings (user_id, enabled);
create index learnings_share_idx on learnings (share_status);

alter table learnings enable row level security;

-- Eigene Learnings sehen/anlegen/löschen; Admins sehen alle (Review-Panel).
-- share_status-Übergänge (approve/reject) laufen NUR über Backend-Endpoints (service_role).
create policy learnings_select on learnings for select to authenticated
  using (user_id = auth.uid() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy learnings_insert on learnings for insert to authenticated
  with check (user_id = auth.uid() and share_status in ('none', 'proposed'));
create policy learnings_delete on learnings for delete to authenticated
  using (user_id = auth.uid());
