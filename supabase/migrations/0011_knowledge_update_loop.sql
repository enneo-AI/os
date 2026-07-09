-- enneo OS — Wissens-Update-Loop (2026-07-09)
-- knowledge_updates existiert seit 0001, wurde aber nie befüllt.
-- Erweiterung: neuer Volltext-Inhalt (robuster als Diff-Apply), neue Seiten möglich,
-- Fehlertext bei fehlgeschlagenem Apply.

alter table knowledge_updates alter column wiki_page_id drop not null;

alter table knowledge_updates
  add column if not exists slug text,          -- Ziel-Slug (auch für neue Seiten)
  add column if not exists new_title text,     -- nur bei neuer Seite oder Titel-Änderung
  add column if not exists new_content text,   -- vollständiger neuer Markdown-Inhalt
  add column if not exists result text;        -- Fehlermeldung bei Apply-Fehler
