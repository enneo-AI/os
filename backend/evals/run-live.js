import { runEnniTurn } from '../src/agent.js'
import { db } from '../src/db.js'

const MODEL = process.env.EVAL_MODEL || 'claude-sonnet-5'
const email = process.env.EVAL_USER_EMAIL || 'aleksa@enneo.ai'

const { data: profile, error: profileError } = await db
  .from('profiles')
  .select('id, email')
  .eq('email', email)
  .maybeSingle()
if (profileError || !profile) throw new Error(`Eval-Nutzer fehlt: ${profileError?.message || email}`)

const cases = [
  {
    id: 'grounded-product-answer',
    prompt: 'Was unterscheidet Copilot, Copilot+ und Autopilot bei enneo? Antworte mir direkt in höchstens fünf Sätzen und nenne die belastbare Grundlage.',
    expectedSkills: ['enneo-context'],
    expectedPrefixes: ['wiki_'],
    maxChars: 1400,
  },
  {
    id: 'technical-code-answer',
    prompt: 'Wo im enneo-Monorepo wird entschieden, ob bei einer aus einem Chat-Ticket versendeten Mail der Conversation-Verlauf angehängt wird? Prüfe sowohl die dokumentierte Produktlogik als auch den echten Code und gib mir die konkrete Stelle plus Konsequenz.',
    expectedSkills: ['api-frage'],
    expectedPrefixes: ['wiki_', 'gitlab_'],
    maxChars: 2900,
    maxToolCounts: { gitlab_search_code: 6, wiki_semantic_search: 3 },
  },
  {
    id: 'crm-call-prep',
    prompt: 'Bereite mich auf den nächsten Call mit WBS Legal vor. Ich brauche nur belastbare, kompakte Stichpunkte: aktueller Stand, offene Zusagen, wahrscheinliche Einwände und mein nächster sinnvoller Schritt.',
    expectedSkills: ['sales-call-prep'],
    expectedPrefixes: ['attio_'],
    maxChars: 3600,
    maxWords: 400,
  },
  {
    id: 'brand-presentation',
    prompt: 'Erstelle eine sehr kurze Präsentation mit drei Folien im enneo-Brand, die einem Customer-Service-Leiter den sicheren Weg von Copilot zu Autopilot erklärt. Nutze nur belegte Enneo-Aussagen und gib mir die fertige Datei.',
    expectedSkills: ['praesentation'],
    expectedPrefixes: ['wiki_'],
    expectedExact: ['create_file'],
    maxChars: 1800,
    maxWords: 250,
  },
]

const before = await listGenerated(profile.id)
let failed = 0
const selectedCases = process.env.EVAL_CASE ? cases.filter((item) => item.id === process.env.EVAL_CASE) : cases
if (!selectedCases.length) throw new Error(`Unbekannter EVAL_CASE: ${process.env.EVAL_CASE}`)

for (const item of selectedCases) {
  const events = []
  const result = await runEnniTurn(
    [{ role: 'user', content: item.prompt }],
    (event) => { if (event.type === 'tool_use') events.push(event) },
    MODEL,
    null,
    { userId: profile.id }
  )
  const tools = result.toolCalls.filter((call) => !call.suppressed).map((call) => call.name)
  const toolSkills = events
    .filter((event) => event.name === 'skill_read')
    .map((event) => String(event.input?.slug || '').replace(/^\//, ''))
  const skills = [...new Set([...(result.autoSkills || []), ...toolSkills])]
  const contentText = result.text.replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, '[Datei-Link]')
  const wordCount = contentText.trim().split(/\s+/).filter(Boolean).length
  const checks = {
    skills: item.expectedSkills.every((slug) => skills.includes(slug)),
    prefixes: (item.expectedPrefixes || []).every((prefix) => tools.some((name) => name.startsWith(prefix))),
    exact: (item.expectedExact || []).every((name) => tools.includes(name)),
    concise: contentText.length <= item.maxChars && (!item.maxWords || wordCount <= item.maxWords),
    searchBudget: Object.entries(item.maxToolCounts || {}).every(
      ([name, max]) => tools.filter((tool) => tool === name).length <= max
    ),
    direct: !/^(gerne|natürlich|das ist eine gute frage|ich helfe)/i.test(result.text.trim()),
    answer: result.text.trim().length > 30,
  }
  const pass = Object.values(checks).every(Boolean)
  if (!pass) failed++
  console.log(JSON.stringify({
    id: item.id,
    pass,
    checks,
    skills,
    tools,
    answer_chars: contentText.length,
    answer_words: wordCount,
    answer: result.text,
  }))
}

const after = await listGenerated(profile.id)
const created = [...after].filter((name) => !before.has(name))
if (created.length) await db.storage.from('generated-files').remove(created.map((name) => `${profile.id}/${name}`))

console.log(JSON.stringify({ summary: { total: selectedCases.length, passed: selectedCases.length - failed, failed, cleaned_files: created.length } }))
if (failed) process.exitCode = 1

async function listGenerated(userId) {
  const { data, error } = await db.storage.from('generated-files').list(userId, { limit: 1000 })
  if (error) throw new Error(`Storage-Liste fehlgeschlagen: ${error.message}`)
  return new Set((data || []).map((item) => item.name))
}
