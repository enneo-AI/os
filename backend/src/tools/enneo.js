// Enneo-Plattform-Connector (read-only) — spricht die Mind-API der Enneo-Instanzen,
// dieselbe API wie das offizielle Enneo Claude Code Plugin (https://{instanz}/api/mind).
// Auth: universeller Production-Token (ENNEO_TOKEN) — gilt instanz-übergreifend, nie im Repo.
// Instanz-Allowlist über ENNEO_INSTANCES (kommagetrennt, erste = Default).

const INSTANCES = (process.env.ENNEO_INSTANCES || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

function resolveInstance(input) {
  if (!input) return INSTANCES[0]
  const wanted = input.replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const match = INSTANCES.find((i) => i === wanted || i.split('.')[0] === wanted)
  if (!match) {
    throw new Error(
      `Instanz "${input}" ist nicht freigegeben. Verfügbar: ${INSTANCES.join(', ') || '(keine konfiguriert)'}`
    )
  }
  return match
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
      'Generischer read-only GET auf die Enneo Mind-API (/api/mind{path}). Für alles, wofür es kein eigenes Tool gibt — z.B. /customer/byTicketId/{id}, /aiAgent, /aiAgent/{id}, /intent/byTicketId/{id}, /ticket/{id}/activity, /settings/category/{cat}. Nur GET, keine Schreiboperationen.',
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
]

export async function runEnneoTool(name, input) {
  if (!process.env.ENNEO_TOKEN || !INSTANCES.length) {
    return 'Der Enneo-Connector ist noch nicht konfiguriert (ENNEO_TOKEN/ENNEO_INSTANCES fehlen). Sag dem Nutzer, dass der Connector erst eingerichtet werden muss.'
  }
  const instance = resolveInstance(input.instance)

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
