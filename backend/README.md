# enneo OS — Backend

Node-Backend für Enni: Anthropic-SDK-Tool-Loop + Supabase-Persistenz + SSE-Streaming.

## Architektur

```
Frontend ── POST /api/chat (SSE) ──▶ Express (src/index.js)
                                        │
                                        ├─ Auth: Supabase-User-JWT verifizieren
                                        ├─ Tool-Loop (src/agent.js, Claude claude-opus-4-8)
                                        │    ├─ wiki_list_pages / wiki_read_page / wiki_search  → Supabase wiki_pages
                                        │    └─ gitlab_search_projects / _search_code / _read_file / _list_merge_requests → GitLab REST (read-only)
                                        ├─ Persistenz: conversations, messages (content + thinking + tool_calls)
                                        └─ Kosten: llm_usage (Tokens + cost_eur pro Antwort)
```

**Bewusste Entscheidung:** offizielles `@anthropic-ai/sdk` mit manuellem Tool-Loop statt Claude-Agent-SDK.
Gleiche API, aber volle Kontrolle über das, was der MVP zeigen muss (Gedankenkette + Tool-Calls in DB,
`cost_eur` pro Antwort) und läuft auf jedem Node-Hosting. Agent-SDK bleibt Option für Phase 2 (Skills, Subagents).

## Endpoints

| Route | Auth | Beschreibung |
|---|---|---|
| `GET /health` | — | Healthcheck |
| `POST /api/chat` | `Authorization: Bearer <Supabase-User-JWT>` | Body `{conversation_id?, message}`. Antwort ist ein SSE-Stream. |

SSE-Events: `conversation` (id), `thinking_delta`, `text_delta`, `tool_use`, `tool_result`, `done` (message_id, cost_eur, usage), `error`.

Konversations-Liste + Verlauf liest das Frontend direkt aus Supabase (RLS owner-only) — dafür braucht es kein Backend.

## Env-Vars

Siehe `.env.example`. Secrets nie committen — auf dem Hosting (Railway/Render/Fly) als Env-Vars setzen.

## Lokal starten / deployen

```bash
cd backend && npm install && npm start   # braucht Node >= 20
```

Deploy-Ziel ist noch offen (HANDOFF Punkt 3). Railway: Repo verbinden, Root-Directory `backend`, Env-Vars setzen, fertig.
