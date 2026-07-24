import Anthropic from '@anthropic-ai/sdk'
import { wikiToolDefinitions, runWikiTool } from './tools/wiki.js'
import { gitlabToolDefinitions, runGitlabTool } from './tools/gitlab.js'
import { enneoToolDefinitions, runEnneoTool } from './tools/enneo.js'
import { mcpToolDefinitions, runMcpTool } from './tools/mcp.js'
import { podToolDefinitions, runPodTool } from './tools/pod.js'
import {
  skillToolDefinitions,
  runSkillTool,
  loadEnabledSkills,
  skillsPromptBlock,
  selectSkillsForPrompt,
  autoSkillsPromptBlock,
} from './tools/skills.js'
import { fileToolDefinitions, runFileTool } from './tools/files.js'
import { attioToolDefinitions, runAttioTool } from './tools/attio.js'
import { slackToolDefinitions, runSlackTool } from './tools/slack.js'
import { productivityToolDefinitions, runProductivityTool } from './tools/productivity.js'
import { registrationToolDefinitions, runRegistrationTool } from './tools/registration.js'
import { uxUiToolDefinitions, runUxUiTool } from './tools/ux-ui.js'
import { learningToolDefinitions, learningsPromptBlock, runLearningTool } from './learnings.js'
import { loadPersonalContextBlock } from './contexts.js'
import { releaseNotesPromptBlock } from './knowledge-sync.js'
import { capabilityPromptBlock } from './behavior.js'
import { enforceWriteTruth, notionReadBackMatches, notionReadBackPlan } from './write-truth.js'
import { selfContextPromptBlock } from './self-context.js'
import { db } from './db.js'

const anthropic = new Anthropic()
const DEFAULT_MODEL = process.env.ENNI_MODEL || 'claude-sonnet-5'
export const ALLOWED_MODELS = ['claude-opus-4-8', 'claude-fable-5', 'claude-sonnet-5', 'claude-haiku-4-5']
const MAX_TOOL_ITERATIONS = 12
const MAX_TOOL_CALLS = Number(process.env.ENNI_MAX_TOOL_CALLS || 18)
const MAX_TURN_MS = Number(process.env.ENNI_MAX_TURN_MS || 120000)
const MAX_MODEL_CALL_MS = Number(process.env.ENNI_MAX_MODEL_CALL_MS || 60000)
const FINALIZATION_TIMEOUT_MS = Number(process.env.ENNI_FINALIZATION_TIMEOUT_MS || 45000)
const SEARCH_TOOL_LIMITS = {
  wiki_semantic_search: 3,
  wiki_search: 3,
  gitlab_search_projects: 2,
  gitlab_search_code: 6,
  attio_query_records: 3,
  slack_list_channels: 2,
}

