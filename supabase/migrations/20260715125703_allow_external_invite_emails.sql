-- Externe Mitglieder und künftige Kunden dürfen eingeladen werden. Rollen kommen
-- weiterhin ausschließlich aus pending_invites; die E-Mail-Domain ist kein
-- Autorisierungsmerkmal.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invite_role text;
begin
  select requested_role into invite_role
  from public.pending_invites
  where email = lower(new.email) and expires_at > now();

  insert into public.profiles (id, email, display_name, is_admin)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', new.email),
    coalesce(invite_role = 'admin', false)
  )
  on conflict (id) do nothing;

  delete from public.pending_invites where email = lower(new.email);
  return new;
end;
$$;
