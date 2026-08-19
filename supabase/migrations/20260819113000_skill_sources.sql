-- enneo OS — Verbindliche Skill-Quellen aus Spaces statt separater Kontexte-Bibliothek (2026-08-19)
-- Beschluss Aleksa + Tristan (Meeting 04.08.): Wissen lebt an EINEM Ort — in den Spaces
-- (Company Data & Restricted Spaces). Skills referenzieren als verbindliche Quellen ab
-- jetzt einzelne Wiki-Seiten, ganze Ordner oder ganze Spaces. Die Kontexte-Bibliothek
-- entfällt; contexts bleibt ausschließlich für den persönlichen Profil-Kontext
-- (context_type='personal_profile') bestehen.

create table public.skill_sources (
  id uuid primary key default gen_random_uuid(),
  skill_id uuid not null references public.skills(id) on delete cascade,
  -- Entweder eine konkrete Seite (wiki_page_id) ODER ein Space, optional auf einen
  -- Ordner (erstes Slug-Segment) eingegrenzt.
  space_id uuid references public.spaces(id) on delete cascade,
  folder text,
  wiki_page_id uuid references public.wiki_pages(id) on delete cascade,
  position integer not null default 0 check (position >= 0),
  created_at timestamptz not null default now(),
  constraint skill_sources_target check (wiki_page_id is not null or space_id is not null)
);

create index skill_sources_skill_idx on public.skill_sources(skill_id);
create index skill_sources_page_idx on public.skill_sources(wiki_page_id);
alter table public.skill_sources enable row level security;

-- Lesen: wer den Skill sehen darf (Team-Skill oder eigener Skill)
create policy skill_sources_select on public.skill_sources for select to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_id and (s.visibility = 'team' or s.created_by = (select auth.uid()))
    )
  );

-- Schreiben: eigener persönlicher/vorgeschlagener Skill oder Admin (wie skill_contexts)
create policy skill_sources_insert on public.skill_sources for insert to authenticated
  with check (
    exists (
      select 1 from public.skills s
      where s.id = skill_id and (
        (s.created_by = (select auth.uid()) and s.visibility in ('personal', 'proposed'))
        or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
      )
    )
  );

create policy skill_sources_delete on public.skill_sources for delete to authenticated
  using (
    exists (
      select 1 from public.skills s
      where s.id = skill_id and (
        (s.created_by = (select auth.uid()) and s.visibility in ('personal', 'proposed'))
        or exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.is_admin)
      )
    )
  );

grant select, insert, delete on public.skill_sources to authenticated;

create policy active_account_only on public.skill_sources as restrictive for all to authenticated
  using (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ))
  with check (exists (
    select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.account_status = 'active'
  ));

-- Bestehende Bibliotheks-Verknüpfungen in Quellen überführen (aktuell 0 Zeilen,
-- der Vollständigkeit halber trotzdem korrekt für wiki-verlinkte Kontexte):
insert into public.skill_sources (skill_id, wiki_page_id, position)
select sc.skill_id, c.wiki_page_id, sc.position
from public.skill_contexts sc
join public.contexts c on c.id = sc.context_id
where c.wiki_page_id is not null;

-- Bibliothek stilllegen: Team-/Import-Kontexte raus (die Inhalte leben als Wiki-Seiten
-- weiter), persönliche Profil-Kontexte bleiben unangetastet.
delete from public.skill_contexts;
delete from public.contexts where context_type <> 'personal_profile';
