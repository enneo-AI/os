-- enneo OS — Datei-Anhänge im Chat (2026-07-05)
-- Nur Metadaten ({name, media_type, size}) — der Inhalt geht einmalig im Upload-Turn ans Modell.
alter table messages add column if not exists attachments jsonb;
