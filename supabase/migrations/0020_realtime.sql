-- enneo OS — Supabase Realtime (2026-07-12)
-- conversations: Status-Punkte (working/unread) instant statt 5s-Poll.
-- messages: Pod-Team-Chat live — Kollegen sehen neue Nachrichten ohne Reload.
-- Realtime (WALRUS) respektiert die bestehenden RLS-Policies: jeder Client
-- bekommt nur Rows, die er auch per SELECT sehen dürfte.

alter publication supabase_realtime add table conversations;
alter publication supabase_realtime add table messages;
