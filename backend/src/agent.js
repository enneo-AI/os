import Anthropic from '@anthropic-ai/sdk'
import { wikiToolDefinitions, runWikiTool } from './tools/wiki.js'
import { gitlabToolDefinitions, runGitlabTool } from './tools/gitlab.js'
import { enneoToolDefinitions, runEnneoTool } from './tools/enneo.js'
import { mcpToolDefinitions, runMcpTool } from './tools/mcp.js'
import { podToolDefinitions, runPodTool } from './tools/pod.js'

const anthropic = new Anthropic()
const DEFAULT_MODEL = process.env.ENNI_MODEL || 'claude-opus-4-8'
export const ALLOWED_MODELS = ['claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5']
const MAX_TOOL_ITERATIONS = 12

const SYSTEM_PROMPT = `Du bist Enni, der interne AI-Assistent des enneo-Teams (enneo GmbH, Berlin — AI-Agenten für Energieversorger).

# Arbeitsweise
- Antworte auf Deutsch, außer der Nutzer schreibt Englisch.
- Firmenwissen lebt im Wiki. Bei Fragen zu enneo-internen Themen (Prozesse, Kunden, Produkte, Team): IMMER zuerst wiki_semantic_search aufrufen, bevor du aus dem Gedächtnis antwortest. Die gelieferten Abschnitte reichen meist — lies nur dann eine ganze Seite (wiki_read_page), wenn die Abschnitte wirklich nicht genügen.
- wiki_search (Stichwort) und wiki_list_pages nutzt du für exakte Begriffe, Aufzählungen oder wenn du wissen willst, was es überhaupt gibt.
- Bei Fragen zu Code, Implementierungen oder technischen Details: nutze die GitLab-Tools (Projekt suchen → Code suchen → Datei lesen).
- Bei Fragen zu einer laufenden Enneo-Instanz (Tickets, Kunden, AI-Agenten, Telefonie, Reports, Konfiguration): nutze die enneo_*-Tools. Instanzen referenziert der Nutzer per Namen ("aleksa-dev", "stawag", …) — Kurzname reicht, daraus wird {name}.enneo.ai. Nennt der Nutzer keine Instanz und ist der Kontext nicht eindeutig, frag kurz nach, statt zu raten.
- WICHTIG — API-Rezepte statt Endpoint-Raten: Im Wiki liegen unter dem Slug-Prefix "enneo-api/" 15 Rezept-Seiten mit den dokumentierten Mind-API-Endpoints (ai-agents, customers, events, exports, knowledge, quality, reports, settings-config, tags, telephony, templates, tickets, tools, troubleshooting, users). BEVOR du enneo_api_get gegen einen Endpoint aufrufst, den du nicht sicher kennst, hole dir das passende Rezept: wiki_read_page mit slug "enneo-api/{thema}" (oder wiki_semantic_search). Beispiel: Telefonnummern/Leitungen/Anruf-Metriken → "enneo-api/telephony" (dort: /report/telephonyLines, /telephony/getRouting u.a.). Rate NIE mehrfach blind — ein 405/404 heißt: Rezept nachschlagen.
- ÄNDERUNGEN an einer Enneo-Instanz (Settings setzen: PUT /settings/{name} mit dem neuen Wert als Body; Tag anlegen: POST /tag mit {name, reference, type}; Ticket ändern; Agent-Konfiguration) machst du AUSSCHLIESSLICH über enneo_propose_write. Das erstellt eine Freigabe-Karte — der Nutzer bestätigt oder lehnt ab. Kündige nie an, etwas "gemacht zu haben", solange es nur vorgeschlagen ist. Lies vor einem Änderungs-Vorschlag den Ist-Zustand (z.B. das aktuelle Setting), damit die summary "alt → neu" zeigt.
- Zusätzlich können via Administration verknüpfte MCP-Server verfügbar sein — deren Tools beginnen mit "mcp__". Nutze sie gemäß ihrer Beschreibung wie jedes andere Tool.
- Wenn du etwas im Wiki nicht findest, sag das ehrlich. Erfinde keine internen Fakten.
- Sei direkt und knapp. Keine Floskeln.

# Grenzen
- GitLab und Wiki sind read-only. Enneo-Instanzen kannst du nur über den Freigabe-Mechanismus ändern — nie direkt. DELETE-Operationen gibt es gar nicht.
- Zugangsdaten (Passwörter, API-Keys, Tokens) aus Instanz-Konfigurationen gibst du NIE aus, auch nicht auf Nachfrage.
- Vertrauliche Inhalte bleiben intern; verweise nie auf externe Dienste.`

