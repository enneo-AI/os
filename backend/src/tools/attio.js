import { db } from '../db.js'

// ============================================================ Attio-CRM (nativ, read-only)
// Per Knopfdruck verbunden: Admin hinterlegt einen Attio-API-Key (Workspace Settings →
// Developers → Access Token) — gespeichert write-only in `connectors` (kind='attio').
// Bewusst NUR Lese-Tools: Enni recherchiert im CRM, schreibt aber nichts.

const BASE = 'https://api.attio.com/v2'
const CACHE_TTL_MS = 60_000
let cache = { at: 0, token: null }

async function attioToken() {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.token
  const { data } = await db
    .from('connectors')
    .select('token')
    .eq('kind', 'attio')
    .limit(1)
    .maybeSingle()
  cache = { at: Date.now(), token: data?.token || null }
  return cache.token
}

export function invalidateAttioCache() {
  cache.at = 0
}

async function attioFetch(token, path, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Attio ${res.status}: ${text.slice(0, 400)}`)
  return text
}

// Verbindungstest beim Anlegen — liefert den Workspace-Namen
export async function probeAttio(token) {
  const raw = await attioFetch(token, '/self')
  const self = JSON.parse(raw)
  return self?.workspace_name || self?.data?.workspace_name || 'Attio-Workspace'
}

const TOOL_DEFS = [
  {
    name: 'attio_list_objects',
    description:
      'Listet alle Objekt-Typen im Attio-CRM (z. B. companies, people, deals) mit ihren Slugs. Rufe das zuerst auf, wenn du nicht weißt, welche Objekte es gibt.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'attio_query_records',
    description:
      'Sucht Records eines Objekt-Typs im Attio-CRM. filter ist Attios Filter-JSON, z. B. {"name":{"$contains":"Stadtwerke"}} — weglassen für die neuesten Records. Ergebnis enthält record_id für Detail-Abfragen.',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Objekt-Slug, z. B. "companies", "people", "deals"' },
        filter: { type: 'object', description: 'Attio-Filter-JSON (optional)' },
        limit: { type: 'number', description: 'Max. Treffer, Default 10' },
      },
      required: ['object'],
      additionalProperties: false,
    },
  },
  {
    name: 'attio_get_record',
    description: 'Liest einen einzelnen Attio-Record vollständig (alle Attribute).',
    input_schema: {
      type: 'object',
      properties: {
        object: { type: 'string', description: 'Objekt-Slug, z. B. "companies"' },
        record_id: { type: 'string', description: 'Die record_id aus attio_query_records' },
      },
      required: ['object', 'record_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'attio_list_notes',
    description: 'Listet die Notizen zu einem Attio-Record (z. B. Discovery-Notes zu einer Company).',
    input_schema: {
      type: 'object',
      properties: {
        parent_object: { type: 'string', description: 'Objekt-Slug des Records, z. B. "companies"' },
        record_id: { type: 'string', description: 'Die record_id' },
        limit: { type: 'number', description: 'Max. Notizen, Default 10' },
      },
      required: ['parent_object', 'record_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'attio_raw_get',
    description:
      'Generischer READ-Zugriff auf jeden GET-Endpoint der Attio-API v2 (Pfad beginnt mit /, z. B. "/tasks" oder "/lists"). Nur für Fälle, die die anderen attio_-Tools nicht abdecken.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'API-Pfad relativ zu /v2, z. B. "/lists" oder "/tasks?limit=10"' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

// Tools nur anbieten, wenn ein Attio-Connector existiert
export async function attioToolDefinitions() {
  return (await attioToken()) ? TOOL_DEFS : []
}

const clip = (s) => (s.length > 40000 ? s.slice(0, 40000) + '\n\n[... gekürzt]' : s)

export async function runAttioTool(name, input) {
  const token = await attioToken()
  if (!token) throw new Error('Attio ist nicht verbunden — der Admin kann es unter Connections verknüpfen.')

  if (name === 'attio_list_objects') {
    return clip(await attioFetch(token, '/objects'))
  }
  if (name === 'attio_query_records') {
    const body = { limit: Math.min(input.limit || 10, 50) }
    if (input.filter) body.filter = input.filter
    return clip(
      await attioFetch(token, `/objects/${encodeURIComponent(input.object)}/records/query`, {
        method: 'POST',
        body: JSON.stringify(body),
      })
    )
  }
  if (name === 'attio_get_record') {
    return clip(
      await attioFetch(
        token,
        `/objects/${encodeURIComponent(input.object)}/records/${encodeURIComponent(input.record_id)}`
      )
    )
  }
  if (name === 'attio_list_notes') {
    const qs = new URLSearchParams({
      parent_object: input.parent_object,
      parent_record_id: input.record_id,
      limit: String(Math.min(input.limit || 10, 50)),
    })
    return clip(await attioFetch(token, `/notes?${qs}`))
  }
  if (name === 'attio_raw_get') {
    const path = String(input.path || '')
    if (!path.startsWith('/')) throw new Error('path muss mit / beginnen')
    return clip(await attioFetch(token, path))
  }
  throw new Error(`Unbekanntes Attio-Tool: ${name}`)
}
