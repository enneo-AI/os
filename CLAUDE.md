# enneo OS — Projekt-Kontext für Claude-Code-Sessions

**Was:** Internes AI-Workbench-System für das enneo-Team (~20 MA). Ein Agent (Enni) + Wiki/Spaces (Notion-Ersatz) + Pods (Projekt-Räume) + Admin. Owner: Aleksa (AI Implementation Manager bei enneo). **Stand: MVP komplett LIVE** — Founder-Pitch Mi 08.07.2026 (Firmenreise Georgien), noch nicht mit Richard/Kyung besprochen.

**Rolle dieser Codebase:** Repo gehört der enneo-AI GitHub-Org. Alles enneo-vertraulich (§ 9 Rahmenvertrag) — keine Kundendaten committen, keine Secrets committen. Detaillierter Verlauf + offene Punkte: `HANDOFF.md` (immer zuerst lesen!).

## Live-System

| Komponente | Wo | Deploy |
|---|---|---|
| Frontend | `https://enneo-os.netlify.app` | **automatisch bei git push** (GitHub-Connect, `netlify.toml`: publish=frontend + SPA-Redirects) |
| Backend | `https://enneo-os-backend-production.up.railway.app` | **NUR manuell:** `cd backend && ~/.railway/bin/railway up --detach --service enneo-os-backend` (Railway-Projekt `4be1c83c-…` auf Aleksas Account, Login via `railway login --browserless`) |
| DB/Auth/Storage | Supabase `aiwhomrvspfxotkllngz` (eu-central-1, Org "Enneo AI") | Migrations: SQL in `supabase/migrations/` + via Management API `POST /v1/projects/{ref}/database/query` einspielen |
| Edge Function | `embed` (gte-small Embeddings, 384 Dim.) | `SUPABASE_ACCESS_TOKEN=$(cat ~/.supabase/access-token-enneo-companyos) ~/.local/bin/supabase functions deploy embed --project-ref aiwhomrvspfxotkllngz` |

**Login (MVP Email+Passwort, Microsoft-SSO Phase 2):** `aleksa@enneo.ai`, Passwort hat Aleksa. Test-JWT für curl: via `POST {SUPABASE}/auth/v1/token?grant_type=password` mit Anon-Key.

**Invite-Sicherheit:** Admin-Invites dürfen niemals als rohe Supabase-`/auth/v1/verify`-Links geteilt werden, weil Slack/Teams/Discord Link-Previews GET-Einmal-Links verbrauchen können. `/api/invite` erzeugt deshalb eine crawler-sichere `/invite?token_hash=…&type=invite|magiclink`-Zwischenseite; erst der bewusste Button-Klick ruft clientseitig `verifyOtp` auf.

