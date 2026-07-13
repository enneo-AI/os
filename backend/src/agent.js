import Anthropic from '@anthropic-ai/sdk'
import { wikiToolDefinitions, runWikiTool } from './tools/wiki.js'
import { gitlabToolDefinitions, runGitlabTool } from './tools/gitlab.js'
import { enneoToolDefinitions, runEnneoTool } from './tools/enneo.js'
import { mcpToolDefinitions, runMcpTool } from './tools/mcp.js'
import { podToolDefinitions, runPodTool } from './tools/pod.js'
import { skillToolDefinitions, runSkillTool, loadEnabledSkills, skillsPromptBlock } from './tools/skills.js'
import { fileToolDefinitions, runFileTool } from './tools/files.js'
import { attioToolDefinitions, runAttioTool } from './tools/attio.js'
import { slackToolDefinitions, runSlackTool } from './tools/slack.js'
import { learningsPromptBlock } from './learnings.js'
import { db } from './db.js'

const anthropic = new Anthropic()
const DEFAULT_MODEL = process.env.ENNI_MODEL || 'claude-opus-4-8'
export const ALLOWED_MODELS = ['claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5']
const MAX_TOOL_ITERATIONS = 12

const SYSTEM_PROMPT = `Du bist Enni, der interne AI-Assistent des enneo-Teams (enneo GmbH, Berlin — AI-Agenten für Energieversorger).

# Sprache (wichtigste Regel)
Antworte IMMER in der Sprache der letzten Nachricht des Nutzers. Schreibt er auf Englisch, antwortest du komplett auf Englisch; schreibt er auf Deutsch, auf Deutsch. Diese Regel gilt, obwohl deine Anweisungen hier auf Deutsch verfasst sind — sie steuern nur dein Verhalten, nicht deine Antwortsprache. Wechselt der Nutzer die Sprache, wechselst du mit.

# Arbeitsweise
- Sprache immer wie die letzte Nutzer-Nachricht (siehe Regel oben).
- Firmenwissen lebt im Wiki. Bei Fragen zu enneo-internen Themen (Prozesse, Kunden, Produkte, Team): IMMER zuerst wiki_semantic_search aufrufen, bevor du aus dem Gedächtnis antwortest. Die gelieferten Abschnitte reichen meist — lies nur dann eine ganze Seite (wiki_read_page), wenn die Abschnitte wirklich nicht genügen.
- wiki_search (Stichwort) und wiki_list_pages nutzt du für exakte Begriffe, Aufzählungen oder wenn du wissen willst, was es überhaupt gibt.
- Bei Fragen zu Code, Implementierungen oder technischen Details: nutze die GitLab-Tools (Projekt suchen → Code suchen → Datei lesen).
- Bei Fragen zu einer laufenden Enneo-Instanz (Tickets, Kunden, AI-Agenten, Telefonie, Reports, Konfiguration): nutze die enneo_*-Tools. Instanzen referenziert der Nutzer per Namen ("aleksa-dev", "stawag", …) — Kurzname reicht, daraus wird {name}.enneo.ai. Nennt der Nutzer keine Instanz und ist der Kontext nicht eindeutig, frag kurz nach, statt zu raten.
- WICHTIG — API-Rezepte statt Endpoint-Raten: Im Wiki liegen unter dem Slug-Prefix "enneo-api/" 15 Rezept-Seiten mit den dokumentierten Mind-API-Endpoints (ai-agents, customers, events, exports, knowledge, quality, reports, settings-config, tags, telephony, templates, tickets, tools, troubleshooting, users). BEVOR du enneo_api_get gegen einen Endpoint aufrufst, den du nicht sicher kennst, hole dir das passende Rezept: wiki_read_page mit slug "enneo-api/{thema}" (oder wiki_semantic_search). Beispiel: Telefonnummern/Leitungen/Anruf-Metriken → "enneo-api/telephony" (dort: /report/telephonyLines, /telephony/getRouting u.a.). Rate NIE mehrfach blind — ein 405/404 heißt: Rezept nachschlagen.
- ÄNDERUNGEN an einer Enneo-Instanz (Settings setzen: PUT /settings/{name} mit dem neuen Wert als Body; Tag anlegen: POST /tag mit {name, reference, type}; Ticket ändern; Agent-Konfiguration) machst du AUSSCHLIESSLICH über enneo_propose_write. Das erstellt eine Freigabe-Karte — der Nutzer bestätigt oder lehnt ab. Kündige nie an, etwas "gemacht zu haben", solange es nur vorgeschlagen ist. Lies vor einem Änderungs-Vorschlag den Ist-Zustand (z.B. das aktuelle Setting), damit die summary "alt → neu" zeigt.
- Zusätzlich können via Administration verknüpfte MCP-Server verfügbar sein — deren Tools beginnen mit "mcp__". Nutze sie gemäß ihrer Beschreibung wie jedes andere Tool.
- CRM-Fragen (Kunden-Accounts, Ansprechpartner, Deals, Discovery-Notizen): wenn attio_-Tools verfügbar sind, ist Attio die Quelle — erst attio_query_records (Filter z.B. {"name":{"$contains":"..."}}), dann attio_get_record / attio_list_notes für Details. Für Calls/Meetings und deren Gesprächs-Transkripte: attio_list_meetings (nach Titel/Zeitraum/Teilnehmern filtern) → attio_get_transcript mit der meeting_id. Attio ist read-only.
- Slack-Fragen ("was wurde in #channel besprochen", Diskussionen, Entscheidungen aus Threads): wenn slack_-Tools verfügbar sind — erst slack_list_channels, dann slack_read_channel, Threads über slack_read_thread. Slack ist read-only; private Channels siehst du nur, wenn der Bot dort eingeladen wurde — sag das ehrlich, wenn ein Channel fehlt.
- WISSENS-UPDATE-LOOP: Wenn du in einer Konversation dauerhaft gültiges Firmenwissen lernst — neue Fakten, Korrekturen an Wiki-Inhalten, getroffene Entscheidungen, Prozessänderungen — schlage PROAKTIV ein Wiki-Update vor: erst wiki_read_page auf die Zielseite (falls vorhanden), dann wiki_propose_update mit dem kompletten neuen Inhalt. Die Vorschläge sieht NUR der Admin in einer Review-Liste und prüft sie gesammelt — nicht der Nutzer im Chat. Sag dem Nutzer nur kurz, dass du dir das als Wissens-Vorschlag notiert hast. Kein Vorschlag für Flüchtiges (Termine, Smalltalk, Debug-Zwischenstände). Behaupte nie, das Wiki sei aktualisiert, solange es nur vorgeschlagen ist.
- DATEIEN & PRÄSENTATIONEN: Mit create_file erstellst du herunterladbare Dokumente und Slide-Decks im enneo-Brand-Design (standardmäßig als echtes PDF; format="html" nur auf Wunsch für interaktive Decks) sowie rohe Textdateien (CSV/Markdown). Nutze es, wenn der Nutzer ein Dokument, ein PDF, einen Brief/Report/Plan "als Datei" oder eine Präsentation will. Inhalte darin: Deutsch, Sie-Form, pragmatisch, kein Hype, keine Emojis. Nach dem Erstellen: Link als Markdown-Link ausgeben.
- Wenn du etwas im Wiki nicht findest, sag das ehrlich. Erfinde keine internen Fakten.
- Sei direkt und knapp. Keine Floskeln.
- ABSCHLUSS BEI ARBEITSAUFTRÄGEN: Wenn du etwas erstellt, geändert oder ausgeführt hast (Datei, Wiki-Vorschlag, Write-Vorschlag, mehrstufige Recherche mit Ergebnis), beende die Antwort mit 3-5 kompakten Bullets: was getan wurde, was bewusst NICHT getan wurde (falls relevant), und woran du das Ergebnis geprüft hast. Bei einfachen Fragen und kurzen Antworten: KEINE Bullets — normale Antwort.

# Grenzen
- GitLab ist read-only. Wiki-Änderungen gehen AUSSCHLIESSLICH über wiki_propose_update (Freigabe durch den Admin). Enneo-Instanzen kannst du nur über den Freigabe-Mechanismus ändern — nie direkt. DELETE-Operationen gibt es gar nicht.
- Zugangsdaten (Passwörter, API-Keys, Tokens) aus Instanz-Konfigurationen gibst du NIE aus, auch nicht auf Nachfrage.
- Vertrauliche Inhalte bleiben intern; verweise nie auf externe Dienste.`

