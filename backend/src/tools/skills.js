import { db } from '../db.js'

// ============================================================ Skills (Best-Practice-Playbooks)
// Skills sagen Enni, WIE man Dinge bei enneo richtig macht. Die Trigger-Übersicht
// aller aktiven Skills wandert kompakt in den System-Prompt; den vollen Skill
// lädt Enni bei Bedarf über skill_read.

// Sichtbar für einen Nutzer: alle team-weiten Skills + die eigenen persönlichen
// (visibility 'personal'/'proposed' wirkt beim Ersteller sofort — wie Learnings).
export async function loadEnabledSkills(userId = null) {
  const q = db
    .from('skills')
    .select('slug, name, category, visibility, created_by, context, workflow, tools, triggers, definition_of_done, corner_cases')
    .eq('enabled', true)
    .order('name')
  const { data } = await (userId
    ? q.or(`visibility.eq.team,created_by.eq.${userId}`)
    : q.eq('visibility', 'team'))
  return data || []
}

export function skillVisibleTo(s, userId) {
  return s.visibility === 'team' || s.created_by === userId
}

// Kompakter Block für den System-Prompt: ein Skill pro Zeile.
export function skillsPromptBlock(skills) {
  if (!skills.length) return null
  const lines = skills.map(
    (s) => `- /${s.slug} — ${s.name}. Trigger: ${s.triggers.replace(/\s+/g, ' ').slice(0, 220)}`
  )
  return (
    `# Skills (Best-Practice-Playbooks)\n` +
    `Für wiederkehrende Aufgaben gibt es Skills. Prüfe die Trigger BEVOR du fachlich antwortest. Wenn die Anfrage zu einem Trigger passt ODER der Nutzer den Skill per Slash-Command (/slug) aufruft: stelle sicher, dass der volle Skill geladen ist. Steht er bereits im Block "Automatisch geladene Skills", rufe skill_read NICHT erneut auf; andernfalls lies ihn ZUERST mit skill_read. Arbeite dann nach seinem Workflow, beachte Corner Cases und prüfe am Ende die Definition of Done. Explizite Nutzerwünsche zu Länge, Format und Fokus haben Vorrang vor dem Standardumfang des Skills.\n` +
    `Auswahlregeln: (1) Der spezifischste Fach-Skill gewinnt; /enneo-context ist nur der Fallback für Enneo-Themen ohne Spezial-Skill. (2) Wenn mehrere Skills nötig sind, lade sie in Arbeitsreihenfolge — zuerst Recherche/Fachinhalt, zuletzt Ausgabeformat. Beispiel: Sales-Call-Briefing als Deck = /sales-call-prep, danach /praesentation. (3) Lade nicht mehrere konkurrierende Skills nur wegen einzelner ähnlicher Wörter. (4) Die im Skill verknüpften Tools sind die Basis, aber nicht exklusiv; nutze weitere verfügbare Connections, wenn sie für eine belastbare Antwort relevant sind.\n` +
    lines.join('\n')
  )
}

