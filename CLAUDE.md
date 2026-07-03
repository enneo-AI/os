# enneo OS — Projekt-Kontext für Claude-Code-Sessions

**Was:** Internes AI-Workbench-System für das enneo-Team. Ein Agent (Enni) + Wiki (Notion-Ersatz) + Connectors + Admin. Owner: Aleksa (AI Implementation Manager bei enneo). Status: MVP-Bau vor dem Founder-Pitch — noch nicht mit Richard/Kyung besprochen.

**Rolle dieser Codebase:** Das Repo gehört der enneo-AI GitHub-Org. Alle Inhalte sind enneo-vertraulich (§ 9 Rahmenvertrag) — keine Kundendaten committen, keine Secrets committen.

## Infrastruktur

| Was | Wert |
|---|---|
| Supabase-Projekt | `enneo OS` · ref `aiwhomrvspfxotkllngz` · eu-central-1 · Org "Enneo AI" |
| Supabase-PAT | `~/.supabase/access-token-enneo-companyos` (Backup: claude-team `ai-team/agents/enni-enneo/.env`) |
| GitHub-Auth | macOS Keychain, eigener Eintrag für enneo-AI (username `x-access-token`, fine-grained PAT, nur dieses Repo) |
| Anon/Service-Keys | nie lokal cachen — live via Management API: `curl -s -H "Authorization: Bearer $(cat ~/.supabase/access-token-enneo-companyos)" https://api.supabase.com/v1/projects/aiwhomrvspfxotkllngz/api-keys` |

## Arbeitsweise

- Aleksa ist non-technical — Erklärungen kurz, deutsch, ein Schritt nach dem anderen
- Kein lokales Node.js voraussetzen: Deploy via git push + Supabase Management API; DB-Änderungen als SQL-Migrations über die Management API (`POST /v1/projects/{ref}/database/query`)
- Design-Referenz ist `design/mockup-v5.html` — Look ist final validiert (helles Premium-Glass, flache Sidebar, Gedankenkette mit Tool-Detail-Panel, KEINE unnötigen Container). Bei UI-Arbeit zuerst dort nachsehen.
- Konzept-Herkunft: Dust.tt-Analyse + eigene Architektur-Entscheidungen, dokumentiert in `docs/konzept.md`

## Kern-Prinzipien (bei jeder Änderung einhalten)

1. Ein Agent (Enni) — Skills lazy-loaded, Routinen mit Owner statt Agent-Personas
2. Enni läuft mit den Rechten der fragenden Person (personal Credentials)
3. Wissens-Änderungen nur als Diff mit menschlicher Freigabe, nie Auto-Apply
4. Jede Aktion im Audit-Log mit Mensch/KI-Attribution; `llm_usage` pro Antwort
5. Kein Slack-Nachbau (News/Alerts/Kommunikation bleiben in Slack)
