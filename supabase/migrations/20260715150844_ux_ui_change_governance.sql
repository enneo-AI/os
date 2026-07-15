-- Rollenbasierter UX/UI-Engineering-Workflow:
-- Members duerfen Anfragen fuer ihren eigenen Account einreichen und verfolgen.
-- Admins verwalten die org-weite Queue und koennen genehmigte Anfragen ueber
-- serverseitig geschuetzte GitLab-Branch-/MR-Tools umsetzen.

create table public.ui_change_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by uuid not null references public.profiles(id) on delete cascade,
  title text not null check (char_length(title) between 3 and 140),
  request_text text not null check (char_length(request_text) between 10 and 8000),
  target_project text,
  target_route text,
  acceptance_criteria text[] not null default '{}',
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'requested'
    check (status in ('requested', 'approved', 'implementing', 'changes_requested', 'completed', 'rejected')),
  admin_notes text,
  assigned_to uuid references public.profiles(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  implemented_by uuid references public.profiles(id) on delete set null,
  implemented_at timestamptz,
  result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index ui_change_requests_status_created_idx
  on public.ui_change_requests(status, created_at desc);
create index ui_change_requests_requested_by_idx
  on public.ui_change_requests(requested_by, created_at desc);
create index ui_change_requests_assigned_to_idx
  on public.ui_change_requests(assigned_to)
  where assigned_to is not null;

create trigger ui_change_requests_updated_at
  before update on public.ui_change_requests
  for each row execute function public.set_updated_at();

alter table public.ui_change_requests enable row level security;

-- Members sehen ausschliesslich eigene Anfragen. Aktive Admins sehen die gesamte
-- Queue. Browser-Writes sind bewusst komplett gesperrt; alle Mutationen laufen
-- ueber authentifizierte Backend-Endpunkte mit Audit-Log.
create policy ui_change_requests_select_scope on public.ui_change_requests
  for select to authenticated
  using (
    requested_by = (select auth.uid())
    or exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.is_admin
        and p.account_status = 'active'
    )
  );

grant select on public.ui_change_requests to authenticated;
grant all on public.ui_change_requests to service_role;

-- Ein Skill, zwei Modi. Die wirksame Berechtigungsgrenze kommt nicht aus diesem
-- Text, sondern aus dem pro Account gefilterten Tool-Katalog und den Backend-Guards.
insert into public.skills (
  slug, name, category, context, workflow, tools, triggers,
  definition_of_done, corner_cases, enabled, visibility
) values (
  'ux-ui-engineering',
  'UX/UI Engineering',
  'Engineering',
  $skill$Dieser Skill verbessert bestehende enneo-Oberflaechen auf Basis echter Nutzerprobleme, Screenshots und des realen Codes. Er hat zwei strikt getrennte Berechtigungsmodi: Members duerfen eine belastbare Aenderung ausarbeiten und als eigene Anfrage einreichen. Nur Admins duerfen Anfragen accountuebergreifend verwalten und genehmigte Aenderungen in einem geschuetzten GitLab-Branch umsetzen. Niemand schreibt direkt auf den Default-Branch oder merged automatisch.$skill$,
  $skill$1. Ziel und Evidenz klaeren: betroffene Seite/Route, sichtbares Problem, gewuenschtes Ergebnis, Screenshot/Quelle und konkrete Akzeptanzkriterien erfassen. Nur bei einer entscheidenden Luecke genau eine gebuendelte Rueckfrage stellen.
2. Bestand pruefen: zustaendiges Projekt suchen, relevanten Code lesen und bestehendes Design-System respektieren. Keine generischen Redesigns und keine erfundenen Komponenten.
3. BERECHTIGUNG PRUEFEN: Ist ux_ui_manage_request NICHT verfuegbar, laeuft zwingend der MEMBER-MODUS. Dann nur analysieren, mit ux_ui_request_change eine Anfrage fuer den eigenen Account erstellen und die Request-ID nennen. Niemals Branches, Dateien, Merge Requests, fremde Accounts oder Team-Ressourcen veraendern.
4. ADMIN-REVIEW: Admins lesen die Queue mit ux_ui_list_requests, pruefen Scope/Risiko/Akzeptanzkriterien und setzen die Anfrage mit ux_ui_manage_request auf approved, changes_requested oder rejected. Vor der Freigabe keine Code-Aenderung.
5. ADMIN-UMSETZUNG: Nur fuer eine approved-Anfrage einen Branch mit Prefix enni/ui- erstellen, Dateien dort aendern und einen Merge Request anlegen. Nie Default-Branch beschreiben, nie mergen, nie fremde Namespaces veraendern. Bestehende Tests/CI als Mindestpruefung verwenden.
6. Abschluss: Request mit Branch, MR-Link und Verifikation dokumentieren und auf completed setzen. Wenn Build/CI oder visuelle Pruefung fehlt, nicht completed setzen, sondern die Luecke konkret benennen.$skill$,
  array[
    'wiki_semantic_search', 'gitlab_search_projects', 'gitlab_search_code', 'gitlab_read_file',
    'ux_ui_request_change', 'ux_ui_list_my_requests', 'ux_ui_list_requests',
    'ux_ui_manage_request', 'gitlab_ui_create_branch', 'gitlab_ui_write_file',
    'gitlab_ui_create_merge_request'
  ],
  $skill$/ux-ui-engineering; Screenshot oder Feedback zu Layout, UX, UI, Responsiveness, Accessibility, Komponenten, Styles, Nutzerfuehrung oder visuellen Bugs; Wunsch, eine bestehende enneo-Oberflaeche zu veraendern oder einen UX/UI-Change anzufragen.$skill$,
  $skill$Das Nutzerproblem ist konkret belegt; Projekt, Route und Akzeptanzkriterien sind erfasst. Im Member-Modus existiert genau eine eigene, nachvollziehbare Anfrage und es gab keinerlei Mutation. Im Admin-Modus existiert eine genehmigte Anfrage, alle Aenderungen liegen ausschliesslich auf einem enni/ui-Branch, ein Merge Request enthaelt Scope und Verifikation, und die Queue dokumentiert den aktuellen Stand.$skill$,
  $skill$Unklarer Ziel-Account oder fremdes Projekt: nicht raten und nicht veraendern. Member fordert direkte Umsetzung: transparent auf Request-Modus begrenzen. Admin fordert direkten Main-Push oder Auto-Merge: ablehnen und Branch/MR verwenden. Kein CI oder keine visuelle Preview vorhanden: als offene Verifikation markieren. Secrets, Tokens oder Kundendaten duerfen nie in Request, Branch oder MR landen.$skill$,
  true,
  'team'
)
on conflict (slug) do update set
  name = excluded.name,
  category = excluded.category,
  context = excluded.context,
  workflow = excluded.workflow,
  tools = excluded.tools,
  triggers = excluded.triggers,
  definition_of_done = excluded.definition_of_done,
  corner_cases = excluded.corner_cases,
  enabled = true,
  visibility = 'team',
  updated_at = now();
