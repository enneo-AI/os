# HANDOFF — Stand & nächste Schritte

**Zuletzt aktualisiert:** 2026-07-03

## Erledigt

- [x] Konzept + Dust.tt-Research (claude-team: `ai-team/agents/enni-enneo/knowledge/company-os-dust-research.md` + knowledge.md §89)
- [x] Klickbares Design-Mockup v5, von Aleksa final validiert (`design/mockup-v5.html`)
- [x] Konzept-Pivot: EIN Agent (Enni) statt Agenten-Zoo; Wiki als Notion-Ersatz; Slack-Abgrenzung
- [x] Supabase-Projekt `enneo OS` angelegt (aiwhomrvspfxotkllngz, Frankfurt, Google-SSO geplant)
- [x] GitHub-Repo `enneo-AI/os` + lokaler Clone `~/Desktop/Projects/enneo-os` + Auth eingerichtet
- [x] Repo-Grundgerüst (README, CLAUDE.md, docs, design)

## Als Nächstes (MVP Phase 1)

1. [ ] **DB-Schema als Migration:** `conversations`, `messages`, `llm_usage`, `wiki_pages` (Markdown), `knowledge_updates` (Diff + Status) — RLS-Policies, Google-SSO-Auth konfigurieren
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
