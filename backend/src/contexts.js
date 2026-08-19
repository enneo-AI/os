import { db } from './db.js'
import { allowedSpaceIds } from './tools/wiki.js'

// ============================================================ Verbindliche Skill-Quellen
// Seit 2026-08-19 lebt Firmenwissen an EINEM Ort: als Wiki-Seite in einem Space.
// Skills referenzieren als verbindliche Quellen einzelne Seiten, ganze Ordner oder
// ganze Spaces (Tabelle skill_sources). Die frühere Kontexte-Bibliothek ist stillgelegt;
// die contexts-Tabelle trägt nur noch den persönlichen Profil-Kontext (personal_profile).

const SOURCES_RELATION = `
  skill_sources (
    id,
    space_id,
    folder,
    position,
    wiki_page_id,
    wiki_pages (id, slug, title, space_id)
  )
`

// Gesamtbudget für verbindlich geladenes Quellen-Wissen pro Skill. Darüber hinaus
// werden Ordner-Seiten als Pflicht-Leseliste (Titel + Slug) statt Volltext geliefert.
const SOURCE_CONTENT_BUDGET = 30000
const PAGE_CONTENT_CAP = 20000

function sortedSources(skill) {
  return [...(skill?.skill_sources || [])].sort((a, b) => (a.position || 0) - (b.position || 0))
}

// Ein Skill ist nur nutzbar, wenn ALLE verbindlichen Quellen für den Nutzer sichtbar
// sind (gleiches Prinzip wie früher bei Pflicht-Kontexten): sonst würde der Skill
// ohne sein verbindliches Wissen laufen oder Restricted-Inhalte leaken.
export function skillSourcesVisible(skill, spaceIds) {
  if (spaceIds === null) return true // Admin sieht alles
  return sortedSources(skill).every((source) => {
    const targetSpace = source.wiki_page_id ? source.wiki_pages?.space_id : source.space_id
    return targetSpace ? spaceIds.includes(targetSpace) : false
  })
}

// Lädt die Inhalte der verbindlichen Quellen und hängt sie als _sourcesText an den
// Skill. Bewusst nur dort aufrufen, wo der Skill wirklich vollständig gebraucht wird
// (skill_read, Auto-Load) — nicht für den kompakten Trigger-Katalog.
export async function attachSkillSourcesText(skill, userId) {
  const sources = sortedSources(skill)
  if (!sources.length) {
    skill._sourcesText = null
    return skill
  }
  const spaceIds = await allowedSpaceIds(userId)
  const sections = []
  let budget = SOURCE_CONTENT_BUDGET
  for (const source of sources) {
    if (source.wiki_page_id) {
      if (spaceIds !== null && !spaceIds.includes(source.wiki_pages?.space_id)) continue
      const { data: page } = await db
        .from('wiki_pages')
        .select('slug, title, content')
        .eq('id', source.wiki_page_id)
        .maybeSingle()
      if (!page) continue
      const content = (page.content || '').slice(0, Math.min(PAGE_CONTENT_CAP, Math.max(budget, 2000)))
      budget -= content.length
      sections.push(`### ${page.title} (${page.slug})\n${content}`)
      continue
    }
    if (spaceIds !== null && !spaceIds.includes(source.space_id)) continue
    let q = db
      .from('wiki_pages')
      .select('slug, title, content')
      .eq('space_id', source.space_id)
      .order('slug')
    if (source.folder) q = q.or(`slug.like.${source.folder}/%,slug.eq.${source.folder}`)
    const { data: pages } = await q
    if (!pages?.length) continue
    const scopeLabel = source.folder ? `Ordner "${source.folder}/"` : 'gesamter Space'
    const loaded = []
    const listed = []
    for (const page of pages) {
      const content = page.content || ''
      if (budget - content.length > 0 && content.length <= PAGE_CONTENT_CAP) {
        budget -= content.length
        loaded.push(`### ${page.title} (${page.slug})\n${content}`)
      } else {
        listed.push(`- ${page.title} (${page.slug})`)
      }
    }
    if (loaded.length) sections.push(`#### Quelle: ${scopeLabel}\n\n${loaded.join('\n\n')}`)
    if (listed.length) {
      sections.push(
        `#### Weitere Pflicht-Seiten aus ${scopeLabel} (aus Platzgründen nicht vorgeladen)\n` +
        `Lies die für die Aufgabe relevanten davon ZWINGEND mit wiki_read_page, bevor du inhaltlich antwortest:\n` +
        listed.join('\n')
      )
    }
  }
  skill._sourcesText = sections.length
    ? [
        '## Verbindliche Quellen (aus den Spaces geladen)',
        'Diese Quellen sind für diesen Skill verbindlich und haben Vorrang vor allgemeinen Annahmen. Nutze primär sie; NUR wenn sie die konkrete Frage nicht abdecken, recherchiere ergänzend (wiki_semantic_search).',
        ...sections,
      ].join('\n\n')
    : null
  return skill
}

export async function loadSkillWithSources(slug, userId) {
  const { data } = await db
    .from('skills')
    .select(`*, ${SOURCES_RELATION}`)
    .eq('slug', slug)
    .maybeSingle()
  if (!data) return null
  const spaceIds = await allowedSpaceIds(userId)
  data._sourcesVisible = skillSourcesVisible(data, spaceIds)
  return data
}

export { SOURCES_RELATION }

// ============================================================ Persönlicher Profil-Kontext
// (Onboarding-Interview — unverändert, unabhängig von der abgeschafften Bibliothek)

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
