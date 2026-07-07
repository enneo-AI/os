-- Profil-Bearbeitung: Avatar-Spalte + Avatars-Bucket + E-Mail-Domain-Zwang (@enneo.ai).

alter table public.profiles add column if not exists avatar_url text;

-- Nur enneo.ai-Konten: Signup mit fremder Domain schlägt fehl (greift bei jedem Auth-Provider,
-- weil der Profil-Trigger bei jedem neuen auth.users-Eintrag läuft).
create or replace function public.handle_new_user()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  if new.email !~* '@enneo\.ai$' then
    raise exception 'Nur enneo.ai-E-Mail-Adressen sind erlaubt (%).', new.email;
  end if;
  insert into profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', new.email))
  on conflict (id) do nothing;
  return new;
end $function$;

-- Avatars: öffentlicher Bucket, Upload/Update nur auf den eigenen Pfad ({uid}-*)
insert into storage.buckets (id, name, public) values ('avatars', 'avatars', true)
on conflict (id) do nothing;

create policy "avatars_insert_own" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars' and name like auth.uid() || '-%');
create policy "avatars_update_own" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and name like auth.uid() || '-%');
create policy "avatars_delete_own" on storage.objects for delete to authenticated
  using (bucket_id = 'avatars' and name like auth.uid() || '-%');
