-- Pod verlassen: Mitglieder dürfen ihre EIGENE Mitgliedschaft löschen.
-- Bisher konnte nur der Pod-Ersteller (oder Admin) pod_members-Zeilen entfernen.

drop policy "pm_delete" on public.pod_members;

create policy "pm_delete" on public.pod_members for delete to authenticated using (
  user_id = auth.uid()
  or exists (select 1 from public.pods p where p.id = pod_members.pod_id and p.created_by = auth.uid())
  or exists (select 1 from public.profiles p where p.id = auth.uid() and p.is_admin)
);
