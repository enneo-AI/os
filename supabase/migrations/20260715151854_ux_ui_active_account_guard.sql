-- Die erste UX/UI-Migration war bereits live, bevor der globale
-- active-account-Guard fuer die neue Tabelle geprueft wurde. Diese Policy
-- schliesst deaktivierte Members auch bei noch gueltigem JWT explizit aus.
drop policy if exists ui_change_requests_select_scope on public.ui_change_requests;

create policy ui_change_requests_select_scope on public.ui_change_requests
  for select to authenticated
  using (
    exists (
      select 1 from public.profiles p
      where p.id = (select auth.uid())
        and p.account_status = 'active'
        and (public.ui_change_requests.requested_by = p.id or p.is_admin)
    )
  );