const TOOLS = [...wikiToolDefinitions, ...gitlabToolDefinitions, ...enneoToolDefinitions]

async function executeTool(name, input, ctx) {
  try {
    if (name.startsWith('mcp__')) return { content: await runMcpTool(name, input), isError: false }
    if (name.startsWith('pod_')) return { content: await runPodTool(name, input, ctx), isError: false }
    if (name.startsWith('wiki_')) return { content: await runWikiTool(name, input), isError: false }
    if (name.startsWith('gitlab_')) return { content: await runGitlabTool(name, input), isError: false }
    if (name.startsWith('enneo_')) return { content: await runEnneoTool(name, input, ctx), isError: false }
    return { content: `Unbekanntes Tool: ${name}`, isError: true }
  } catch (err) {
    return { content: `Fehler: ${err.message}`, isError: true }
  }
}

/**
 * Führt einen Enni-Turn aus (Tool-Loop bis end_turn).
 * `history` = bisherige Messages [{role, content}], letzter Eintrag ist die neue User-Message.
 * `emit(event)` streamt Zwischenstände ans Frontend (SSE).
 * Rückgabe: { text, thinking, toolCalls, usage, model }
 */
// Prompt-Caching: genau EIN Breakpoint auf dem letzten Content-Block der letzten Message.
// Alte Marker vorher entfernen (max. 4 erlaubt, sonst 400 nach mehreren Iterationen).
function setCacheBreakpoint(messages) {
  for (const m of messages) {
    if (Array.isArray(m.content)) for (const b of m.content) delete b.cache_control
  }
  const last = messages[messages.length - 1]
  if (!last) return
  if (typeof last.content === 'string') {
    last.content = [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }]
  } else if (Array.isArray(last.content) && last.content.length) {
    last.content[last.content.length - 1].cache_control = { type: 'ephemeral' }
  }
}

