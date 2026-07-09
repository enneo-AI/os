-- enneo OS — Skillstruktur (2026-07-09, Tristan-Liste Punkt 1)
-- Skills sind Ennis "Best-Practice-Playbooks": nicht WAS sie technisch kann (Tools),
-- sondern WIE man es richtig macht. Sechs Textblöcke pro Skill:
--   context            — warum/wofür gibt es diesen Skill (Hintergrund, Use Cases)
--   workflow           — wann macht man genau was, Schritt für Schritt
--   tools              — verknüpfte Basis-Tools (nicht exklusiv, aber "vergiss die nicht")
--   triggers           — wann greift der Skill: /slash-Command + kontextbasiertes Verständnis
--   definition_of_done — wann ist die Skill-Ausführung fertig/gut
--   corner_cases       — bekannte Sonderfälle und wie man sie behandelt

create table skills (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,            -- auch der Slash-Command: /{slug}
  name text not null,
  context text not null default '',
  workflow text not null default '',
  tools text[] not null default '{}',
  triggers text not null default '',
  definition_of_done text not null default '',
  corner_cases text not null default '',
  enabled boolean not null default true,
  created_by uuid references auth.users (id) on delete set null,
  updated_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index skills_slug_idx on skills (slug);

create trigger skills_updated_at before update on skills
  for each row execute function set_updated_at();

alter table skills enable row level security;

-- Lesen: org-weit (Non-Admins sehen die Skill-Übersicht read-only).
-- Schreiben: nur Admins — Skills sind Schulung der KI, das bleibt beim Admin.
create policy skills_select on skills for select to authenticated using (true);
create policy skills_insert_admin on skills for insert to authenticated
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy skills_update_admin on skills for update to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin))
  with check (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
create policy skills_delete_admin on skills for delete to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