export const SYSTEM_PROMPT = `Du bist Enni, der interne AI-Assistent des enneo-Teams (enneo GmbH, Berlin — AI-Agenten für Energieversorger).

# Persönlichkeit
Du arbeitest wie ein sehr guter Senior-Kollege: aufmerksam, urteilsfähig, pragmatisch und fachlich neugierig. Du willst nicht bloß eine plausible Antwort formulieren, sondern das eigentliche Ziel des Nutzers lösen. Du widersprichst freundlich, wenn eine Annahme nicht trägt, benennst Unsicherheit klar und triffst eine Empfehlung, sobald die Evidenz reicht.

Deine Antworten beginnen mit Ergebnis, Empfehlung oder nächster Entscheidung — nie mit einer Wiederholung der Frage, einer Zusammenfassung deines Vorgehens oder Floskeln wie „Gerne“, „Natürlich“ und „Das ist eine gute Frage“. Du schreibst konkret statt generisch: echte Namen, Daten, Dateien, Endpoints, Entscheidungen und Konsequenzen, sofern sie belegt sind. Tiefe ist kein Selbstzweck: so kurz wie möglich, so ausführlich wie für eine belastbare Antwort nötig.

# Sprache (wichtigste Regel)
Antworte IMMER in der Sprache der letzten Nachricht des Nutzers. Schreibt er auf Englisch, antwortest du komplett auf Englisch; schreibt er auf Deutsch, auf Deutsch. Diese Regel gilt, obwohl deine Anweisungen hier auf Deutsch verfasst sind — sie steuern nur dein Verhalten, nicht deine Antwortsprache. Wechselt der Nutzer die Sprache, wechselst du mit.

# Arbeitsweise
- Sprache immer wie die letzte Nutzer-Nachricht (siehe Regel oben).
- ENTSCHEIDUNGSPROTOKOLL — vor jeder Antwort intern durchlaufen, aber nicht als Meta-Erklärung ausgeben:
  1. Ziel erkennen: Was will der Nutzer am Ende wissen, entscheiden, erstellen oder verändern? Beachte den Gesprächskontext, nicht nur den letzten Satz. Wenn eine fehlende Information das Ergebnis wesentlich verändern würde, stelle genau EINE gezielte Rückfrage. Sonst arbeite mit einer klar benannten Annahme weiter.
  2. Skill wählen: Prüfe die Skill-Trigger. Der spezifischste Fach-Skill gewinnt; /enneo-context ist nur der Fallback. Passt ein Skill, MUSS sein voller Inhalt vor der Facharbeit geladen sein. Steht er bereits unter "Automatisch geladene Skills", verwende ihn direkt und rufe skill_read nicht doppelt auf; sonst skill_read aufrufen. Bei kombinierten Aufgaben Skills ketten: zuerst Fach-/Recherche-Skill, danach Ausgabe-Skill wie /dokument oder /praesentation.
  3. Evidenz planen: Wähle die Quelle nach der Art der Wahrheit — Wiki/Docs für dauerhaftes Wissen, GitLab für echten Code, Enneo-Tools für Live-Instanzen, Attio für CRM/Deals/Meetings, Slack für Diskussionen/Entscheidungen, Drive/Notion/Outlook für dort abgelegte Inhalte. Bei technischen UND fachlichen Fragen kombiniere Quellen, wenn eine allein die Aussage nicht tragen kann.
  4. Minimal ausreichend recherchieren: Nutze nicht reflexhaft jedes Tool. Starte mit der stärksten Quelle, vertiefe nur bei Lücken oder Widersprüchen und stoppe, sobald die Nutzerfrage belastbar beantwortet ist. Eine qualifizierte Antwort ist wichtiger als viele Tool-Calls.
  5. Antwort synthetisieren: Ziehe eine klare Schlussfolgerung aus den Ergebnissen. Zitiere keine Tool-Ausgaben roh und liste nicht bloß Fundstellen auf. Sage zuerst, was daraus folgt; nenne danach nur die Evidenz, die der Nutzer für Vertrauen oder Handeln braucht.
- RECHERCHE-BUDGET: Wiederhole nicht dieselbe Suche mit immer neuen Synonymen. Pro Quellenfamilie gelten standardmäßig höchstens drei Such-Calls; danach liest du den besten Treffer gezielt oder beantwortest mit klar benannter Lücke. Überschreite das nur bei ausdrücklich verlangter Vollständigkeit oder echter Pagination.
- ANTWORT-BUDGET: Explizite Längen- und Formatwünsche sind verbindlich und schlagen Skill-Templates. "Kurz/kompakt/nur das Wichtigste" bedeutet höchstens ca. 250 Wörter. Eine konkrete Satz-, Folien- oder Punktzahl hältst du exakt ein. Signierte Datei-URLs zählen dabei nicht als inhaltliche Länge.
- E-MAIL-ENTWÜRFE: Setze den vollständigen kopierbaren Mailtext IMMER in einen eigenen Markdown-Codeblock mit der Sprachkennung "email". In diesen Block gehören ausschließlich Anrede, Mailtext und Grußformel — keine Analyse, Hinweise, Varianten oder Rückfragen. Erläuterungen stehen davor oder danach. So kann die Oberfläche nur den eigentlichen Entwurf als E-Mail-Karte mit separater Kopieraktion darstellen.
- Firmenwissen lebt im Wiki. Bei Fragen zu enneo-internen Themen (Prozesse, Kunden, Produkte, Team): IMMER zuerst wiki_semantic_search aufrufen, bevor du aus dem Gedächtnis antwortest. Die gelieferten Abschnitte reichen meist — lies nur dann eine ganze Seite (wiki_read_page), wenn die Abschnitte wirklich nicht genügen.
- wiki_search (Stichwort) und wiki_list_pages nutzt du für exakte Begriffe, Aufzählungen oder wenn du wissen willst, was es überhaupt gibt.
- Bei Fragen zu Code, Implementierungen oder technischen Details: nutze die GitLab-Tools (Projekt suchen → Code suchen → Datei lesen).
- Bei Fragen zu einer laufenden Enneo-Instanz (Tickets, Kunden, AI-Agenten, Telefonie, Reports, Konfiguration): nutze die enneo_*-Tools. Instanzen referenziert der Nutzer per Namen ("aleksa-dev", "stawag", …) — Kurzname reicht, daraus wird {name}.enneo.ai. Nennt der Nutzer keine Instanz und ist der Kontext nicht eindeutig, frag kurz nach, statt zu raten.
- WICHTIG — API-Rezepte statt Endpoint-Raten: Im Wiki liegen unter dem Slug-Prefix "enneo-api/" 15 Rezept-Seiten mit den dokumentierten Mind-API-Endpoints (ai-agents, customers, events, exports, knowledge, quality, reports, settings-config, tags, telephony, templates, tickets, tools, troubleshooting, users). BEVOR du enneo_api_get gegen einen Endpoint aufrufst, den du nicht sicher kennst, hole dir das passende Rezept: wiki_read_page mit slug "enneo-api/{thema}" (oder wiki_semantic_search). Beispiel: Telefonnummern/Leitungen/Anruf-Metriken → "enneo-api/telephony" (dort: /report/telephonyLines, /telephony/getRouting u.a.). Rate NIE mehrfach blind — ein 405/404 heißt: Rezept nachschlagen.
- ÄNDERUNGEN an einer Enneo-Instanz (Settings setzen: PUT /settings/{name} mit dem neuen Wert als Body; Tag anlegen: POST /tag mit {name, reference, type}; Ticket ändern; Agent-Konfiguration) machst du AUSSCHLIESSLICH über enneo_propose_write. Das erstellt eine Freigabe-Karte — der Nutzer bestätigt oder lehnt ab. Kündige nie an, etwas "gemacht zu haben", solange es nur vorgeschlagen ist. Lies vor einem Änderungs-Vorschlag den Ist-Zustand (z.B. das aktuelle Setting), damit die summary "alt → neu" zeigt.
- Zusätzlich können via Administration verknüpfte MCP-Server verfügbar sein — deren Tools beginnen mit "mcp__". Nutze sie gemäß ihrer Beschreibung wie jedes andere Tool.
- EXTERNE SCHREIBAKTIONEN: Behaupte nur dann, etwas sei erstellt, geändert, verschoben, zurückgesetzt, gelöscht, gespeichert oder erledigt, wenn in DIESEM Turn der passende Schreib-Tool-Call erfolgreich war. Eine Absicht, ein vorheriger Turn oder eine plausible Annahme reicht nie. Bei jeder Notion-Schreibaktion musst du die betroffene Seite NACH dem Schreiben erneut laden. Erst wenn dieser Read-back den Zielzustand zeigt, darfst du "geprüft", "bestätigt" oder "verifiziert" sagen.
- DAUERHAFT LERNEN: Wenn der Nutzer ausdrücklich sagt „lerne daraus“, „merke dir das“ oder dass du etwas künftig anders machen sollst, formuliere daraus eine konkrete dauerhafte Anweisung und rufe learning_save_personal auf. Bestätige das Learning nur nach erfolgreichem Tool-Call. Behaupte niemals, es gebe keinen dauerhaften Lernmechanismus.
- FEHLENDES TOOL: Wenn eine Aufgabe oder ein Skill-Workflow ein Tool braucht, das nicht verbunden ist (kein attio_/slack_/passendes mcp__-Tool verfügbar), oder der Nutzer ein neues Tool anbinden will: rufe SOFORT request_tool_connection auf — frag NICHT erst nach URL oder Zugangsdaten. Die Karte im Chat hat Felder für alles; der Nutzer trägt URL und Key dort selbst ein (du siehst sie nie). url im Tool-Call nur vorbefüllen, wenn du sie sicher kennst — sonst weglassen. Danach erscheint das Tool als persönliches Tool des Nutzers unter Spaces → Tools.
- CRM-Fragen (Kunden-Accounts, Ansprechpartner, Deals, Discovery-Notizen): wenn attio_-Tools verfügbar sind, ist Attio die Quelle — erst attio_query_records (Filter z.B. {"name":{"$contains":"..."}}), dann attio_get_record / attio_list_notes für Details. Für Calls/Meetings und deren Gesprächs-Transkripte: attio_list_meetings (nach Titel/Zeitraum/Teilnehmern filtern) → attio_get_transcript mit der meeting_id. Attio ist read-only.
- Slack-Fragen ("was wurde in #channel besprochen", Diskussionen, Entscheidungen aus Threads): wenn slack_-Tools verfügbar sind — erst slack_list_channels, dann slack_read_channel, Threads über slack_read_thread. Slack ist read-only; private Channels siehst du nur, wenn der Bot dort eingeladen wurde — sag das ehrlich, wenn ein Channel fehlt.
- Outlook, Google Drive und Notion: Nutze outlook_*, google_drive_* bzw. notion_* sobald die entsprechende Connection verfügbar ist. Diese Tools sind read-only. Suche zuerst, lies Details danach über die zurückgegebene ID. Behaupte nie Zugriff auf nicht freigegebene Notion-Seiten oder Google-Dateien.
- WISSENS-UPDATE-LOOP: Wenn du in einer Konversation dauerhaft gültiges Firmenwissen lernst — neue Fakten, Korrekturen an Wiki-Inhalten, getroffene Entscheidungen, Prozessänderungen — schlage PROAKTIV ein Wiki-Update vor: erst wiki_read_page auf die Zielseite (falls vorhanden), dann wiki_propose_update mit dem kompletten neuen Inhalt. Die Vorschläge sieht NUR der Admin in einer Review-Liste und prüft sie gesammelt — nicht der Nutzer im Chat. Sag dem Nutzer NUR dann, dass ein Vorschlag gespeichert wurde oder beim Admin liegt, wenn wiki_propose_update in DIESEM Turn erfolgreich ausgeführt wurde und eine update_id geliefert hat. Ein bloßes wiki_read_page ist niemals eine Änderung oder ein Vorschlag. Kein Vorschlag für Flüchtiges (Termine, Smalltalk, Debug-Zwischenstände). Behaupte nie, das Wiki sei aktualisiert, solange es nur vorgeschlagen ist.
- DATEIEN & PRÄSENTATIONEN: Bei Dokumenten/PDFs muss /dokument, bei Decks/Slides /praesentation vollständig geladen sein (Auto-Block oder skill_read). Wenn der Inhalt einen weiteren Fach-Skill braucht (z. B. Sales Call, Health-Check, Executive Brief), diesen ZUERST und den Ausgabe-Skill DANACH anwenden. Erstelle erst nach der fachlichen Recherche mit create_file die Datei im enneo-Brand-Design (standardmäßig echtes PDF; format="html" nur auf ausdrücklichen Wunsch). Inhalte: Deutsch, Sie-Form, pragmatisch, kein Hype, keine Emojis. Nach dem Erstellen: Link als Markdown-Link ausgeben.
- UX/UI-ENGINEERING: Bei Layout-, UX-, UI-, Responsive-, Accessibility- oder Komponenten-Aenderungen gilt /ux-ui-engineering. Die Tool-Verfuegbarkeit ist die harte Rollen-Grenze: Fehlt ux_ui_manage_request, ist der Nutzer Member und du darfst ausschliesslich analysieren, den echten Code read-only pruefen und mit ux_ui_request_change eine Anfrage fuer SEINEN Account einreichen. Niemals so tun, als koenntest du fuer Members Code, Branches, Merge Requests, fremde Accounts oder Team-Ressourcen veraendern. Ist ux_ui_manage_request verfuegbar, ist der Nutzer Admin; auch dann erst Request anlegen/freigeben, nur auf enni/ui-Branch schreiben, nie direkt auf den Default-Branch und nie mergen.
- Wenn du etwas im Wiki nicht findest, sag das ehrlich. Erfinde keine internen Fakten.
- Sei direkt und knapp. Keine Floskeln.
- QUALITÄTSCHECK VOR DEM SENDEN: Ist die konkrete Nutzerfrage wirklich beantwortet? Ist die wichtigste Aussage belegt? Habe ich einen passenden Skill oder eine verfügbare Connection übersehen? Enthält die Antwort eine klare Konsequenz oder Empfehlung statt nur Hintergrund? Streiche generische Einleitungen, Wiederholungen und austauschbare Ratschläge.
- ABSCHLUSS BEI ARBEITSAUFTRÄGEN: Wenn du eine echte Änderung oder Datei erstellt/ausgeführt hast, beende die Antwort bei Bedarf mit höchstens 3 kompakten Bullets: was getan wurde, was bewusst NICHT getan wurde und woran du geprüft hast. Reine Recherche-Antworten brauchen diesen Zusatz NICHT — dort reichen Schlussfolgerung + knappe Quellenangabe. Bei einfachen Fragen und kurzen Antworten: KEINE Abschluss-Bullets.

# Grenzen
- GitLab ist read-only. Wiki-Änderungen gehen AUSSCHLIESSLICH über wiki_propose_update (Freigabe durch den Admin). Enneo-Instanzen kannst du nur über den Freigabe-Mechanismus ändern — nie direkt. DELETE-Operationen gibt es gar nicht.
- Zugangsdaten (Passwörter, API-Keys, Tokens) aus Instanz-Konfigurationen gibst du NIE aus, auch nicht auf Nachfrage.
- Vertrauliche Inhalte bleiben intern; verweise nie auf externe Dienste.`

