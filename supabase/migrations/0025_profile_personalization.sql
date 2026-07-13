-- enneo OS — Account-Personalisierung (2026-07-13)
-- Jeder Account beschreibt Rolle + Fokus; Enni bekommt das als System-Block pro Turn
-- und personalisiert Antworten (wer fragt, was braucht die Person typischerweise).
alter table profiles add column if not exists role_title text not null default '';
alter table profiles add column if not exists about text not null default '';
