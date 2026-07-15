-- People identity and invite onboarding live on the public profile, never in
-- auth metadata. Existing accounts are backfilled as completed so only newly
-- invited members enter the mandatory onboarding flow.

alter table public.profiles
  add column if not exists department text,
  add column if not exists department_label text,
  add column if not exists department_color text,
  add column if not exists onboarding_completed_at timestamptz,
  add column if not exists tour_completed_at timestamptz;

alter table public.profiles
  drop constraint if exists profiles_department_check,
  add constraint profiles_department_check check (
    department is null or department in (
      'partnerships', 'it_development', 'sales', 'operations', 'custom'
    )
  ),
  drop constraint if exists profiles_department_color_check,
  add constraint profiles_department_color_check check (
    department_color is null or department_color ~ '^#[0-9A-Fa-f]{6}$'
  ),
  drop constraint if exists profiles_department_label_length_check,
  add constraint profiles_department_label_length_check check (
    department_label is null or char_length(trim(department_label)) between 1 and 48
  );

update public.profiles
set onboarding_completed_at = coalesce(onboarding_completed_at, now()),
    tour_completed_at = coalesce(tour_completed_at, now())
where onboarding_completed_at is null;

comment on column public.profiles.department is 'Normalized team department used for labels and grouping.';
comment on column public.profiles.department_label is 'Custom position label when department is custom.';
comment on column public.profiles.department_color is 'Custom label color when department is custom.';
comment on column public.profiles.onboarding_completed_at is 'Server-side completion marker for invited-user onboarding.';
comment on column public.profiles.tour_completed_at is 'Server-side completion marker for the first product tour.';

grant update (
  department,
  department_label,
  department_color,
  onboarding_completed_at,
  tour_completed_at
) on public.profiles to authenticated;
