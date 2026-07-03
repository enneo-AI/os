-- enneo OS — Spaces (Dust-Pattern): Open/Restricted Spaces, Mitglieder, Space-Connections (2026-07-04)

create table spaces (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  restricted boolean not null default false,
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger spaces_updated_at before update on spaces
  for each row execute function set_updated_at();

create table space_members (
  space_id uuid not null references spaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (space_id, user_id)
);

-- Welche Connection (aus der Administration) ist diesem Space zugeordnet
create table space_connections (
  space_id uuid not null references spaces (id) on delete cascade,
  connection_key text not null,   -- z.B. 'gitlab', 'wiki', 'google_drive'
  added_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (space_id, connection_key)
);

alter table wiki_pages add column space_id uuid references spaces (id) on delete set null;

-- Seed: Company Data als Open Space, alles bestehende Wissen gehört dazu
insert into spaces (name, restricted) values ('Company Data', false);
update wiki_pages set space_id = (select id from spaces where name = 'Company Data');
insert into space_connections (space_id, connection_key)
select id, k from spaces, unnest(array['wiki', 'gitlab']) as k where name = 'Company Data';

-- RLS
alter table spaces enable row level security;
alter table space_members enable row level security;
alter table space_connections enable row level security;

-- Mitgliedschaften sind org-intern sichtbar (unkritisch, verhindert RLS-Rekursion)
create policy sm_select on space_members for select to authenticated using (true);
create policy sm_insert on space_members for insert to authenticated
  with check (exists (select 1 from spaces s where s.id = space_id and s.created_by = auth.uid())
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy sm_delete on space_members for delete to authenticated
  using (exists (select 1 from spaces s where s.id = space_id and s.created_by = auth.uid())
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

-- Spaces: offene sieht jeder, restricted nur Mitglieder/Ersteller/Admins
create policy spaces_select on spaces for select to authenticated
  using (not restricted
    or created_by = auth.uid()
    or exists (select 1 from space_members m where m.space_id = id and m.user_id = auth.uid())
    or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy spaces_insert on spaces for insert to authenticated with check (created_by = auth.uid());
create policy spaces_update on spaces for update to authenticated
  using (created_by = auth.uid() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy spaces_delete on spaces for delete to authenticated
  using (created_by = auth.uid() or exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));

-- Space-Connections: sichtbar/änderbar wenn der Space sichtbar ist (spaces-RLS greift im Subselect)
create policy sc_select on space_connections for select to authenticated
  using (exists (select 1 from spaces s where s.id = space_id));
create policy sc_insert on space_connections for insert to authenticated
  with check (exists (select 1 from spaces s where s.id = space_id));
create policy sc_delete on space_connections for delete to authenticated
  using (exists (select 1 from spaces s where s.id = space_id));