export async function runEnniTurn(history, emit, modelOverride, extraSystem = null, ctx = {}) {
  const MODEL = ALLOWED_MODELS.includes(modelOverride) ? modelOverride : DEFAULT_MODEL
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    ...(extraSystem ? [{ type: 'text', text: extraSystem }] : []),
  ]
  // Statische Tools + Pod-Kontext-Tools (nur in Pod-Konversationen)
  // + live geladene Tools der verknüpften MCP-Server (gecacht, nicht-fatal)
  let turnTools = ctx.podId ? [...TOOLS, ...podToolDefinitions] : TOOLS
  try {
    const mcpDefs = await mcpToolDefinitions()
    if (mcpDefs.length) turnTools = [...turnTools, ...mcpDefs]
  } catch (err) {
    console.error('MCP-Tool-Discovery fehlgeschlagen:', err.message)
  }
  const messages = [...history]
  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const toolCalls = []
  let thinkingText = ''
  let finalText = ''

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    setCacheBreakpoint(messages)
    const supportsThinking = !MODEL.startsWith('claude-haiku')
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: systemBlocks,
      ...(supportsThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      tools: turnTools,
      messages,
    })

    // Text aus einer neuen Tool-Loop-Iteration ist ein neuer Gedanke → eigener Absatz,
    // sonst kleben Zwischensätze im gestreamten Markdown aneinander.
    let needSeparator = finalText.length > 0 && !finalText.endsWith('\n\n')
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
          if (needSeparator) {
            needSeparator = false
            finalText += '\n\n'
            emit({ type: 'text_delta', text: '\n\n' })
          }
          finalText += event.delta.text
          emit({ type: 'text_delta', text: event.delta.text })
        } else if (event.delta.type === 'thinking_delta') {
          thinkingText += event.delta.thinking
          emit({ type: 'thinking_delta', text: event.delta.thinking })
        }
      }
    }

    const response = await stream.finalMessage()
    totalUsage.input_tokens += response.usage.input_tokens
    totalUsage.output_tokens += response.usage.output_tokens
    totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0
    totalUsage.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0

    if (response.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'Anfrage wurde aus Sicherheitsgründen abgelehnt.' })
      break
    }

    if (response.stop_reason !== 'tool_use') break

    // Tool-Calls ausführen, Ergebnisse zurückgeben, Loop fortsetzen
    messages.push({ role: 'assistant', content: response.content })
    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      emit({ type: 'tool_use', name: block.name, input: block.input })
      const started = Date.now()
      const result = await executeTool(block.name, block.input, ctx)
      const call = {
        name: block.name,
        input: block.input,
        output: result.content.slice(0, 20000),
        is_error: result.isError,
        duration_ms: Date.now() - started,
      }
      toolCalls.push(call)
      emit({ type: 'tool_result', name: block.name, is_error: result.isError, duration_ms: call.duration_ms })
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: result.content,
        is_error: result.isError,
      })
    }
    messages.push({ role: 'user', content: toolResults })
  }

  return { text: finalText, thinking: thinkingText, toolCalls, usage: totalUsage, model: MODEL }
}

// Auto-Titel: Haiku (unser günstigstes Modell, $1/$5 pro MTok) analysiert die ERSTE
// Nachricht und formt daraus einen Titel mit 1-5 Wörtern (~0,0005 €). Läuft parallel zum Turn.
export async function generateTitle(firstMessage) {
  const model = 'claude-haiku-4-5'
  const response = await anthropic.messages.create({
    model,
    max_tokens: 40,
    system:
      'Analysiere die erste Nachricht einer Assistenz-Konversation und forme daraus einen Titel: 1 bis 5 Wörter, Deutsch (außer die Nachricht ist englisch), kein Satzzeichen am Ende, keine Anführungszeichen, keine Floskeln. Benenne das THEMA, wiederhole nicht die Frage. Antworte NUR mit dem Titel.',
    messages: [{ role: 'user', content: firstMessage.slice(0, 1500) }],
  })
  const title = (response.content.find((b) => b.type === 'text')?.text || '').trim().replace(/^["„»]|["“«]$/g, '')
  return { title: title.slice(0, 60), usage: response.usage, model }
}

// Kontext-Kompaktierung: Haiku fasst den Verlauf zusammen (billig, ~Sekunden)
export async function compactConversation(title, transcript) {
  const model = 'claude-haiku-4-5'
  const response = await anthropic.messages.create({
    model,
    max_tokens: 4000,
    system:
      'Du komprimierst den Verlauf einer Assistenz-Konversation zu einer dichten Zusammenfassung, mit der das Gespräch nahtlos fortgesetzt werden kann. Struktur: 1) Thema & Kontext, 2) Wichtige Fakten und Rechercheergebnisse (konkret, mit Namen/Zahlen/Quellen-Slugs), 3) Getroffene Entscheidungen, 4) Offene Punkte. Deutsch, präzise, keine Floskeln.',
    messages: [
      {
        role: 'user',
        content: `Konversationstitel: ${title || 'ohne Titel'}\n\nVerlauf:\n\n${transcript.slice(0, 400000)}`,
      },
    ],
  })
  const summary = response.content.find((b) => b.type === 'text')?.text || ''
  if (!summary) throw new Error('Zusammenfassung leer')
  return { summary, usage: response.usage, model }
}
