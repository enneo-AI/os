-- enneo OS — Aufgaben-Abschnitte + Fälligkeit (awork-Muster) (2026-07-13)
-- Abschnitte entstehen durch Benutzung (wie Wiki-Ordner): section = Freitext, '' = "Allgemein".
alter table pod_tasks add column if not exists section text not null default '';
alter table pod_tasks add column if not exists due_date date;
