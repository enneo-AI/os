-- enneo OS — Wissens-Update-Loop: Review nur durch Admins (2026-07-09)
-- Aleksas Vorgabe: Vorschläge werden gesammelt, aber NUR der Admin sieht und
-- genehmigt sie (Schutz gegen Fehl-Schulung durch unerfahrene Nutzer).
-- Approve/Reject läuft ausschließlich über Backend-Endpoints (service_role) —
-- die alte ku_review-Policy (jeder Authentifizierte) fliegt raus.

drop policy if exists ku_select on knowledge_updates;
drop policy if exists ku_review on knowledge_updates;

create policy ku_select_admin on knowledge_updates for select to authenticated
  using (exists (select 1 from profiles p where p.id = auth.uid() and p.is_admin));
