import { db } from '../db.js'
import { decryptSecret } from '../crypto.js'

// ============================================================ Attio-CRM (nativ, read-only)
// Per Knopfdruck verbunden: Admin hinterlegt einen Attio-API-Key (Workspace Settings →
// Developers → Access Token) — gespeichert write-only in `connectors` (kind='attio').
// Bewusst NUR Lese-Tools: Enni recherchiert im CRM, schreibt aber nichts.

const BASE = 'https://api.attio.com/v2'
const CACHE_TTL_MS = 60_000
const cache = new Map() // userId||'team' -> { at, token }

// Per-User-Aufloesung: eigener persoenlicher Connector hat Vorrang vor dem Team-Connector
async function attioToken(userId) {
  const key = userId || 'team'
  const c = cache.get(key)
  if (c && Date.now() - c.at < CACHE_TTL_MS) return c.token
  const { data } = await db.from('connectors').select('token, owner, visibility').eq('kind', 'attio')
  const rows = data || []
  const own = userId ? rows.find((r) => r.owner === userId && r.visibility !== 'team') : null
  const team = rows.find((r) => r.visibility === 'team')
  const token = decryptSecret((own || team)?.token || null)
  cache.set(key, { at: Date.now(), token })
  return token
}

export function invalidateAttioCache() {
  cache.clear()
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

const ALLOWED_LINK_OBJECTS = new Set(['companies', 'people', 'deals'])

function firstValue(values, key) {
  const item = values?.[key]?.[0]
  if (!item) return null
  return item.value || item.full_name || item.email_address || item.domain || item.name || item.title || null
}

export function normalizeAttioRecord(record, fallbackObject = null) {
  const values = record?.values || {}
  const object = record?.id?.object_slug || record?.object || fallbackObject
  const name = firstValue(values, 'name') || firstValue(values, 'full_name') || firstValue(values, 'title') || 'Unbenannter Record'
  const domain = firstValue(values, 'domains')
  const email = firstValue(values, 'email_addresses')
  const secondary = domain || email || firstValue(values, 'stage') || null
  return {
    object,
    record_id: record?.id?.record_id || record?.record_id,
    name: String(name),
    secondary: secondary ? String(secondary) : null,
    domain: domain ? String(domain) : null,
    email: email ? String(email) : null,
    web_url: record?.web_url || null,
  }
}

export async function hasAttioConnection(userId) {
  return !!(await attioToken(userId))
}

export async function searchAttioRecords(userId, object, query, limit = 10) {
  if (!ALLOWED_LINK_OBJECTS.has(object)) throw new Error('Unbekannter Attio-Objekttyp')
  const token = await attioToken(userId)
  if (!token) throw new Error('Attio ist nicht verbunden')
  const raw = await attioFetch(token, '/objects/records/search', {
    method: 'POST',
    body: JSON.stringify({
      query: String(query || '').trim(),
      objects: [object],
      request_as: { type: 'workspace' },
      limit: Math.min(Number(limit) || 10, 25),
    }),
  })
  const parsed = JSON.parse(raw)
  // Der Beta-Suchendpunkt liefert absichtlich nur kompakte Treffer. Die UI zeigt
  // deshalb nie veraltete/halbe Snapshots: jeden Treffer einmal exakt nachladen.
  const ids = (parsed.data || [])
    .map((record) => record?.id?.record_id || record?.record_id)
    .filter(Boolean)
    .slice(0, Math.min(Number(limit) || 10, 25))
  return Promise.all(ids.map(async (recordId) => {
    const exact = await attioFetch(token, `/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`)
    const record = JSON.parse(exact)
    return normalizeAttioRecord(record.data || record, object)
  }))
}

export async function getAttioRecordSummary(userId, object, recordId) {
  if (!ALLOWED_LINK_OBJECTS.has(object)) throw new Error('Unbekannter Attio-Objekttyp')
  const token = await attioToken(userId)
  if (!token) throw new Error('Attio ist nicht verbunden')
  const raw = await attioFetch(token, `/objects/${encodeURIComponent(object)}/records/${encodeURIComponent(recordId)}`)
  const parsed = JSON.parse(raw)
  return normalizeAttioRecord(parsed.data || parsed, object)
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
    name: 'attio_list_meetings',
    description:
      'Listet Meetings/Calls aus Attio (Kalender-Sync + Call Intelligence), neueste zuerst. Filterbar nach Zeitraum, Titel-Suchwort, Teilnehmer-Emails oder verknüpftem Record. Liefert meeting_id für attio_get_transcript. Tipp: für "Call mit Kunde X" nach dem Firmennamen im Titel filtern (query) ODER über linked_record gehen.',
    input_schema: {
      type: 'object',
      properties: {
        days_back: { type: 'number', description: 'Meetings der letzten N Tage (Default 7)' },
        query: { type: 'string', description: 'Suchwort im Meeting-Titel (client-seitig gefiltert)' },
        participants: { type: 'string', description: 'Komma-getrennte Teilnehmer-Emails (optional)' },
        linked_object: { type: 'string', description: 'Objekt-Slug für Record-Filter, z. B. "companies" (nur mit linked_record_id)' },
        linked_record_id: { type: 'string', description: 'Record-ID, deren Meetings gelistet werden sollen' },
        limit: { type: 'number', description: 'Max. Treffer, Default 30, max 200' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'attio_get_transcript',
    description:
      'Holt das Gesprächs-Transkript zu einem Meeting (Attio Call Intelligence) mit Sprecher-Zuordnung. Lange Transkripte kommen in Abschnitten — der Output nennt Gesamtlänge und den from_char-Wert zum Weiterlesen. Für "nächste Schritte / Fazit" lies auch das ENDE (tail=true), das steht fast immer am Schluss des Gesprächs. Wenn das Meeting keine Aufnahme hat, sagt das Tool das klar — dann existiert schlicht kein Transkript.',
    input_schema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'Die meeting_id aus attio_list_meetings' },
        call_recording_id: { type: 'string', description: 'Optional: konkrete Aufnahme, sonst wird die erste genommen' },
        from_char: { type: 'number', description: 'Ab welcher Zeichen-Position lesen (fürs Blättern), Default 0' },
        tail: { type: 'boolean', description: 'true = die letzten ~30k Zeichen lesen (Gesprächsende: Fazit, nächste Schritte)' },
      },
      required: ['meeting_id'],
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
export async function attioToolDefinitions(userId) {
  return (await attioToken(userId)) ? TOOL_DEFS : []
}

const clip = (s) => (s.length > 40000 ? s.slice(0, 40000) + '\n\n[... gekürzt]' : s)

export async function runAttioTool(name, input, ctx = {}) {
  const token = await attioToken(ctx.userId)
  if (!token) throw new Error('Attio ist nicht verbunden — verbinde es unter Spaces → Connections (persönlich) oder bitte den Admin.')

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
  if (name === 'attio_list_meetings') {
    const qs = new URLSearchParams({
      sort: 'start_desc',
      limit: String(Math.min(input.limit || 30, 200)),
      ends_from: new Date(Date.now() - (input.days_back || 7) * 86400000).toISOString(),
      starts_before: new Date(Date.now() + 86400000).toISOString(),
    })
    if (input.participants) qs.set('participants', input.participants)
    if (input.linked_object && input.linked_record_id) {
      qs.set('linked_object', input.linked_object)
      qs.set('linked_record_id', input.linked_record_id)
    }
    const res = JSON.parse(await attioFetch(token, `/meetings?${qs}`))
    let meetings = res.data || []
    if (input.query) {
      const q = input.query.toLowerCase()
      meetings = meetings.filter((m) => (m.title || '').toLowerCase().includes(q))
    }
    if (!meetings.length) return 'Keine Meetings im Zeitraum gefunden (ggf. days_back erhöhen oder query weglassen).'
    return clip(
      meetings
        .map((m) => {
          const start = m.start?.datetime || m.start?.date || '?'
          const who = (m.participants || []).map((p) => p.email_address).filter(Boolean).slice(0, 5).join(', ')
          return `${start} | ${m.title || '(ohne Titel)'} | meeting_id=${m.id.meeting_id}${who ? ` | ${who}` : ''}`
        })
        .join('\n')
    )
  }
  if (name === 'attio_get_transcript') {
    const mid = encodeURIComponent(input.meeting_id)
    const recs = JSON.parse(await attioFetch(token, `/meetings/${mid}/call_recordings`))
    if (!recs.data?.length) {
      return 'Dieses Meeting hat KEINE Call-Aufnahme in Attio — es existiert also kein Transkript. Das ist Datenlage, kein Fehler.'
    }
    const rid = input.call_recording_id || recs.data[0].id.call_recording_id
    const tr = JSON.parse(await attioFetch(token, `/meetings/${mid}/call_recordings/${encodeURIComponent(rid)}/transcript`))
    // Sprech-Segmente lesbar machen: "Sprecher: Text" — Struktur laut Attio-Doku
    const segments = tr.data?.segments || tr.segments || tr.data || []
    let full
    if (Array.isArray(segments) && segments.length) {
      full = segments
        .map((s) => {
          const speaker = s.speaker?.name || s.speaker_name || s.speaker || 'Sprecher'
          const text = s.text || s.words?.map((w) => w.text || w.word).join(' ') || ''
          return `${speaker}: ${text}`
        })
        .join('\n')
    } else {
      full = JSON.stringify(tr) // unbekanntes Format: roh liefern statt raten
    }
    // Blätterbar statt hart abgeschnitten: Abschnitt liefern + sagen, wie es weitergeht
    const CHUNK = 30000
    const start = input.tail ? Math.max(0, full.length - CHUNK) : Math.max(0, input.from_char || 0)
    const part = full.slice(start, start + CHUNK)
    const header = `[Transkript: ${full.length} Zeichen gesamt · Ausschnitt ${start}–${start + part.length}]`
    const footer =
      start + part.length < full.length
        ? `\n\n[... es folgt mehr — weiterlesen mit from_char=${start + part.length}, oder tail=true für das Gesprächsende]`
        : '\n\n[Ende des Transkripts]'
    return `${header}\n${part}${footer}`
  }
  if (name === 'attio_raw_get') {
    const path = String(input.path || '')
    if (!path.startsWith('/')) throw new Error('path muss mit / beginnen')
    return clip(await attioFetch(token, path))
  }
  throw new Error(`Unbekanntes Attio-Tool: ${name}`)
}
