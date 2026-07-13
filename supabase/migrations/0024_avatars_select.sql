-- enneo OS — SELECT-Policy für avatars-Bucket (2026-07-13)
-- Ohne select kann der Client list()/remove() nicht nutzen: Logo-/Avatar-Cleanup lief leise ins Leere
-- (betraf auch den Profil-Avatar-Flow seit 0009 — alte Avatare wurden nie gelöscht).
-- Der Bucket ist public (Lesen via Public-URL ohnehin möglich), die Policy gibt nichts Neues preis.
create policy "avatars_select_authenticated" on storage.objects for select to authenticated
  using (bucket_id = 'avatars');