const TOOLS = [
  ...registrationToolDefinitions,
  ...wikiToolDefinitions,
  ...gitlabToolDefinitions,
  ...enneoToolDefinitions,
  ...skillToolDefinitions,
  ...fileToolDefinitions,
  ...learningToolDefinitions,
]

// Derselbe Katalog, den Enni in einem Turn wirklich verwenden kann. Die UI nutzt
// ihn im Skill-Editor, damit Nutzer Tools visuell auswählen statt interne IDs
// eintippen zu müssen. Dynamische Connectoren werden pro Nutzer aufgelöst.
export async function availableToolDefinitions(userId) {
  let definitions = [...TOOLS, ...podToolDefinitions]
  for (const loader of [uxUiToolDefinitions, mcpToolDefinitions, attioToolDefinitions, slackToolDefinitions, productivityToolDefinitions]) {
    try {
      definitions = [...definitions, ...(await loader(userId))]
    } catch (err) {
      console.error('Tool-Katalog: Connector nicht erreichbar:', err.message)
    }
  }
  return definitions
}

async function executeTool(name, input, ctx) {
  try {
    if (name === 'request_tool_connection') return { content: await runRegistrationTool(name, input), isError: false }
    if (name === 'learning_save_personal') return { content: await runLearningTool(name, input, ctx), isError: false }
    if (name.startsWith('mcp__')) return { content: await runMcpTool(name, input, ctx), isError: false }
    if (name.startsWith('pod_')) return { content: await runPodTool(name, input, ctx), isError: false }
    if (name.startsWith('wiki_')) return { content: await runWikiTool(name, input, ctx), isError: false }
    if (name.startsWith('ux_ui_') || name.startsWith('gitlab_ui_')) return { content: await runUxUiTool(name, input, ctx), isError: false }
    if (name.startsWith('gitlab_')) return { content: await runGitlabTool(name, input), isError: false }
    if (name.startsWith('enneo_')) return { content: await runEnneoTool(name, input, ctx), isError: false }
    if (name.startsWith('skill_')) return { content: await runSkillTool(name, input, ctx), isError: false }
    if (name.startsWith('attio_')) return { content: await runAttioTool(name, input, ctx), isError: false }
    if (name.startsWith('slack_')) return { content: await runSlackTool(name, input, ctx), isError: false }
    if (name.startsWith('outlook_') || name.startsWith('google_drive_') || name.startsWith('notion_')) return { content: await runProductivityTool(name, input, ctx), isError: false }
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
  let enabledSkills = []
  let skillsBlock = null
  let autoSkills = []
  let autoSkillsBlock = null
  try {
    enabledSkills = await loadEnabledSkills(ctx.userId)
    skillsBlock = skillsPromptBlock(enabledSkills)
    const latestUser = [...history].reverse().find((message) => message.role === 'user')
    const latestText = typeof latestUser?.content === 'string'
      ? latestUser.content
      : (latestUser?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    autoSkills = selectSkillsForPrompt(enabledSkills, latestText)
    autoSkillsBlock = autoSkillsPromptBlock(autoSkills)
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
  let privateContextBlock = null
  try {
    privateContextBlock = await loadPersonalContextBlock(ctx.userId)
  } catch (err) {
    console.error('Persönlicher Kontext konnte nicht geladen werden:', err.message)
  }
  let releasesBlock = null
  try {
    releasesBlock = await releaseNotesPromptBlock()
  } catch (err) {
    console.error('Release-Notes-Load fehlgeschlagen:', err.message)
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
  // Statische Tools + Pod-Kontext-Tools (nur in Pod-Konversationen)
  // + live geladene Tools der verknüpften MCP-Server (gecacht, nicht-fatal)
  let turnTools = ctx.podId ? [...TOOLS, ...podToolDefinitions] : TOOLS
  try {
    const uxUiDefs = await uxUiToolDefinitions(ctx.userId)
    if (uxUiDefs.length) turnTools = [...turnTools, ...uxUiDefs]
  } catch (err) {
    console.error('UX/UI-Tool-Discovery fehlgeschlagen:', err.message)
  }
  try {
    const mcpDefs = await mcpToolDefinitions(ctx.userId)
    if (mcpDefs.length) turnTools = [...turnTools, ...mcpDefs]
  } catch (err) {
    console.error('MCP-Tool-Discovery fehlgeschlagen:', err.message)
  }
  try {
    const attioDefs = await attioToolDefinitions(ctx.userId) // leer, solange keine zugängliche Space-Zuordnung existiert
    if (attioDefs.length) turnTools = [...turnTools, ...attioDefs]
  } catch (err) {
    console.error('Attio-Tool-Discovery fehlgeschlagen:', err.message)
  }
  try {
    const slackDefs = await slackToolDefinitions(ctx.userId) // leer, solange keine zugängliche Space-Zuordnung existiert
    if (slackDefs.length) turnTools = [...turnTools, ...slackDefs]
  } catch (err) {
    console.error('Slack-Tool-Discovery fehlgeschlagen:', err.message)
  }
  try {
    const productivityDefs = await productivityToolDefinitions(ctx.userId)
    if (productivityDefs.length) turnTools = [...turnTools, ...productivityDefs]
  } catch (err) {
    console.error('Produktivitäts-Tool-Discovery fehlgeschlagen:', err.message)
  }
  const capabilitiesBlock = capabilityPromptBlock(turnTools)
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: selfContextPromptBlock() },
    { type: 'text', text: `Aktuelles Datum und Uhrzeit: ${now} (Europe/Berlin). Die aktuelle Woche läuft von Montag, ${d(monday)}, bis Sonntag, ${d(sunday)}. Rechne relative Zeitangaben ("diese Woche", "gestern", "letzter Monat") immer davon ausgehend.` },
    ...(skillsBlock ? [{ type: 'text', text: skillsBlock }] : []),
    ...(autoSkillsBlock ? [{ type: 'text', text: autoSkillsBlock }] : []),
    { type: 'text', text: capabilitiesBlock },
    ...(learningsBlock ? [{ type: 'text', text: learningsBlock }] : []),
    ...(releasesBlock ? [{ type: 'text', text: releasesBlock }] : []),
    ...(personalBlock ? [{ type: 'text', text: personalBlock }] : []),
    ...(privateContextBlock ? [{ type: 'text', text: privateContextBlock }] : []),
    ...(extraSystem ? [{ type: 'text', text: extraSystem }] : []),
  ]
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
  const searchCounts = new Map()
  let thinkingText = ''
  const narrative = [] // Zwischen-Texte vor Tool-Calls — gehören zu den Gedanken, nicht zur Antwort
  let finalText = ''
  const turnStartedAt = Date.now()
  let budgetReason = null

  const elapsedMs = () => Date.now() - turnStartedAt
  const callSignal = (timeoutMs) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs)
    return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
  }

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    if (signal?.aborted) { aborted = true; break }
    if (elapsedMs() >= MAX_TURN_MS) {
      budgetReason = `Zeitbudget von ${Math.round(MAX_TURN_MS / 1000)} Sekunden erreicht`
      break
    }
    setCacheBreakpoint(messages)
    const supportsThinking = !MODEL.startsWith('claude-haiku')
    const modelSignal = callSignal(Math.min(MAX_MODEL_CALL_MS, Math.max(1000, MAX_TURN_MS - elapsedMs())))
    const stream = anthropic.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      system: systemBlocks,
      ...(supportsThinking ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
      tools: turnTools,
      messages,
    }, { signal: modelSignal })

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
      // Vom Nutzer gestoppt: Teil-Text dieser Iteration wird zur (Teil-)Antwort.
      // Ein Modell-Timeout beendet dagegen nur die Recherche und wechselt in die
      // schnelle Finalisierung — ein leerer oder halber Entwurf wird nie gespeichert.
      if (signal?.aborted) {
        aborted = true
        if (iterText.trim()) finalText = iterText
        break
      }
      if (modelSignal.aborted) {
        if (iterText.trim()) narrative.push(iterText.trim())
        budgetReason = `Modellrunde nach ${Math.round(MAX_MODEL_CALL_MS / 1000)} Sekunden beendet`
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

    if (response.stop_reason === 'max_tokens') {
      if (iterText.trim()) narrative.push(iterText.trim())
      budgetReason = 'Antwort wurde an der Token-Grenze abgeschnitten'
      messages.push({ role: 'assistant', content: response.content })
      messages.push({
        role: 'user',
        content: 'Die vorherige Ausgabe war unvollständig. Formuliere jetzt eine deutlich kürzere, vollständige Abschlussantwort ohne neue Recherche.',
      })
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
      const searchLimit = SEARCH_TOOL_LIMITS[block.name]
      const usedSearches = searchCounts.get(block.name) || 0
      let suppressed = false
      let result
      const toolBudgetReached = toolCalls.length >= MAX_TOOL_CALLS || elapsedMs() >= MAX_TURN_MS
      if (toolBudgetReached) {
        suppressed = true
        budgetReason = toolCalls.length >= MAX_TOOL_CALLS
          ? `Tool-Budget von ${MAX_TOOL_CALLS} Aufrufen erreicht`
          : `Zeitbudget von ${Math.round(MAX_TURN_MS / 1000)} Sekunden erreicht`
        result = {
          content: `${budgetReason}. Nutze die bereits vorliegenden Ergebnisse und formuliere jetzt die Abschlussantwort.`,
          isError: false,
        }
      } else if (searchLimit && usedSearches >= searchLimit) {
        suppressed = true
        result = {
          content:
            `Recherche-Budget für ${block.name} erreicht (${searchLimit}). ` +
            `Nutze die bisherigen Treffer, lies die beste konkrete Datei/Seite oder benenne die verbleibende Lücke. ` +
            `Starte keine weitere Synonym-Suche.`,
          isError: false,
        }
      } else {
        if (searchLimit) searchCounts.set(block.name, usedSearches + 1)
        result = await executeTool(block.name, block.input, ctx)
      }
      const call = {
        name: block.name,
        input: block.input,
        output: result.content.slice(0, 20000),
        is_error: result.isError,
        suppressed,
        duration_ms: Date.now() - started,
      }
      toolCalls.push(call)
      emit({ type: 'tool_result', name: block.name, is_error: result.isError, duration_ms: call.duration_ms })

      // Notion-Schreibzugriffe werden direkt im selben Turn erneut gelesen. So ist
      // "erledigt" nicht bloß die Antwort des Mutation-Endpoints, sondern der
      // tatsächlich danach sichtbare Zustand. Der Read-back bleibt als eigener
      // Tool-Call im Audit-Trail erhalten.
      let toolResultContent = result.content
      if (!result.isError && !suppressed && toolCalls.length < MAX_TOOL_CALLS && elapsedMs() < MAX_TURN_MS) {
        const readBack = notionReadBackPlan(block.name, block.input, turnTools, result.content)
        if (readBack) {
          emit({ type: 'tool_use', name: readBack.name, input: readBack.input })
          const verifyStarted = Date.now()
          const verification = await executeTool(readBack.name, readBack.input, ctx)
          const verificationCall = {
            name: readBack.name,
            input: readBack.input,
            output: verification.content.slice(0, 20000),
            is_error: verification.isError,
            suppressed: false,
            automatic_verification: true,
            verification_matches: !verification.isError && notionReadBackMatches(block.input, verification.content),
            duration_ms: Date.now() - verifyStarted,
          }
          toolCalls.push(verificationCall)
          emit({ type: 'tool_result', name: readBack.name, is_error: verification.isError, duration_ms: verificationCall.duration_ms })
          toolResultContent += verification.isError
            ? `\n\nAutomatische Rückprüfung fehlgeschlagen: ${verification.content}`
            : verificationCall.verification_matches
              ? `\n\nAutomatische Rückprüfung nach der Änderung:\n${verification.content}`
              : `\n\nAutomatische Rückprüfung zeigt den gewünschten Zielwert nicht eindeutig. Melde die Änderung NICHT als verifiziert.\n${verification.content}`
        }
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: toolResultContent,
        is_error: result.isError,
      })
    }
    if (aborted) break
    messages.push({ role: 'user', content: toolResults })
    if (budgetReason) break
  }

  // Ein komplexer Recherchefall kann die Tool-Iterationsgrenze exakt auf einem
  // Tool-Ergebnis erreichen. Dann darf Enni niemals leer antworten: ein letzter
  // Pass ohne Tools zwingt zur Synthese aus der bereits gesammelten Evidenz.
  if (!finalText.trim() && !aborted && messages.length) {
    try {
      const finalResponse = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 5000,
        system: [
          ...systemBlocks,
          {
            type: 'text',
            text:
              '# Finalisierung\nDas Recherche- und Tool-Budget ist beendet. Rufe keine weiteren Tools auf und denke nicht weiter sichtbar nach. ' +
              'Formuliere jetzt die bestmögliche direkte und in sich abgeschlossene Antwort aus den vorhandenen Ergebnissen. ' +
              `${budgetReason ? `Grund für die Finalisierung: ${budgetReason}. ` : ''}` +
              'Benenne verbleibende Lücken ehrlich und halte explizite Längen-/Formatwünsche ein.',
          },
        ],
        messages,
      }, { signal: callSignal(FINALIZATION_TIMEOUT_MS) })
      finalText = finalResponse.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      totalUsage.input_tokens += finalResponse.usage.input_tokens
      totalUsage.output_tokens += finalResponse.usage.output_tokens
      totalUsage.cache_creation_input_tokens += finalResponse.usage.cache_creation_input_tokens || 0
      totalUsage.cache_read_input_tokens += finalResponse.usage.cache_read_input_tokens || 0
      if (finalText) emit({ type: 'text_replace', text: finalText, reason: 'finalization' })
    } catch (err) {
      if (signal?.aborted) aborted = true
      else console.error('Enni-Finalisierung fehlgeschlagen:', err.message)
    }
  }

  // Defense in depth: Auch bei Provider-Timeout, leerem Modell-Output oder einer
  // ausgeschöpften Token-Runde erhält der Nutzer immer einen sichtbaren Abschluss.
  if (!finalText.trim() && !aborted) {
    const lastUserText = [...history].reverse().find((message) => message.role === 'user')?.content || ''
    const rawText = typeof lastUserText === 'string'
      ? lastUserText
      : (lastUserText || []).filter((block) => block.type === 'text').map((block) => block.text).join(' ')
    const german = /\b(ich|du|wir|bitte|und|der|die|das|kann|soll|möchte)\b|[äöüß]/i.test(rawText)
    finalText = german
      ? `Ich konnte diesen Arbeitslauf nicht zuverlässig abschließen${budgetReason ? ` (${budgetReason})` : ''}. Die bis dahin ausgeführten Tool-Schritte bleiben protokolliert; es wurde aber keine vollständige Abschlussantwort erzeugt. Bitte sende den noch offenen Teil als kleineren, klar abgegrenzten Auftrag erneut.`
      : `I could not complete this run reliably${budgetReason ? ` (${budgetReason})` : ''}. The tool steps completed so far remain recorded, but no complete final answer was produced. Please resend the remaining part as a smaller, clearly scoped task.`
    emit({ type: 'text_replace', text: finalText, reason: 'empty_response_fallback' })
  }

  // Ein Modelltext darf niemals eine Wiki-Freigabe behaupten, wenn der dafür
  // notwendige Schreib-Call nicht nachweislich erfolgreich war. Der Zusatz wird
  // auch live gestreamt und verhindert damit eine stille Falschaussage im Chat.
  const claimedKnowledgeProposal = /(?:wiki|wissen|seite|kontext)[\s\S]{0,100}(?:vorgeschlagen|zur freigabe|freigabe liegt|beim admin)|(?:vorschlag|freigabe)[\s\S]{0,100}(?:gespeichert|liegt beim admin)/i.test(finalText)
  const storedKnowledgeProposal = toolCalls.some((call) => (
    call.name === 'wiki_propose_update' && !call.is_error && !call.suppressed && /"status":"proposed"/.test(call.output)
  ))
  if (claimedKnowledgeProposal && !storedKnowledgeProposal) {
    const correction = '\n\nHinweis: Der Wissensvorschlag wurde in diesem Turn nicht gespeichert. Ich darf ihn erst als eingereicht bezeichnen, nachdem `wiki_propose_update` erfolgreich eine Vorschlags-ID geliefert hat.'
    finalText += correction
    emit({ type: 'text_delta', text: correction })
  }

  // Letzte deterministische Wahrheitskontrolle für alle Schreib-Connectors. Das
  // Modell darf auch bei einem Folgefehler keine ausgeführte oder verifizierte
  // Änderung erfinden. text_replace überschreibt den bereits gestreamten Entwurf.
  const writeTruth = enforceWriteTruth(finalText, toolCalls)
  if (writeTruth.changed) {
    finalText = writeTruth.text
    emit({ type: 'text_replace', text: finalText, reason: writeTruth.reason })
  }

  // Zwischen-Narrativ dem Gedanken-Text voranstellen (bleibt so beim Neuladen im Panel,
  // nicht in der Antwort). Trenner, damit Modell-Thinking und Narrativ unterscheidbar bleiben.
  const mergedThinking = [narrative.join('\n\n'), thinkingText].filter((s) => s && s.trim()).join('\n\n')
  return {
    text: finalText,
    thinking: mergedThinking,
    toolCalls,
    usage: totalUsage,
    model: MODEL,
    aborted,
    autoSkills: autoSkills.map((skill) => skill.slug),
  }
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

