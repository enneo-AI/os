import { db } from './db.js'

export async function podContextPrompt(pod) {
  if (!pod?.id) return ''
  const [{ data: memberships }, { data: contexts }] = await Promise.all([
    db.from('pod_members').select('user_id').eq('pod_id', pod.id).order('created_at'),
    db.from('pod_member_contexts').select('user_id, role_title, responsibilities').eq('pod_id', pod.id),
  ])
  const userIds = [...new Set([pod.created_by, ...(memberships || []).map((member) => member.user_id)].filter(Boolean))]
  const { data: profiles } = userIds.length
    ? await db.from('profiles').select('id, display_name, email, role_title').in('id', userIds)
    : { data: [] }
  const profileById = new Map((profiles || []).map((profile) => [profile.id, profile]))
  const contextById = new Map((contexts || []).map((context) => [context.user_id, context]))
  const roles = userIds.map((userId) => {
    const profile = profileById.get(userId)
    const context = contextById.get(userId)
    const name = profile?.display_name || profile?.email || 'Teammitglied'
    const role = context?.role_title || profile?.role_title || 'Rolle nicht beschrieben'
    const responsibilities = context?.responsibilities || 'Verantwortungen nicht beschrieben'
    return `- ${name} — ${role}\n  Verantwortungen: ${responsibilities}`
  })
  const blocks = []
  if (pod.instructions) blocks.push(`Instructions for Agents:\n${pod.instructions}`)
  if (roles.length) blocks.push(`Teamrollen und Verantwortungen:\n${roles.join('\n')}`)
  return blocks.length ? `\n\nPOD-KONTEXT (in jedem Turn verbindlich berücksichtigen):\n${blocks.join('\n\n')}` : ''
}
