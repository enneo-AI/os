-- enneo OS — Per-User-Tools + Teilen-Flow (2026-07-13)
-- Jedes Tool/jede Connection wird vom Account-Owner angelegt (visibility 'personal'),
-- kann fürs Unternehmen beantragt werden ('proposed') und gilt nach Admin-Freigabe
-- für alle ('team'). Bestehende Connectors bleiben team-weit. Credentials bleiben
-- write-only (Spalten-Grant aus 0010 schließt token aus).
alter table connectors add column if not exists owner uuid references auth.users (id) on delete cascade;
alter table connectors add column if not exists visibility text not null default 'team'
  check (visibility in ('personal', 'proposed', 'team'));
grant select (owner, visibility) on connectors to authenticated;
create index if not exists connectors_owner_idx on connectors (owner, visibility);
