// Enneo-Plattform-Connector — spricht die Mind-API der Enneo-Instanzen,
// dieselbe API wie das offizielle Enneo Claude Code Plugin (https://{instanz}/api/mind).
// Auth: universeller Production-Token (ENNEO_TOKEN) — gilt instanz-übergreifend, nie im Repo.
// Lesen: direkt. Schreiben: NUR über enneo_propose_write → Freigabe-Karte im Chat → Backend führt aus.
// Instanz-Auflösung ist universell: jede {name}.enneo.ai, die der Nutzer nennt.
// ENNEO_INSTANCES (kommagetrennt) liefert nur den Default (erster Eintrag).

import { db } from '../db.js'

const INSTANCES = (process.env.ENNEO_INSTANCES || 'aleksa-dev.enneo.ai')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function resolveInstance(input) {
  if (!input) return INSTANCES[0]
  let host = input.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase()
  if (!host.includes('.')) host = `${host}.enneo.ai`
  if (!/^[a-z0-9][a-z0-9.-]*\.enneo\.ai$/.test(host)) {
    throw new Error(`"${input}" ist keine gültige Enneo-Instanz (erwartet: {name}.enneo.ai)`)
  }
  return host
}

async function mind(instance, path, { method = 'GET', query, body } = {}) {
  const url = new URL(`https://${instance}/api/mind${path}`)
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
  }
  const init = {
    method,
    headers: { Authorization: `Bearer ${process.env.ENNEO_TOKEN || ''}`, Accept: 'application/json' },
  }
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(body)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`Enneo ${instance} ${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`)
  if (!text) return ''
  return text
}

// Zugangsdaten in Settings-Antworten schwärzen (SIP-Passwörter, API-Keys etc.)
function redactSecrets(text) {
  return text.replace(
    /"(password|secret|apiKey|api_key|token|authToken)"\s*:\s*"[^"]*"/gi,
    '"$1":"[geschwärzt]"'
  )
}

function clip(text, max = 40000) {
  return text.length > max ? text.slice(0, max) + '\n\n[... gekürzt]' : text
}

const instanceProp = {
  instance: {
    type: 'string',
    description: 'Enneo-Instanz (Hostname oder Kurzname, z.B. "aleksa-dev"). Weglassen = Default-Instanz.',
  },
}