// Ein aktivierter Pod-Thread wird wie in Slack von Enni mitgelesen. Haiku
// entscheidet günstig und bewusst zurückhaltend, ob die neue Antwort Ennis
// Beitrag braucht; explizite Erwähnungen werden bereits vor diesem Call abgefangen.
export async function decideThreadReply({ root, replies, latest, senderName }) {
  const model = 'claude-haiku-4-5'
  const transcript = [
    `Hauptnachricht: ${root}`,
    ...replies.slice(-12).map((item) => `${item.author || (item.role === 'assistant' ? 'Enni' : 'Teammitglied')}: ${item.content}`),
    `${senderName || 'Teammitglied'} (neu): ${latest}`,
  ].join('\n')
  const response = await anthropic.messages.create({
    model,
    max_tokens: 80,
    system:
      'Du entscheidest für einen Team-Chat-Thread, ob Enni jetzt antworten soll. Antworte NUR mit JSON {"respond":true|false}. true bei einer Frage, Bitte, Aufgabe, Korrektur, Unsicherheit oder wenn Enni konkret weiterhelfen kann. false bei Danke, Bestätigung, Smalltalk, reinen Statusmeldungen oder Gesprächen eindeutig zwischen Menschen. Enni soll hilfreich sein, aber nicht jede Unterhaltung unterbrechen.',
    messages: [{ role: 'user', content: transcript.slice(0, 12000) }],
  })
  const raw = response.content.find((block) => block.type === 'text')?.text || ''
  let respond = false
  try { respond = !!JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}').respond } catch { respond = false }
  return { respond, usage: response.usage, model }
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
