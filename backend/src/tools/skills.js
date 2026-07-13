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
    `Für wiederkehrende Aufgaben gibt es Skills. Wenn die Anfrage zu einem Trigger passt ODER der Nutzer den Skill per Slash-Command (/slug) aufruft: lies ZUERST den vollen Skill mit skill_read und arbeite dann exakt nach dessen Workflow, beachte Corner Cases und prüfe am Ende die Definition of Done. Die im Skill verknüpften Tools sind deine Basis, aber nicht exklusiv.\n` +
    lines.join('\n')
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
