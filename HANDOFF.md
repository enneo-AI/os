# HANDOFF — Stand & nächste Schritte

**Zuletzt aktualisiert:** 2026-07-03 (abends — Schema live)

## Erledigt

- [x] Konzept + Dust.tt-Research (claude-team: `ai-team/agents/enni-enneo/knowledge/company-os-dust-research.md` + knowledge.md §89)
- [x] Klickbares Design-Mockup v5, von Aleksa final validiert (`design/mockup-v5.html`)
- [x] Konzept-Pivot: EIN Agent (Enni) statt Agenten-Zoo; Wiki als Notion-Ersatz; Slack-Abgrenzung
- [x] Supabase-Projekt `enneo OS` angelegt (aiwhomrvspfxotkllngz, Frankfurt, Google-SSO geplant)
- [x] GitHub-Repo `enneo-AI/os` + lokaler Clone `~/Desktop/Projects/enneo-os` + Auth eingerichtet
- [x] Repo-Grundgerüst (README, CLAUDE.md, docs, design)
- [x] **DB-Schema live** (2026-07-03): `supabase/migrations/0001_mvp_schema.sql` via Management API eingespielt — `profiles` (auto-angelegt bei SSO-Signup, `is_admin`-Flag), `conversations`, `messages` (inkl. `thinking` + `tool_calls` jsonb fürs Gedankenketten-Panel), `llm_usage` (Token + `cost_eur` pro Antwort, source chat/routine), `wiki_pages` (Markdown), `knowledge_updates` (Diff + proposed/approved/rejected). RLS auf allen 6 Tabellen: Conversations/Messages owner-only, Wiki org-weit, `llm_usage`- und `knowledge_updates`-Inserts nur via Backend (service_role). PostgREST exponiert `public` (geprüft).

## Als Nächstes (MVP Phase 1)

1. [ ] **Google-SSO aktivieren:** Google-OAuth-Client (Client-ID + Secret) in der Google Cloud Console der enneo-Org anlegen → in Supabase Auth als Provider eintragen. Braucht Aleksa (Zugang zur enneo Google-Org klären).
2. [ ] **Node-Backend mit Claude Agent SDK:** ein Enni-Agent, LLM-Wrapper mit usage-Logging, Tools `wiki.read_page` / `wiki.search` / Attio read-only (offizieller MCP `mcp.attio.com`)
3. [ ] **Backend-Hosting wählen** (Railway/Render/Fly — Edge Functions scheiden aus wegen Agent-Loop-Timeouts)
4. [ ] **Frontend:** Chat im v5-Design (Streaming, Gedankenkette, Tool-Detail-Panel), Login via Supabase Google-SSO
5. [ ] **Wissens-Update-Loop:** Diff-Vorschlag → Freigabe → Wiki-Seite aktualisiert → Audit-Eintrag

## Offene Entscheidungen

- [ ] Anthropic-API-Account: eigener Key vs. enneo-Rechnung (spätestens beim Founder-Pitch klären)
- [ ] Founder-Pitch-Termin: MVP-Demo als Kernstück der Team-Präsentation
- [ ] Block-Editor-Library für Wiki-Phase-2 (BlockNote vs. Tiptap — nicht selbst bauen)

## Bewusst NICHT im MVP

Pods, Block-Editor, Connectors-UI, Admin-Dashboards, Routinen/Scheduler, Slack-Anbindung.