export const enneoToolDefinitions = [
  {
    name: 'enneo_ticket_search',
    description:
      'Sucht Tickets in einer Enneo-Instanz nach Filtern. Liefert kompakte Treffer (ohne Body/Anhänge — für Details enneo_ticket_get). Filter-Keys: t.status, t.channel, t.direction, t.priority, t.createdAt, t.agentId, t.contractId, t.customerId, t.aiSupportLevel, tt.tagId, i.aiAgentId. Comparators: =, !=, >, <, in, between.',
    input_schema: {
      type: 'object',
      properties: {
        ...instanceProp,
        filters: {
          type: 'array',
          description: 'z.B. [{"key":"t.status","values":["open"],"comparator":"in"}]',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string' },
              comparator: { type: 'string' },
              value: {},
              values: { type: 'array' },
              from: { type: 'string' },
              to: { type: 'string' },
            },
          },
        },
        limit: { type: 'integer', description: 'max. Treffer (Default 20)' },
        orderByField: { type: 'string', description: 'Default t.createdAt' },
        orderByDirection: { type: 'string', enum: ['asc', 'desc'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enneo_ticket_get',
    description:
      'Holt ein einzelnes Ticket komplett (Body, Konversationen, Kunde, erkannte Intents) per Ticket-ID.',
    input_schema: {
      type: 'object',
      properties: {
        ...instanceProp,
        ticket_id: { type: 'integer', description: 'Numerische Ticket-ID' },
      },
      required: ['ticket_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'enneo_settings_search',
    description:
      'Durchsucht die Instanz-Settings (Konfiguration, Feature-Flags, Version). Zugangsdaten werden geschwärzt.',
    input_schema: {
      type: 'object',
      properties: {
        ...instanceProp,
        q: { type: 'string', description: 'Freitext-Suche über Settings' },
        name: { type: 'string', description: 'Exakter/teilweiser Setting-Name (filterByName)' },
        category: { type: 'string', description: 'Setting-Kategorie (filterByCategory)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'enneo_api_get',
    description:
      'Generischer read-only GET auf die Enneo Mind-API (/api/mind{path}). Für alles, wofür es kein eigenes Tool gibt — z.B. /customer/byTicketId/{id}, /aiAgent, /aiAgent/{id}, /intent/byTicketId/{id}, /ticket/{id}/activity, /tag, /settings/category/{cat}. Nur GET, keine Schreiboperationen.',
    input_schema: {
      type: 'object',
      properties: {
        ...instanceProp,
        path: { type: 'string', description: 'API-Pfad ab /api/mind, muss mit / beginnen. Query-Parameter direkt im Pfad erlaubt.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'enneo_propose_write',
    description:
      'Schlägt eine SCHREIB-Operation auf einer Enneo-Instanz vor (POST/PUT/PATCH auf die Mind-API). Führt NICHTS aus — der Nutzer bekommt eine Freigabe-Karte im Chat und muss explizit bestätigen. Nutze das für Settings-Änderungen (PUT /settings/{name}), Tags anlegen (POST /tag mit name+reference+type), Ticket-Updates etc. DELETE ist grundsätzlich gesperrt. Formuliere summary so, dass ein Mensch die Auswirkung ohne API-Kenntnis versteht.',
    input_schema: {
      type: 'object',
      properties: {
        ...instanceProp,
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH'] },
        path: { type: 'string', description: 'API-Pfad ab /api/mind, muss mit / beginnen' },
        body: { description: 'Request-Body (JSON-Objekt, String oder Zahl — je nach Endpoint)' },
        summary: { type: 'string', description: 'Ein Satz für den Menschen: was ändert sich wo, alter → neuer Zustand wenn bekannt' },
      },
      required: ['method', 'path', 'summary'],
      additionalProperties: false,
    },
  },
]

// Wird vom Freigabe-Endpoint in index.js aufgerufen — erst hier passiert der echte API-Call.
export async function executeWriteProposal(proposalId, userId) {
  const { data: p } = await db.from('enneo_write_proposals').select('*').eq('id', proposalId).maybeSingle()
  if (!p) throw new Error('Vorschlag nicht gefunden')
  if (p.status !== 'proposed') throw new Error(`Vorschlag ist bereits ${p.status}`)
  let status = 'executed'
  let result
  try {
    result = await mind(p.instance, p.path, { method: p.method, body: p.body ?? undefined })
  } catch (err) {
    status = 'failed'
    result = err.message
  }
  await db
    .from('enneo_write_proposals')
    .update({ status, result: String(result).slice(0, 5000), approved_by: userId, executed_at: new Date().toISOString() })
    .eq('id', proposalId)
  return { status, result: String(result).slice(0, 2000) }
}

export async function rejectWriteProposal(proposalId, userId) {
  const { data: p } = await db.from('enneo_write_proposals').select('status').eq('id', proposalId).maybeSingle()
  if (!p) throw new Error('Vorschlag nicht gefunden')
  if (p.status !== 'proposed') throw new Error(`Vorschlag ist bereits ${p.status}`)
  await db
    .from('enneo_write_proposals')
    .update({ status: 'rejected', approved_by: userId, executed_at: new Date().toISOString() })
    .eq('id', proposalId)
  return { status: 'rejected' }
}

export async function runEnneoTool(name, input, ctx = {}) {
  if (!process.env.ENNEO_TOKEN) {
    return 'Der Enneo-Connector ist noch nicht konfiguriert (ENNEO_TOKEN fehlt). Sag dem Nutzer, dass der Connector erst eingerichtet werden muss.'
  }
  const instance = resolveInstance(input.instance)

  if (name === 'enneo_propose_write') {
    if (!input.path.startsWith('/')) throw new Error('path muss mit / beginnen')
    const { data, error } = await db
      .from('enneo_write_proposals')
      .insert({
        conversation_id: ctx.conversationId || null,
        proposed_by: ctx.userId || null,
        instance,
        method: input.method,
        path: input.path,
        body: input.body ?? null,
        summary: input.summary,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    return JSON.stringify({
      proposal_id: data.id,
      status: 'proposed',
      hinweis:
        'Vorschlag gespeichert — der Nutzer sieht jetzt eine Freigabe-Karte im Chat und entscheidet dort. Sag ihm kurz, WAS du vorschlägst, und dass er es über die Karte ausführen oder ablehnen kann. Führe nichts selbst aus.',
    })
  }

  if (name === 'enneo_ticket_search') {
    const body = {
      filters: input.filters || [],
      limit: Math.min(input.limit || 20, 100),
      offset: 0,
      orderByField: input.orderByField || 't.createdAt',
      orderByDirection: input.orderByDirection || 'desc',
    }
    return clip(await mind(instance, '/ticket/search', { method: 'POST', body }))
  }

  if (name === 'enneo_ticket_get') {
    return clip(await mind(instance, `/ticket/${input.ticket_id}`, { query: { erpCacheOnly: true } }))
  }

  if (name === 'enneo_settings_search') {
    let raw
    if (input.q) raw = await mind(instance, '/settings/search', { query: { q: input.q } })
    else raw = await mind(instance, '/settings', { query: { filterByName: input.name, filterByCategory: input.category } })
    return clip(redactSecrets(raw))
  }

  if (name === 'enneo_api_get') {
    if (!input.path.startsWith('/')) throw new Error('path muss mit / beginnen')
    const raw = await mind(instance, input.path)
    return clip(input.path.startsWith('/settings') ? redactSecrets(raw) : raw)
  }

  throw new Error(`Unbekanntes Enneo-Tool: ${name}`)
}
