import { decryptSecret } from '../crypto.js'
import { connectorForUser } from '../connector-access.js'

// ============================================================ beehiiv (nativ, read-only)
// Newsletter-Plattform von enneo. Read-only-Zugriff auf Publications, Posts mit
// Engagement-Stats (Opens, Clicks, Unsubscribes) und Segmente — die Datenbasis für
// die Skills /beehiiv-engagement-pull und /monthly-newsletter-draft.
// Bewusst KEINE Subscriber-Listen-Tools: einzelne Abonnenten-E-Mails sind PII und
// für Engagement-Analysen unnötig (Publication-Stats liefern die Aggregatzahlen).
// Auth: Bearer-Key (beehiiv → Settings → Integrations → API). Doku: developers.beehiiv.com

const BASE = 'https://api.beehiiv.com/v2'

async function beehiivToken(userId) {
  return decryptSecret((await connectorForUser('beehiiv', userId, { fresh: true }))?.token || null)
}

export function invalidateBeehiivCache() {}

async function beehiivFetch(token, path, params = {}) {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) value.forEach((item) => qs.append(key, String(item)))
    else qs.set(key, String(value))
  }
  const res = await fetch(`${BASE}${path}${qs.size ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`beehiiv ${res.status}: ${text.slice(0, 400)}`)
  return text
}

// Verbindungstest beim Anlegen — listet die zugänglichen Publications
export async function probeBeehiiv(token) {
  const parsed = JSON.parse(await beehiivFetch(token, '/publications', { limit: 10 }))
  const names = (parsed?.data || []).map((p) => p.name).filter(Boolean)
  if (!names.length) throw new Error('Key gültig, aber keine Publication zugänglich.')
  return names.join(', ')
}

const TOOL_DEFS = [
  {
    name: 'beehiiv_publications',
    description:
      'Listet die beehiiv-Publications (Newsletter) mit ihren Aggregat-Statistiken (aktive Abonnenten, durchschnittliche Open-/Click-Rate). Liefert die publication_id (pub_…) für alle anderen beehiiv-Tools. Rufe das zuerst auf.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'beehiiv_posts',
    description:
      'Listet Posts (Newsletter-Ausgaben) einer Publication inkl. Engagement-Stats (Empfänger, Opens, Open-Rate, Clicks, Click-Rate, Unsubscribes, Web-Views). Für "wie lief der letzte Newsletter": order_by="publish_date", direction="desc". status "confirmed" = versendete/veröffentlichte Posts.',
    input_schema: {
      type: 'object',
      properties: {
        publication_id: { type: 'string', description: 'Die pub_… id aus beehiiv_publications' },
        status: { type: 'string', enum: ['draft', 'confirmed', 'archived', 'all'], description: 'Default all' },
        order_by: { type: 'string', enum: ['created', 'publish_date', 'displayed_date'], description: 'Default created' },
        direction: { type: 'string', enum: ['asc', 'desc'], description: 'Default asc — für neueste zuerst desc' },
        limit: { type: 'number', description: 'Max. Treffer, Default 10, Maximum 100' },
        page: { type: 'number', description: 'Seite fürs Blättern, Default 1' },
      },
      required: ['publication_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'beehiiv_post',
    description:
      'Liest einen einzelnen Post vollständig: Metadaten, Engagement-Stats und auf Wunsch den Inhalt (include_content=true lädt den Web-Text — nützlich als Stil-/Strukturreferenz für neue Newsletter-Entwürfe).',
    input_schema: {
      type: 'object',
      properties: {
        publication_id: { type: 'string', description: 'Die pub_… id' },
        post_id: { type: 'string', description: 'Die post_… id aus beehiiv_posts' },
        include_content: { type: 'boolean', description: 'true = Web-Inhalt des Posts mitliefern (kann lang sein)' },
      },
      required: ['publication_id', 'post_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'beehiiv_segments',
    description: 'Listet die Segmente einer Publication (Name, Typ, Anzahl der Abonnenten im Segment) — ohne einzelne Abonnenten-Daten.',
    input_schema: {
      type: 'object',
      properties: {
        publication_id: { type: 'string', description: 'Die pub_… id' },
        limit: { type: 'number', description: 'Max. Treffer, Default 10, Maximum 100' },
        page: { type: 'number', description: 'Seite fürs Blättern, Default 1' },
      },
      required: ['publication_id'],
      additionalProperties: false,
    },
  },
]

// Tools nur anbieten, wenn ein beehiiv-Connector über einen Space zugänglich ist
export async function beehiivToolDefinitions(userId) {
  return (await connectorForUser('beehiiv', userId)) ? TOOL_DEFS : []
}

const clip = (s) => (s.length > 40000 ? s.slice(0, 40000) + '\n\n[... gekürzt — mit limit/page blättern]' : s)

export async function runBeehiivTool(name, input, ctx = {}) {
  const token = await beehiivToken(ctx.userId)
  if (!token) throw new Error('beehiiv ist nicht über einen für dich zugänglichen Space aktiviert.')

  if (name === 'beehiiv_publications') {
    return clip(await beehiivFetch(token, '/publications', { limit: 50, 'expand[]': 'stats' }))
  }
  if (name === 'beehiiv_posts') {
    const pub = encodeURIComponent(input.publication_id)
    return clip(await beehiivFetch(token, `/publications/${pub}/posts`, {
      'expand[]': 'stats',
      status: input.status,
      order_by: input.order_by,
      direction: input.direction,
      limit: Math.min(input.limit || 10, 100),
      page: input.page || 1,
    }))
  }
  if (name === 'beehiiv_post') {
    const pub = encodeURIComponent(input.publication_id)
    const post = encodeURIComponent(input.post_id)
    const expand = input.include_content ? ['stats', 'free_web_content'] : ['stats']
    return clip(await beehiivFetch(token, `/publications/${pub}/posts/${post}`, { 'expand[]': expand }))
  }
  if (name === 'beehiiv_segments') {
    const pub = encodeURIComponent(input.publication_id)
    return clip(await beehiivFetch(token, `/publications/${pub}/segments`, {
      limit: Math.min(input.limit || 10, 100),
      page: input.page || 1,
    }))
  }
  throw new Error(`Unbekanntes beehiiv-Tool: ${name}`)
}
