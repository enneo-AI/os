-- enneo OS — Skills für alle: Kategorien + persönliche Skills + Team-Freigabe (2026-07-13)
-- Modell wie beim Learnings-Layer:
--   visibility 'team'     = gilt für alle Accounts (nur Admin kann dahin schalten)
--   visibility 'personal' = nur der Ersteller sieht/nutzt ihn
--   visibility 'proposed' = beim Ersteller aktiv, wartet auf Admin-Freigabe für alle
alter table skills add column if not exists category text not null default 'Allgemein';
alter table skills add column if not exists visibility text not null default 'team'
  check (visibility in ('team', 'personal', 'proposed'));

-- RLS neu: jeder darf eigene Skills anlegen/bearbeiten (aber nicht selbst team-weit schalten)
drop policy if exists skills_select on skills;
drop policy if exists skills_insert_admin on skills;
drop policy if exists skills_update_admin on skills;
drop policy if exists skills_delete_admin on skills;

create policy skills_select on skills for select to authenticated
  using (visibility = 'team' or created_by = auth.uid()
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

create policy skills_insert on skills for insert to authenticated
  with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin)
    or (created_by = auth.uid() and visibility in ('personal', 'proposed'))
  );

create policy skills_update on skills for update to authenticated
  using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin)
    or (created_by = auth.uid() and visibility in ('personal', 'proposed'))
  )
  with check (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin)
    or (created_by = auth.uid() and visibility in ('personal', 'proposed'))
  );

create policy skills_delete on skills for delete to authenticated
  using (
    exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin)
    or (created_by = auth.uid() and visibility in ('personal', 'proposed'))
  );