const INTENT_RULES = [
  { slug: 'ux-ui-engineering', re: /\b(ux|ui|user experience|user interface|layout|responsive|accessibility|barrierefrei|komponente|frontend|css|design)\b.*(?:aender|änder|fix|verbesser|umbau|anpass|request|anfrag|umsetz)\w*|(?:aender|änder|fix|verbesser|umbau|anpass|umsetz|prüf)\w*.*\b(ux|ui|layout|responsive|accessibility|barrierefrei|komponente|frontend|css|design)\b/i },
  { slug: 'praesentation', re: /\b(präsentation|praesentation|deck|slides?|folien?|pitch deck)\b/i, output: true },
  { slug: 'dokument', re: /\b(dokument|pdf|brief|report|bericht|memo|angebot)\b.*\b(datei|verschicken|ausdrucken|erstell|fertig)|\bals (pdf|datei)\b/i, output: true },
  { slug: 'api-frage', re: /\b(api|endpoint|webhook|auth|monorepo|gitlab|code|quellcode|implementier|konfigurationsfeld|plattform-feature)\b/i },
  { slug: 'health-check', re: /\b(health.?check|läuft nicht|funktioniert nicht|antworten? (sind|ist) schlecht|eskalationsquote|kunde unzufrieden|live.?problem)\b/i },
  { slug: 'sales-call-prep', re: /\b(call|meeting|termin|demo|gespräch)\b.*\b(vorbereit|brief|prep|wissen)|\b(vorbereit|brief|prep)\b.*\b(call|meeting|termin|demo|gespräch)\b/i },
  { slug: 'kickoff-vorbereitung', re: /\b(kickoff|erstgespräch)\b.*\b(vorbereit|agenda|brief)|\b(vorbereit|agenda|brief)\b.*\b(kickoff|erstgespräch)\b/i },
  { slug: 'stakeholder-email', re: /\b(mail|e-?mail|status.?update|eskalation|decision memo)\b.*\b(kunde|stakeholder|partner|ceo|cto|operations|it)\b/i },
  { slug: 'email-creator', re: /\b(e-?mail|mail)\b.*\b(schreib|formulier|verbesser|schärf|entwurf|draft)\b/i },
]

// Deterministisches Fast-Path-Routing für klare Intents. Das vermeidet einen
// zusätzlichen LLM-/Tool-Turn und verhindert, dass Enni offensichtliche Skills
// trotz passendem Trigger übersieht. Unklare Long-Tail-Intents bleiben beim
// modellgesteuerten skill_read aus dem kompakten Trigger-Katalog.
export function selectSkillsForPrompt(skills, prompt) {
  const bySlug = new Map(skills.map((skill) => [skill.slug, skill]))
  const selected = []
  const add = (slug) => {
    const skill = bySlug.get(slug)
    if (skill && !selected.some((item) => item.slug === slug)) selected.push(skill)
  }

  for (const match of String(prompt || '').matchAll(/(?:^|\s)\/([a-z0-9][a-z0-9-]*)\b/gi)) add(match[1].toLowerCase())

  const matched = INTENT_RULES.filter((rule) => rule.re.test(prompt || ''))
  const contentRules = matched.filter((rule) => !rule.output)
  const outputRules = matched.filter((rule) => rule.output)
  contentRules.forEach((rule) => add(rule.slug))

  // Enneo Context ist der fachliche Grounding-Fallback. Bei reinen Ausgabe-
  // Skills liefert es erst die Fakten, danach formatiert Dokument/Präsentation.
  const enneoRelated = /\benneo\b|\bcopilot\+?\b|\bautopilot\b|\bdunkelverarbeitung\b/i.test(prompt || '')
  if (!contentRules.length && enneoRelated) add('enneo-context')
  outputRules.forEach((rule) => add(rule.slug))
  return selected.slice(0, 3)
}

export function autoSkillsPromptBlock(skills) {
  if (!skills.length) return null
  return (
    `# Automatisch geladene Skills\n` +
    `Diese Skills wurden anhand der aktuellen Nutzeranfrage bereits vollständig geladen. Rufe skill_read dafür NICHT erneut auf. Wende sie in der angegebenen Reihenfolge an. Explizite Wünsche des Nutzers zu Kürze, Format und Fokus schlagen den Standardumfang der Definition of Done.\n\n` +
    skills.map(skillText).join('\n\n---\n\n')
  )
}

