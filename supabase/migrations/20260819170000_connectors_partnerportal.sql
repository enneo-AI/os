-- enneo OS — Partnerportal als native Connector-Art (2026-08-19)
-- Read-only-API des enneo-Partnerportals (partner.enneo.ai/api/public/v1):
-- Kunden, Partner, Deals, Angebote/Verträge, Instanzen, Lead-Freigaben und die
-- komplette Abrechnung (Rechnungen, Gutschriften, Zahlungen, Provisionen).
-- Auth: Bearer-Key (enneo_ro_…), ein Credential — jede Person verbindet ihren
-- eigenen Key als persönliche Connection (Tools in src/tools/partnerportal.js).

alter table public.connectors drop constraint if exists connectors_kind_check;
alter table public.connectors add constraint connectors_kind_check
  check (kind in ('mcp', 'attio', 'slack', 'outlook', 'google_drive', 'notion', 'buchhaltungsbutler', 'partnerportal'));
