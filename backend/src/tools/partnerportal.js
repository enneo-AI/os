import { decryptSecret } from '../crypto.js'
import { connectorForUser } from '../connector-access.js'

// ============================================================ enneo Partnerportal (nativ, read-only)
// Interne Read-only-API des Partnerportals (partner.enneo.ai/api/public/v1).
// Die API selbst ist hart lesend (enneo_ro_-Keys, keine Schreibendpoints) —
// lesbar sind Kunden, Partner, Deals, Angebote/Verträge (inkl. Preis-/TCV-Zerlegung),
// Benutzer, Instanzen, Lead-Freigaben sowie die komplette Abrechnung (Rechnungen,
// Gutschriften, Zahlungen, Provisionen, Abrechnungspläne). Auth: Bearer-Key.
// Inhalte sind enneo-intern und vertraulich — Reichweite steuert die Space-Zuordnung.

const BASE = 'https://partner.enneo.ai/api/public/v1'

// Listen-Ressourcen laut GET /meta (Stand 2026-08-19). commission-summary und
// deal-stages sind Aggregat-/Katalog-Endpoints ohne {id}-Detailseite.
const LIST_RESOURCES = [
  'customers', 'partners', 'deals', 'deal-stages', 'contracts', 'users', 'instances',
  'customer-claims', 'invoices', 'gutschriften', 'payments', 'refunds',
  'commission-events', 'commission-summary', 'billing-schedules', 'usage-events',
]
// Detail-Ressourcen mit Unterseiten: notes/activity je nach Ressource
const DETAIL_RESOURCES = {
  customers: ['notes', 'activity'],
  partners: [],
  deals: ['notes', 'activity'],
  contracts: ['activity'],
  users: [],
  'billing-schedules': [],
}

async function portalToken(userId) {
  return decryptSecret((await connectorForUser('partnerportal', userId, { fresh: true }))?.token || null)
}

export function invalidatePartnerportalCache() {}

async function portalFetch(token, path, params = {}) {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    qs.set(key, String(value))
  }
  const res = await fetch(`${BASE}${path}${qs.size ? `?${qs}` : ''}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Partnerportal ${res.status}: ${text.slice(0, 400)}`)
  return text
}

// Verbindungstest beim Anlegen — /meta bestätigt API und Read-only-Zugriff
export async function probePartnerportal(token) {
  const meta = JSON.parse(await portalFetch(token, '/meta'))
  if (meta?.api !== 'enneo-partner-portal') throw new Error('Unerwartete API-Antwort — ist das ein Partnerportal-Key?')
  return `${meta.access || 'read-only'} · ${(meta.resources || []).length} Ressourcen`
}

const TOOL_DEFS = [
  {
    name: 'pp_list',
    description:
      'Listet eine Ressource aus dem enneo-Partnerportal (read-only). Ressourcen: customers (Kunden), partners, deals, deal-stages, contracts (Angebote/Verträge inkl. Preis-/TCV-Zerlegung), users, instances, customer-claims (Lead-Freigaben), invoices (Rechnungen), gutschriften, payments (Zahlungseingänge), refunds, commission-events (Provisionen), commission-summary, billing-schedules (Abrechnungspläne), usage-events. params werden als Query-Parameter durchgereicht (z. B. limit, offset).',
    input_schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: LIST_RESOURCES, description: 'Die Ressource, z. B. "deals" oder "invoices"' },
        params: { type: 'object', description: 'Optionale Query-Parameter, z. B. {"limit": 25, "offset": 0}' },
      },
      required: ['resource'],
      additionalProperties: false,
    },
  },
  {
    name: 'pp_get',
    description:
      'Liest einen einzelnen Datensatz aus dem Partnerportal anhand seiner id — optional eine Unterseite: notes (Notizen) oder activity (Aktivitätslog). Unterseiten gibt es bei customers (notes+activity), deals (notes+activity) und contracts (nur activity).',
    input_schema: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: Object.keys(DETAIL_RESOURCES), description: 'Die Ressource, z. B. "deals"' },
        id: { type: 'number', description: 'Die id aus pp_list' },
        sub: { type: 'string', enum: ['notes', 'activity'], description: 'Optional: Unterseite statt des Datensatzes selbst' },
      },
      required: ['resource', 'id'],
      additionalProperties: false,
    },
  },
]

// Tools nur anbieten, wenn ein Partnerportal-Connector über einen Space zugänglich ist
export async function partnerportalToolDefinitions(userId) {
  return (await connectorForUser('partnerportal', userId)) ? TOOL_DEFS : []
}

const clip = (s) => (s.length > 40000 ? s.slice(0, 40000) + '\n\n[... gekürzt — mit limit/offset blättern]' : s)

export async function runPartnerportalTool(name, input, ctx = {}) {
  const token = await portalToken(ctx.userId)
  if (!token) throw new Error('Das Partnerportal ist nicht über einen für dich zugänglichen Space aktiviert.')

  if (name === 'pp_list') {
    if (!LIST_RESOURCES.includes(input.resource)) throw new Error(`Unbekannte Ressource: ${input.resource}`)
    return clip(await portalFetch(token, `/${input.resource}`, input.params || {}))
  }
  if (name === 'pp_get') {
    const subs = DETAIL_RESOURCES[input.resource]
    if (!subs) throw new Error(`Unbekannte Detail-Ressource: ${input.resource}`)
    const id = encodeURIComponent(String(input.id))
    if (input.sub) {
      if (!subs.includes(input.sub)) throw new Error(`"${input.resource}" hat keine Unterseite "${input.sub}" (verfügbar: ${subs.join(', ') || 'keine'}).`)
      return clip(await portalFetch(token, `/${input.resource}/${id}/${input.sub}`))
    }
    return clip(await portalFetch(token, `/${input.resource}/${id}`))
  }
  throw new Error(`Unbekanntes Partnerportal-Tool: ${name}`)
}
