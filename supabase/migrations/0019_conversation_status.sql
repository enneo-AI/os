-- enneo OS — Multi-Sessions: Konversations-Status (2026-07-10)
-- working = Enni arbeitet gerade in dieser Konversation (Backend setzt/löscht das
-- um jeden Turn — überlebt Browser-Schließen, gilt auch für Routinen-Läufe).
-- unread  = Turn wurde fertig, während der Nutzer nicht zugeschaut hat → grüner
-- Punkt in der Sidebar, bis die Konversation geöffnet wird (Frontend löscht).

alter table conversations
  add column if not exists working boolean not null default false,
  add column if not exists unread boolean not null default false;
