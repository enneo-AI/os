-- enneo OS — Pod-Logo (Projekt-/Kundenlogo statt Initialen-Kachel) (2026-07-13)
alter table pods add column if not exists logo_url text;

-- Pod-Logos leben im public avatars-Bucket unter dem Prefix "pod-".
-- Die bestehenden avatars_*-Policies erlauben nur eigene {uid}-% Namen — Pods gehören dem Team.
create policy "avatars_pod_logo_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and name like 'pod-%');
create policy "avatars_pod_logo_update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and name like 'pod-%');
create policy "avatars_pod_logo_delete" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and name like 'pod-%');
