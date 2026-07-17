-- Pod-Mitglieder dürfen ausschließlich ihre eigenen Nachrichten entfernen.
-- Durch messages.thread_root_id ON DELETE CASCADE entfernt eine gelöschte
-- Hauptnachricht bewusst auch ihren vollständigen Thread.
drop policy if exists messages_delete_own_pod on public.messages;
alter table public.messages replica identity full;

create policy messages_delete_own_pod
on public.messages
for delete
to authenticated
using (
  author_id = (select auth.uid())
  and exists (
    select 1
    from public.conversations c
    where c.id = conversation_id
      and c.pod_id is not null
      and public.is_pod_visible(c.pod_id)
  )
);