**Secrets/Keys:** Supabase-PAT `~/.supabase/access-token-enneo-companyos`. Anon/Service-Keys live via Management API ziehen (`?reveal=true`), nie cachen. Railway-Env-Vars: ANTHROPIC_API_KEY (Aleksas persönlicher, MVP-only), SUPABASE_URL/SERVICE_ROLE_KEY, GITLAB_TOKEN (Aleksas PAT „aleksa-enneo" aus macOS-Keychain `security find-internet-password -s gitlab.com -w`, gültig 2027-04), GITLAB_BASE_URL=https://gitlab.com, FRONTEND_ORIGIN, ENNI_MODEL, EUR_PER_USD.

## Architektur (Kurzform)

- **Frontend** `frontend/`: Vanilla HTML+JS ohne Build (esm.sh für supabase-js/marked/DOMPurify). Konfiguration in `config.js` (Anon-Key ist public). SPA-Routing über History API: `/chat`, `/chat/:id`, `/spaces`, `/spaces/tools`, `/spaces/connections`, `/admin`, `/pod/:id`.
- **Backend** `backend/`: Node 22 + Express + `@anthropic-ai/sdk` (manueller Tool-Loop, KEIN Agent-SDK — Begründung in `backend/README.md`). SSE-Streaming. Endpoints: `POST /api/chat` (message, conversation_id?, model?, attachments?, pod_id?), `POST /api/compact`, `POST /api/conversations/:id/read`, `GET /health`.
- **Enni-Tools:** `wiki_semantic_search` (RAG, pgvector Top-8-Chunks — IMMER zuerst), `wiki_search`/`wiki_list_pages`/`wiki_read_page`, GitLab read-only (`gitlab_search_projects/_search_code/_read_file/_list_merge_requests`). Der teamweite Skill `/ux-ui-engineering` hat zwei serverseitig getrennte Modi: Members nur eigene `ui_change_requests`; aktive Admins zusätzlich Request-Management und GitLab-Writes ausschließlich auf freigegebenen `enni/ui-*`-Branches im `enneo`-Namespace. Kein Default-Branch-Write, Merge oder Auto-Merge.
- **Remote MCPs:** Generic Connector unterstützt `mcp_none`, `mcp_bearer` und `mcp_x_api_key`; Header niemals heuristisch vertauschen. Tokens werden beim Speichern mit `encryptSecret()` verschlüsselt und beim serverseitigen Connect entschlüsselt. Research-Blueprints kommen ausschließlich aus dem erzwungenen `submit_blueprint`-Tool, nicht aus frei geparstem JSON.
- **Modelle:** User wählt im Chat-Dropdown (Opus 4.8 Default / Sonnet 5 / Haiku 4.5). Haiku kann KEIN adaptive thinking — Parameter wird modellabhängig gesetzt. Kosten pro Antwort in `llm_usage` (cost_eur), Preise in `backend/src/usage.js`.
- **Kontext:** `contexts` ist die Source of Truth für wiederverwendbare persönliche/teamweite Wissens-, Brand-, Persona- und Kundenkontexte. Der private `personal_profile`-Kontext entsteht im Onboarding und hat ausdrücklich keinen Admin-RLS-Bypass. `skill_contexts` lädt Pflichtquellen deterministisch vor dem Skill-Workflow. Zusätzlich: Prompt-Caching (wandernder Breakpoint im Tool-Loop, alte Marker löschen — max. 4!) und Compaction nach Dust.
- **Anhänge:** Excel/CSV/JPEG/PNG/PDF (max 4×10MB); Excel→CSV via `xlsx` in `backend/src/attachments.js`; Inhalt geht NUR im Upload-Turn ans Modell (Kosten!), Verlauf behält Marker + `messages.attachments`-Metadaten.
- **Diktat:** Web Speech API (Chrome/Edge/Safari), DE/EN-Umschalter unterm Composer.
- **Notifications:** Inbox, Conversation-Unread-State und Browser-Push werden über `POST /api/conversations/:id/read` gemeinsam quittiert. Ein sichtbar geöffneter Chat gilt sofort als gelesen; ein versteckter Tab erhält beim SSE-Abschluss eine lokale Service-Worker-Notification als Fallback. Der Dokumenttitel zeigt die Zahl offener Meldungen.
- **Impact Reporting:** `/api/admin/impact` aggregiert nur Metadaten. Zeitersparnis ist eine sichtbar erklärte Näherung (3 Min./Antwort + 2 Min./erfolgreichem Tool-Call + 8 Min./Datei), keine echte Zeiterfassung. `skill_usage_events` erfasst Auto-/Slash-/Tool-Nutzung; niemals daraus individuelle Leistungsbewertung ableiten.

## Datenmodell (Migrations 0001–0006)

`profiles` (is_admin, primäre `department`, alle `departments[]`) · `contexts` (personal/team; `personal_profile` ohne Admin-Bypass) · `skill_contexts` (required/optional) · `conversations` (user_id, pod_id) · `messages` (role inkl. compaction, thinking, tool_calls, attachments, author_id) · `llm_usage` · `wiki_pages` (space_id) · `wiki_chunks` (pgvector 384, RPC `match_wiki_chunks`) · `knowledge_updates` · `ui_change_requests` (Member-eigene UX/UI-Anfragen, Admin-Review/Umsetzung) · `spaces`/`space_members`/`space_connections` (Dust-Spaces) · `pods` (Project Pulse: project_status/current_focus/target_date) · `pod_members` · `pod_tasks` (Beschreibung, Priorität, offen/in Arbeit/blockiert/erledigt) · `pod_task_comments` · `pod_files` (+ Storage-Bucket `pod-files`) · Helper `is_pod_visible()` SECURITY DEFINER. Restricted Pods sind ausnahmslos invitation-only, auch für Admins.

**RLS-Falle (2× gestolpert):** Neue Tabellen brauchen GRANTs (`grant … to authenticated/service_role`). Und: SELECT-Policies dürfen für die eigene Tabelle KEINE Security-Definer-Selbst-Requery-Funktion nutzen (INSERT..RETURNING sieht die Zeile sonst nicht) — inline schreiben.

## Bekannte Grenzen / nächste Schritte (Details in HANDOFF)

1. **Wissens-Update-Loop** (Enni schlägt Wiki-Diffs vor, Mensch gibt frei) — Kern-Differenzierer, Tabelle existiert, Flow fehlt. **Wichtigster nächster Schritt vor der Demo.**
2. Enni respektiert Space-Rechte noch nicht im Tool-Layer (Restricted-Space-Wissen wäre für alle abfragbar, aktuell liegt aber alles in Company Data = open).
3. Pod-Dateien sind über Pod-Tools lesbar; echte Datei-Versionierung und Task-Dateiverknüpfung fehlen noch.
4. Project Pulse, Aufgabenliste und das alternative Kanban-Board sind live; Meilensteine und strukturierte Projektentscheidungen sind bewusst spätere Ausbaustufen.
5. RAG-Re-Index nach Wiki-Änderungen manuell (Script-Pattern in HANDOFF §6; Embed-Function-Limit: max. 2 lange Texte pro Call).
6. Crawl-Qualität mancher Doku-Seiten (Navigations-Reste) — Re-Crawl irgendwann.

## Arbeitsweise

- Aleksa ist non-technical — kurz, deutsch, ein Schritt nach dem anderen.
- Kein lokales Node voraussetzen. Frontend-Preview: `npx http-server frontend -p 5173` (Port 5173 ist im Backend-CORS).
- Design-Referenz `design/mockup-v5.html` + Dust.tt als IA-Vorbild (Enni-Research: claude-team `ai-team/agents/enni-enneo/knowledge/company-os-dust-research.md`).
- Kern-Prinzipien: EIN Agent · Rechte der fragenden Person · Wissens-Änderungen nur als Diff mit Freigabe · Kosten transparent an jeder Antwort · kein Slack-Nachbau.
