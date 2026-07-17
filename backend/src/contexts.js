import { db } from './db.js'

const CONTEXT_RELATION = `
  skill_contexts (
    requirement,
    position,
    contexts (id, name, description, content, context_type, visibility, owner_id, updated_at)
  )
`

export function contextVisibleTo(context, userId) {
  return context?.visibility === 'team' || context?.owner_id === userId
}

export function visibleSkillContexts(skill, userId, requirement = null) {
  return (skill?.skill_contexts || [])
    .filter((link) => link.contexts && contextVisibleTo(link.contexts, userId))
    .filter((link) => !requirement || link.requirement === requirement)
    .sort((a, b) => (a.position || 0) - (b.position || 0))
}

export function requiredContextsText(skill, userId) {
  const links = visibleSkillContexts(skill, userId, 'required')
  if (!links.length) return null
  return [
    '## Verbindlich geladene Kontexte',
    'Die folgenden Quellen sind für diesen Skill verbindlich. Ihre aktuellen Inhalte haben Vorrang vor allgemeinen Annahmen:',
    ...links.map(({ contexts: context }) =>
      `### ${context.name}\n${context.description ? `${context.description}\n\n` : ''}${context.content}`
    ),
  ].join('\n\n')
}

export async function loadSkillWithContexts(slug, userId) {
  const { data } = await db
    .from('skills')
    .select(`*, ${CONTEXT_RELATION}`)
    .eq('slug', slug)
    .maybeSingle()
  if (!data) return null
  data.required_context_count = (data.skill_contexts || []).filter((link) => link.requirement === 'required').length
  data.skill_contexts = visibleSkillContexts(data, userId)
  return data
}

export async function loadPersonalContextBlock(userId) {
  if (!userId) return null
  const { data: context } = await db
    .from('contexts')
    .select('name, content, structured_data, updated_at')
    .eq('owner_id', userId)
    .eq('context_type', 'personal_profile')
    .maybeSingle()
  if (!context?.content?.trim()) return null
  return (
    `# Privater persönlicher Kontext\n` +
    `Dieser Kontext gehört ausschließlich zum aktuellen Account. Nutze ihn still zur Personalisierung; gib sensible Details nicht ungefragt wieder.\n\n` +
    context.content.trim()
  )
}

export async function savePersonalContext(userId, input) {
  const answers = {
    responsibilities: String(input.responsibilities || '').trim(),
    preferences: String(input.preferences || '').trim(),
    challenges: String(input.challenges || '').trim(),
    goals_3_months: String(input.goals_3_months || '').trim(),
    goals_6_months: String(input.goals_6_months || '').trim(),
    goals_12_months: String(input.goals_12_months || '').trim(),
  }
  const sections = [
    ['Rolle und Verantwortungsbereich', answers.responsibilities],
    ['Arbeits- und Kommunikationspräferenzen', answers.preferences],
    ['Aktuelle Probleme und Engpässe', answers.challenges],
    ['Ziele in den nächsten 3 Monaten', answers.goals_3_months],
    ['Ziele in den nächsten 6 Monaten', answers.goals_6_months],
    ['Ziele in den nächsten 12 Monaten', answers.goals_12_months],
  ].filter(([, value]) => value)
  if (!sections.length) throw new Error('Mindestens eine Interview-Antwort ist erforderlich.')
  const content = sections.map(([title, value]) => `## ${title}\n${value}`).join('\n\n')
  const row = {
    name: 'Mein persönlicher Arbeitskontext',
    description: 'Aus dem privaten Onboarding-Interview generiert.',
    content,
    context_type: 'personal_profile',
    visibility: 'personal',
    owner_id: userId,
    is_locked: true,
    structured_data: answers,
    source: 'onboarding',
    created_by: userId,
    updated_by: userId,
  }
  const { data: existing } = await db.from('contexts')
    .select('id').eq('owner_id', userId).eq('context_type', 'personal_profile').maybeSingle()
  const query = existing
    ? db.from('contexts').update(row).eq('id', existing.id)
    : db.from('contexts').insert(row)
  const { data, error } = await query.select('*').single()
  if (error) throw error
  return data
}

export { CONTEXT_RELATION }
