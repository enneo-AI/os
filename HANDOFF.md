# HANDOFF — Stand & nächste Schritte

**Zuletzt aktualisiert:** 2026-07-03 (abends — Schema live)

## Erledigt

- [x] Konzept + Dust.tt-Research (claude-team: `ai-team/agents/enni-enneo/knowledge/company-os-dust-research.md` + knowledge.md §89)
- [x] Klickbares Design-Mockup v5, von Aleksa final validiert (`design/mockup-v5.html`)
- [x] Konzept-Pivot: EIN Agent (Enni) statt Agenten-Zoo; Wiki als Notion-Ersatz; Slack-Abgrenzung
- [x] Supabase-Projekt `enneo OS` angelegt (aiwhomrvspfxotkllngz, Frankfurt)
- [x] GitHub-Repo `enneo-AI/os` + lokaler Clone `~/Desktop/Projects/enneo-os` + Auth eingerichtet
- [x] Repo-Grundgerüst (README, CLAUDE.md, docs, design)
- [x] **DB-Schema live** (2026-07-03): `supabase/migrations/0001_mvp_schema.sql` via Management API eingespielt — `profiles` (auto-angelegt bei Auth-Signup, `is_admin`-Flag), `conversations`, `messages` (inkl. `thinking` + `tool_calls` jsonb fürs Gedankenketten-Panel), `llm_usage` (Token + `cost_eur` pro Antwort, source chat/routine), `wiki_pages` (Markdown), `knowledge_updates` (Diff + proposed/approved/rejected). RLS auf allen 6 Tabellen: Conversations/Messages owner-only, Wiki org-weit, `llm_usage`- und `knowledge_updates`-Inserts nur via Backend (service_role). PostgREST exponiert `public` (geprüft).

## Als Nächstes (MVP Phase 1)

1. [x] **Auth-Entscheidung (2026-07-03):** enneo nutzt **Microsoft**, nicht Google — und Aleksa ist kein Azure-Admin. Darum MVP mit **Supabase Email+Passwort** (reicht für Demo + Founder-Pitch). **Microsoft-SSO (Azure AD) kommt in Phase 2**, sobald ein Admin den OAuth-Client in Entra ID anlegen kann. Schema ist provider-agnostisch (profiles-Trigger greift bei jedem Auth-Provider).
2. [x] **Node-Backend geschrieben (2026-07-03, Code komplett, noch nicht deployed):** `backend/` — Express + SSE-Streaming, Enni-Tool-Loop mit dem offiziellen `@anthropic-ai/sdk` (bewusste Abweichung vom Agent-SDK: gleiche API, volle Kontrolle über Gedankenkette/Tool-Calls/cost_eur-Persistenz, läuft auf jedem Node-Hosting — Begründung in `backend/README.md`). Tools: `wiki_list_pages`/`wiki_read_page`/`wiki_search` (Supabase) + `gitlab_search_projects`/`_search_code`/`_read_file`/`_list_merge_requests` (read-only REST, ersetzt Attio als ersten Connector). Model `claude-opus-4-8`, Prompt-Caching auf dem System-Prompt, `llm_usage`-Logging mit Euro-Betrag pro Antwort. **Zum Laufen fehlt:** (a) Hosting (Punkt 3), (b) `ANTHROPIC_API_KEY` (Aleksas persönlicher), (c) `GITLAB_TOKEN` (read_api-PAT aus dem enneo-GitLab) + `GITLAB_BASE_URL` — GitLab-Tools antworten bis dahin mit "Connector noch nicht konfiguriert", Wiki-Tools funktionieren sofort. Code ist ungetestet bis zum ersten Deploy (kein lokales Node auf dieser Maschine).
2b. [ ] **Wiki-Seeding aus Ennis KB (kuratiert):** die enneo-Wissens-Files aus claude-team (`ai-team/agents/enni-enneo/knowledge/` — enneo-company, product-docs, api-docs, Implementation-Patterns) als `wiki_pages` importieren, damit Enni im OS dasselbe Wissen hat wie in Aleksas Setup. **NICHT rein:** vertrauliche Files (`aleksa-role.md` mit Vertragsdetails, private Notes) — Wiki ist org-weit lesbar.
3. [x] **Backend LIVE auf Railway (2026-07-03):** `https://enneo-os-backend-production.up.railway.app` — Projekt `enneo-os-backend` (ID `4be1c83c-1c40-4d92-83e3-86f5c2e1afc9`) auf Aleksas Railway-Account (Free Trial, danach 1 $/Monat). Deploy via **Railway CLI** (`railway up --detach --service enneo-os-backend` aus `backend/`), NICHT GitHub-Auto-Deploy — Aleksa ist kein Admin der enneo-AI GitHub-Org, Railway-App kann dort nicht installiert werden. Env-Vars gesetzt: ANTHROPIC_API_KEY (Aleksas, via Dashboard), SUPABASE_URL + SERVICE_ROLE_KEY, ENNI_MODEL, EUR_PER_USD, FRONTEND_ORIGIN. Fixes unterwegs: Node 22 nötig (supabase-js braucht native WebSocket) + Tabellen-GRANTs auf dem Supabase nachgezogen (neue Projekte blocken sogar service_role — bekannte Lesson). **End-to-End-Smoke-Test bestanden:** Enni antwortet gestreamt, ruft wiki_list_pages auf, Conversation/Messages/llm_usage werden persistiert (erste Antwort: 0,019 €). Login-User `aleksa@enneo.ai` angelegt (Email+Passwort).
4. [ ] **Frontend:** Chat im v5-Design (Streaming, Gedankenkette, Tool-Detail-Panel), Login via Supabase Email+Passwort (Microsoft-SSO in Phase 2)
5. [ ] **Wissens-Update-Loop:** Diff-Vorschlag → Freigabe → Wiki-Seite aktualisiert → Audit-Eintrag

## Offene Entscheidungen

- [x] **Anthropic-API-Account (entschieden 2026-07-03):** MVP läuft mit Aleksas persönlichem API-Key — nur Test + Team-Demo, keine Produktion, Kosten minimal und via `llm_usage` transparent. enneo hat bereits einen Unternehmens-API-Account, aber Aleksa hat (noch) keinen Konsolen-Zugriff. Sobald Team-Testing startet → Firmen-Key von enneo. Key kommt als Env-Var ins Backend-Hosting, nie ins Repo.
- [ ] Founder-Pitch-Termin: MVP-Demo als Kernstück der Team-Präsentation
- [ ] Block-Editor-Library für Wiki-Phase-2 (BlockNote vs. Tiptap — nicht selbst bauen)

## Bewusst NICHT im MVP

Pods, Block-Editor, Connectors-UI, Admin-Dashboards, Routinen/Scheduler, Slack-Anbindung.
