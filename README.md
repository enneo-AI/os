# enneo OS

Internes AI-Workbench-System für das enneo-Team (~20 Personen): **Enni** (ein selbstlernender Agent für alle Abteilungen) + **Wiki** (Notion-Ersatz) + **Connectors** + **Admin**.

## Stack

- **Datenbank/Auth:** Supabase (Postgres + pgvector, Google-SSO, eu-central-1) — Projekt `enneo OS` (`aiwhomrvspfxotkllngz`)
- **Agent-Runtime:** Node-Backend mit Claude Agent SDK (deployed, keine Edge Functions — Agent-Loops brauchen lange Laufzeiten)
- **Frontend:** Web-App im validierten v5-Design (siehe `design/`)
- **Integrationen:** dünne MCP-Adapter (Attio via offiziellem `mcp.attio.com`, Slack read-only, GitLab read-only)

## Kern-Prinzipien (nicht verhandelbar)

1. **Ein Agent (Enni), keine Agenten-Zoo** — Skills werden je Frage geladen, Routinen statt Agent-Personas
2. **Enni läuft mit den Rechten der fragenden Person** — personal Credentials, Space-basierte Quellen
3. **Selbstlernen = Diff mit Freigabe** — Enni ändert Wiki-Wissen nie direkt, immer als genehmigter Diff
4. **Audit mit Mensch/KI-Attribution** von Tag 1, `llm_usage`-Tracking an jeder Antwort
5. **Kein Slack-Nachbau** — News, Alerts und Kommunikation bleiben in Slack

## MVP-Schnitt (Phase 1)

Login (Google-SSO) → Chat mit Enni (Gedankenkette, Tool-Detail) → 2-3 echte Tools (`wiki.read_page`, `wiki.search`, Attio read-only) → Wissens-Update-Diff auf Markdown-Wiki-Seiten.

**Bewusst später:** Pods, Block-Editor (BlockNote/Tiptap), Connectors-UI, Admin-Dashboards, Routinen.

## Referenzen

- Klickbares Design-Mockup: `design/mockup-v5.html`
- Konzept + Architektur-Entscheidungen: `docs/konzept.md`
- Stand & nächste Schritte: `HANDOFF.md`
