-- enneo OS — beehiiv als native Connector-Art (2026-08-19)
-- Newsletter-Plattform (api.beehiiv.com/v2, Bearer-Key): Publications, Posts mit
-- Engagement-Stats (Opens/Clicks/Unsubscribes), Segmente. Bewusst read-only und
-- OHNE Subscriber-Listen (PII-Datenminimierung — Engagement braucht keine E-Mail-
-- Adressen einzelner Abonnenten). Jede Person verbindet ihren eigenen API-Key
-- als persönliche Connection (Tools in src/tools/beehiiv.js).

alter table public.connectors drop constraint if exists connectors_kind_check;
alter table public.connectors add constraint connectors_kind_check
  check (kind in ('mcp', 'attio', 'slack', 'outlook', 'google_drive', 'notion', 'buchhaltungsbutler', 'partnerportal', 'beehiiv'));
