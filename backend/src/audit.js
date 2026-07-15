import { db } from './db.js'

export async function logAudit(actorId, action, targetType, targetId = null, metadata = {}) {
  const { error } = await db.from('audit_log').insert({
    actor_id: actorId || null,
    action,
    target_type: targetType,
    target_id: targetId ? String(targetId) : null,
    metadata,
  })
  if (error) console.error('Audit-Log fehlgeschlagen:', error.message)
}