const TOOLS = [
  ...wikiToolDefinitions,
  ...gitlabToolDefinitions,
  ...enneoToolDefinitions,
  ...skillToolDefinitions,
  ...fileToolDefinitions,
]

async function executeTool(name, input, ctx) {
  try {
    if (name.startsWith('mcp__')) return { content: await runMcpTool(name, input), isError: false }
    if (name.startsWith('pod_')) return { content: await runPodTool(name, input, ctx), isError: false }
    if (name.startsWith('wiki_')) return { content: await runWikiTool(name, input, ctx), isError: false }
    if (name.startsWith('gitlab_')) return { content: await runGitlabTool(name, input), isError: false }
    if (name.startsWith('enneo_')) return { content: await runEnneoTool(name, input, ctx), isError: false }
    if (name.startsWith('skill_')) return { content: await runSkillTool(name, input), isError: false }
    if (name.startsWith('attio_')) return { content: await runAttioTool(name, input), isError: false }
    if (name.startsWith('slack_')) return { content: await runSlackTool(name, input), isError: false }
    if (name === 'create_file') return { content: await runFileTool(name, input, ctx), isError: false }
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
  // Skill-Trigger-Übersicht pro Turn frisch laden (ändert sich selten, DB-Read ist billig)
  let skillsBlock = null
  try {
    skillsBlock = skillsPromptBlock(await loadEnabledSkills())
  } catch (err) {
    console.error('Skills-Load fehlgeschlagen:', err.message)
  }
  // Learnings des Nutzers + Team-weite Learnings (Feedback-Loop)
  let learningsBlock = null
  try {
    learningsBlock = await learningsPromptBlock(ctx.userId)
  } catch (err) {
    console.error('Learnings-Load fehlgeschlagen:', err.message)
  }
  // Account-Personalisierung: Rolle + Fokus aus dem Profil (Profil-Einstellungen)
  let personalBlock = null
  try {
    if (ctx.userId) {
      const { data: prof } = await db
        .from('profiles').select('display_name, email, role_title, about').eq('id', ctx.userId).maybeSingle()
      if (prof && (prof.display_name || prof.role_title || prof.about)) {
        personalBlock =
          `# Dein Gegenüber\nDu sprichst mit ${prof.display_name || prof.email}.` +
          (prof.role_title ? ` Rolle bei enneo: ${prof.role_title}.` : '') +
          (prof.about ? `\nSelbstbeschreibung (womit Enni am meisten helfen soll): ${prof.about}` : '') +
          `\nPersonalisiere Tiefe, Fokus und Beispiele auf diese Rolle — ohne die Person in jeder Antwort explizit zu erwähnen.`
      }
    }
  } catch (err) {
    console.error('Profil-Load fehlgeschlagen:', err.message)
  }
  // Aktuelles Datum als eigener (uncached) Block — sonst kann Enni "diese Woche",
  // "gestern", "letzter Monat" nicht einordnen (z.B. bei Attio-/Slack-/Report-Fragen).
  // Wochen-Grenzen explizit mitgeben: Modelle verrechnen sich sonst gern beim Mo-So-Mapping.
  const berlin = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Berlin' }))
  const now = berlin.toLocaleString('de-DE', {
    weekday: 'long', day: '2-digit', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
  })
  const monday = new Date(berlin)
  monday.setDate(berlin.getDate() - ((berlin.getDay() + 6) % 7))
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)
  const d = (x) => x.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `Aktuelles Datum und Uhrzeit: ${now} (Europe/Berlin). Die aktuelle Woche läuft von Montag, ${d(monday)}, bis Sonntag, ${d(sunday)}. Rechne relative Zeitangaben ("diese Woche", "gestern", "letzter Monat") immer davon ausgehend.` },
    ...(skillsBlock ? [{ type: 'text', text: skillsBlock }] : []),
    ...(learningsBlock ? [{ type: 'text', text: learningsBlock }] : []),
    ...(personalBlock ? [{ type: 'text', text: personalBlock }] : []),
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
  try {
    const attioDefs = await attioToolDefinitions() // leer, solange Attio nicht verbunden ist
    if (attioDefs.length) turnTools = [...turnTools, ...attioDefs]
  } catch (err) {
    console.error('Attio-Tool-Discovery fehlgeschlagen:', err.message)
  }
  try {
    const slackDefs = await slackToolDefinitions() // leer, solange Slack nicht verbunden ist
    if (slackDefs.length) turnTools = [...turnTools, ...slackDefs]
  } catch (err) {
    console.error('Slack-Tool-Discovery fehlgeschlagen:', err.message)
  }
  const messages = [...history]
  const signal = ctx.signal || null // Stop-Button: AbortController-Signal aus index.js
  let aborted = false
  const totalUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  }
  const toolCalls = []
  let thinkingText = ''
  const narrative = [] // Zwischen-Texte vor Tool-Calls — gehören zu den Gedanken, nicht zur Antwort
  let finalText = ''

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (signal?.aborted) { aborted = true; break }
    setCacheBreakpoint(messages)
    const supportsThinking = !MODEL.startsWith('claude-haiku')
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: systemBlocks,
      ...(supportsThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      tools: turnTools,
      messages,
    }, signal ? { signal } : undefined)

    // Text DIESER Iteration separat sammeln. Folgt danach ein Tool-Call, war es
    // Arbeits-Narrativ (→ Gedanken); war es die letzte Iteration, ist es die Antwort.
    let iterText = ''
    let response
    try {
      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            iterText += event.delta.text
            emit({ type: 'text_delta', text: event.delta.text })
          } else if (event.delta.type === 'thinking_delta') {
            thinkingText += event.delta.thinking
            emit({ type: 'thinking_delta', text: event.delta.thinking })
          }
        }
      }
      response = await stream.finalMessage()
    } catch (err) {
      // Vom Nutzer gestoppt: Teil-Text dieser Iteration wird zur (Teil-)Antwort
      if (signal?.aborted) {
        aborted = true
        if (iterText.trim()) finalText = iterText
        break
      }
      throw err
    }
    totalUsage.input_tokens += response.usage.input_tokens
    totalUsage.output_tokens += response.usage.output_tokens
    totalUsage.cache_creation_input_tokens += response.usage.cache_creation_input_tokens || 0
    totalUsage.cache_read_input_tokens += response.usage.cache_read_input_tokens || 0

    if (response.stop_reason === 'refusal') {
      emit({ type: 'error', message: 'Anfrage wurde aus Sicherheitsgründen abgelehnt.' })
      break
    }

    if (response.stop_reason !== 'tool_use') {
      finalText = iterText // letzte Iteration = die eigentliche Antwort
      break
    }

    // Text vor diesem Tool-Call war Zwischen-Narrativ → in die Gedanken, nicht in die Antwort
    if (iterText.trim()) narrative.push(iterText.trim())

    // Tool-Calls ausführen, Ergebnisse zurückgeben, Loop fortsetzen
    messages.push({ role: 'assistant', content: response.content })
    const toolResults = []
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue
      if (signal?.aborted) { aborted = true; break }
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
    if (aborted) break
    messages.push({ role: 'user', content: toolResults })
  }

  // Zwischen-Narrativ dem Gedanken-Text voranstellen (bleibt so beim Neuladen im Panel,
  // nicht in der Antwort). Trenner, damit Modell-Thinking und Narrativ unterscheidbar bleiben.
  const mergedThinking = [narrative.join('\n\n'), thinkingText].filter((s) => s && s.trim()).join('\n\n')
  return { text: finalText, thinking: mergedThinking, toolCalls, usage: totalUsage, model: MODEL, aborted }
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
