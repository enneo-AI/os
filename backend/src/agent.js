import Anthropic from '@anthropic-ai/sdk'
import { wikiToolDefinitions, runWikiTool } from './tools/wiki.js'
import { gitlabToolDefinitions, runGitlabTool } from './tools/gitlab.js'

const anthropic = new Anthropic()
const DEFAULT_MODEL = process.env.ENNI_MODEL || 'claude-opus-4-8'
export const ALLOWED_MODELS = ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5']
const MAX_TOOL_ITERATIONS = 12

const SYSTEM_PROMPT = `Du bist Enni, der interne AI-Assistent des enneo-Teams (enneo GmbH, Berlin — AI-Agenten für Energieversorger).

# Arbeitsweise
- Antworte auf Deutsch, außer der Nutzer schreibt Englisch.
- Firmenwissen lebt im Wiki. Bei Fragen zu enneo-internen Themen (Prozesse, Kunden, Produkte, Team): IMMER zuerst wiki_semantic_search aufrufen, bevor du aus dem Gedächtnis antwortest. Die gelieferten Abschnitte reichen meist — lies nur dann eine ganze Seite (wiki_read_page), wenn die Abschnitte wirklich nicht genügen.
- wiki_search (Stichwort) und wiki_list_pages nutzt du für exakte Begriffe, Aufzählungen oder wenn du wissen willst, was es überhaupt gibt.
- Bei Fragen zu Code, Implementierungen oder technischen Details: nutze die GitLab-Tools (Projekt suchen → Code suchen → Datei lesen).
- Wenn du etwas im Wiki nicht findest, sag das ehrlich. Erfinde keine internen Fakten.
- Sei direkt und knapp. Keine Floskeln.

# Grenzen
- Du hast nur Lesezugriff. Du kannst nichts in GitLab oder im Wiki ändern.
- Vertrauliche Inhalte bleiben intern; verweise nie auf externe Dienste.`

const TOOLS = [...wikiToolDefinitions, ...gitlabToolDefinitions]

async function executeTool(name, input) {
  try {
    if (name.startsWith('wiki_')) return { content: await runWikiTool(name, input), isError: false }
    if (name.startsWith('gitlab_')) return { content: await runGitlabTool(name, input), isError: false }
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

export async function runEnniTurn(history, emit, modelOverride) {
  const MODEL = ALLOWED_MODELS.includes(modelOverride) ? modelOverride : DEFAULT_MODEL
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
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      thinking: { type: 'adaptive', display: 'summarized' },
      tools: TOOLS,
      messages,
    })

    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') {
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
      const result = await executeTool(block.name, block.input)
      const call = {
        name: block.name,
        input: block.input,
        output: result.content.slice(0, 2000),
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
