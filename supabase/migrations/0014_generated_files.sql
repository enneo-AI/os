-- enneo OS — Bucket für von Enni erstellte Dateien (2026-07-09)
-- Privat: Auslieferung ausschließlich über Signed-URLs (7 Tage), die das Backend
-- mit service_role erzeugt. Keine Storage-Policies für authenticated nötig.

insert into storage.buckets (id, name, public)
values ('generated-files', 'generated-files', false)
on conflict (id) do nothing;
