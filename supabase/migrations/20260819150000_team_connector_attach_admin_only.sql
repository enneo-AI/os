-- enneo OS — Team-Connections dürfen nur Admins einem Space zuordnen (2026-08-19)
-- Anlass: BuchhaltungsButler-Team-Connector (Finanzdaten). Bisher durfte JEDER aktive
-- Account eine Team-Connection an einen eigenen Space hängen — damit hätte sich jeder
-- Mitarbeiter über einen selbst angelegten Space Zugriff auf Buchhaltungs-, CRM- oder
-- Slack-Daten geben können. Neu: Eine Connection zuordnen darf nur, wem sie gehört
-- (persönliche Connection) oder ein aktiver Admin (Team-Connections). Die Space-Seite
-- der Prüfung (can_manage_space_connections: Space-Owner bzw. Admin bei Open Spaces)
-- bleibt unverändert bestehen — beide Bedingungen gelten weiterhin zusammen.

create or replace function private.can_attach_connector(connection_key text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  connector_id uuid;
begin
  if (select auth.uid()) is null then return false; end if;
  if connection_key in ('wiki', 'gitlab', 'enneo') then return true; end if;
  if connection_key !~ '^connector:[0-9a-fA-F-]{36}$' then return false; end if;
  connector_id := substring(connection_key from 11)::uuid;
  return exists (
    select 1 from public.connectors c
    where c.id = connector_id
      and (
        c.owner = (select auth.uid())
        or exists (
          select 1 from public.profiles p
          where p.id = (select auth.uid())
            and p.is_admin
            and p.account_status = 'active'
        )
      )
  );
end;
$$;
