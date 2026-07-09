import { db } from '../db.js'

// ============================================================ Skills (Best-Practice-Playbooks)
// Skills sagen Enni, WIE man Dinge bei enneo richtig macht. Die Trigger-Übersicht
// aller aktiven Skills wandert kompakt in den System-Prompt; den vollen Skill
// lädt Enni bei Bedarf über skill_read.

export async function loadEnabledSkills() {
  const { data } = await db
    .from('skills')
    .select('slug, name, context, workflow, tools, triggers, definition_of_done, corner_cases')
    .eq('enabled', true)
    .order('name')
  return data || []
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
]

export async function runSkillTool(name, input) {
  if (name !== 'skill_read') throw new Error(`Unbekanntes Skill-Tool: ${name}`)
  const slug = String(input.slug || '').replace(/^\//, '').trim().toLowerCase()
  const { data: s } = await db.from('skills').select('*').eq('slug', slug).maybeSingle()
  if (!s) {
    const skills = await loadEnabledSkills()
    return `Kein Skill "${slug}". Verfügbar: ${skills.map((x) => '/' + x.slug).join(', ') || 'keine'}`
  }
  if (!s.enabled) return `Skill "${slug}" ist deaktiviert.`
  return skillText(s)
}
