import { db } from './db.js'

const keyFor = (id) => `connector:${id}`
const CACHE_TTL_MS = 5_000
const accessCache = new Map()

export function invalidateConnectorAccessCache() {
  accessCache.clear()
}

// The backend uses the service role, so Space authorization must be applied
// explicitly here. Connector visibility controls catalog discovery only; it
// never grants Enni execution access by itself.
export async function connectorsForUser(userId, kind = null, { fresh = false } = {}) {
  if (!userId) return []
  const cached = accessCache.get(userId)
  if (!fresh && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return kind ? cached.rows.filter((row) => row.kind === kind) : cached.rows
  }
  const { data: profile, error: profileError } = await db.from('profiles')
    .select('account_status')
    .eq('id', userId)
    .maybeSingle()
  if (profileError) throw new Error(profileError.message)
  if (profile?.account_status !== 'active') return []
  const { data: connectors, error } = await db.from('connectors').select('*').order('created_at')
  if (error) throw new Error(error.message)
  if (!connectors?.length) return []

  const keys = connectors.map((connector) => keyFor(connector.id))
  const { data: assignments, error: assignmentError } = await db
    .from('space_connections')
    .select('space_id, connection_key')
    .in('connection_key', keys)
  if (assignmentError) throw new Error(assignmentError.message)
  if (!assignments?.length) return []

  const spaceIds = [...new Set(assignments.map((row) => row.space_id))]
  const [{ data: spaces, error: spacesError }, { data: memberships, error: membershipsError }] = await Promise.all([
    db.from('spaces').select('id, restricted, created_by').in('id', spaceIds),
    db.from('space_members').select('space_id').eq('user_id', userId).in('space_id', spaceIds),
  ])
  if (spacesError) throw new Error(spacesError.message)
  if (membershipsError) throw new Error(membershipsError.message)

  const memberOf = new Set((memberships || []).map((row) => row.space_id))
  const accessibleSpaces = new Set((spaces || [])
    .filter((space) => !space.restricted || space.created_by === userId || memberOf.has(space.id))
    .map((space) => space.id))
  const allowedKeys = new Set(assignments
    .filter((row) => accessibleSpaces.has(row.space_id))
    .map((row) => row.connection_key))
  const rows = connectors.filter((connector) => allowedKeys.has(keyFor(connector.id)))
  accessCache.set(userId, { at: Date.now(), rows })
  return kind ? rows.filter((row) => row.kind === kind) : rows
}

export async function connectorForUser(kind, userId, options = {}) {
  const rows = await connectorsForUser(userId, kind, options)
  return rows.find((row) => row.owner === userId)
    || rows.find((row) => row.visibility === 'team')
    || rows[0]
    || null
}

export async function canUseConnector(connectorId, userId) {
  const rows = await connectorsForUser(userId, null, { fresh: true })
  return rows.some((row) => row.id === connectorId)
}

export async function moveConnectorAssignments(oldIds, newId) {
  const ids = [...new Set((oldIds || []).filter((id) => id && id !== newId))]
  if (!ids.length || !newId) return
  const oldKeys = ids.map(keyFor)
  const { data: rows, error } = await db.from('space_connections')
    .select('space_id, added_by')
    .in('connection_key', oldKeys)
  if (error) throw new Error(error.message)
  if (rows?.length) {
    const unique = [...new Map(rows.map((row) => [row.space_id, row])).values()]
    const { error: insertError } = await db.from('space_connections').upsert(
      unique.map((row) => ({ space_id: row.space_id, connection_key: keyFor(newId), added_by: row.added_by })),
      { onConflict: 'space_id,connection_key' }
    )
    if (insertError) throw new Error(insertError.message)
  }
  const { error: deleteError } = await db.from('space_connections').delete().in('connection_key', oldKeys)
  if (deleteError) throw new Error(deleteError.message)
  invalidateConnectorAccessCache()
}