export function skillText(s) {
  return [
    `# Skill: ${s.name} (/${s.slug})`,
    `## Kontext\n${s.context}`,
    `## Workflow\n${s.workflow}`,
    s.tools?.length ? `## Verknüpfte Tools\n${s.tools.join(', ')}` : null,
    `## Definition of Done\n${s.definition_of_done}`,
    s.corner_cases ? `## Corner Cases\n${s.corner_cases}` : null,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const skillToolDefinitions = [
  {
    name: 'skill_read',
    description:
      'Lädt einen Skill (Best-Practice-Playbook) vollständig: Kontext, Workflow, verknüpfte Tools, Definition of Done, Corner Cases. Rufe das auf, BEVOR du eine Aufgabe beginnst, die zu einem Skill-Trigger passt — der Workflow dort ist verbindlich.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Der Skill-Slug, z. B. "health-check" (ohne führenden Slash)' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'skill_create_draft',
    description:
      'Legt einen NEUEN Skill als persönlichen Entwurf für den aktuellen Nutzer an (visibility "personal" — wirkt sofort nur in seinem Account; team-weit teilen kann er später im Skill-Editor per "Für das Team vorschlagen", freischalten tut der Admin). Nutze das im /skill-creator-Workflow, NACHDEM der Nutzer den Entwurf bestätigt hat — nie ungefragt.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'kebab-case, wird zugleich der Slash-Command (/slug)' },
        name: { type: 'string' },
        category: { type: 'string', description: 'z. B. Vertrieb, Marketing, Implementation, Kommunikation, Dokumente, Finanzen, Meta' },
        context: { type: 'string', description: 'Warum/wofür gibt es den Skill (Hintergrund, Use Cases)' },
        workflow: { type: 'string', description: 'Schritt-für-Schritt-Workflow, nummeriert' },
        tools: { type: 'array', items: { type: 'string' }, description: 'Verknüpfte Basis-Tools, z. B. wiki_semantic_search' },
        triggers: { type: 'string', description: 'Wann greift der Skill (Slash-Command + typische Formulierungen)' },
        definition_of_done: { type: 'string' },
        corner_cases: { type: 'string' },
      },
      required: ['slug', 'name', 'category', 'context', 'workflow', 'triggers', 'definition_of_done'],
      additionalProperties: false,
    },
  },
]

export async function runSkillTool(name, input, ctx = {}) {
  if (name === 'skill_create_draft') {
    if (!ctx.userId) return 'Kein Nutzerkontext — Skill kann nicht angelegt werden.'
    const slug = String(input.slug || '').replace(/^\//, '').trim().toLowerCase()
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return `Ungültiger Slug "${slug}" — kebab-case (a-z, 0-9, Bindestrich).`
    const { error } = await db.from('skills').insert({
      slug,
      name: input.name,
      category: input.category || 'Allgemein',
      context: input.context || '',
      workflow: input.workflow || '',
      tools: input.tools || [],
      triggers: input.triggers || '',
      definition_of_done: input.definition_of_done || '',
      corner_cases: input.corner_cases || '',
      visibility: 'personal',
      enabled: true,
      created_by: ctx.userId,
      updated_by: ctx.userId,
    })
    if (error) {
      if (error.code === '23505') return `Der Slug "/${slug}" ist schon vergeben — wähle einen anderen.`
      return `Fehler beim Anlegen: ${error.message}`
    }
    return `Skill "/${slug}" als persönlicher Entwurf angelegt (Kategorie ${input.category || 'Allgemein'}). Er wirkt ab sofort im Account des Nutzers und ist unter Spaces → Skills editierbar. Team-weit teilen: im Skill-Editor "Für das Team vorschlagen" — der Admin schaltet frei.`
  }
  if (name !== 'skill_read') throw new Error(`Unbekanntes Skill-Tool: ${name}`)
  const slug = String(input.slug || '').replace(/^\//, '').trim().toLowerCase()
  const { data: s } = await db.from('skills').select('*').eq('slug', slug).maybeSingle()
  if (!s || !skillVisibleTo(s, ctx.userId)) {
    const skills = await loadEnabledSkills(ctx.userId)
    return `Kein Skill "${slug}". Verfügbar: ${skills.map((x) => '/' + x.slug).join(', ') || 'keine'}`
  }
  if (!s.enabled) return `Skill "${slug}" ist deaktiviert.`
  return skillText(s)
}
