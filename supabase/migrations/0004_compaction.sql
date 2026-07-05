-- enneo OS — Context Compaction nach Dust-Muster (2026-07-04)
-- Eine Message mit role='compaction' ist der Verlaufs-Anker: content = Zusammenfassung.
-- Ältere Messages bleiben gespeichert und sichtbar, gehen aber nicht mehr ans Modell.
-- (Bereits via Management API angewendet — ALTER TYPE ADD VALUE separat ausgeführt.)

alter type message_role add value if not exists 'compaction';
