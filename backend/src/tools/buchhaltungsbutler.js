import { decryptSecret } from '../crypto.js'
import { connectorForUser } from '../connector-access.js'

// ============================================================ BuchhaltungsButler (nativ, read-only)
// Buchhaltung der enneo GmbH: Eingangs-/Ausgangsrechnungen, Buchungen, Kontoumsätze,
// Kreditoren/Debitoren. Klassische REST-API (kein MCP) — alle Endpoints sind POST.
// Auth laut offizieller Doku (app.buchhaltungsbutler.de/docs/api/v1/):
//   - HTTP Basic Auth mit '<Api Client>:<Api Secret>'
//   - api_key als Form-Feld in jedem Request (wählt den BB-Mandanten)
// Credentials liegen als verschlüsseltes JSON {api_client, api_secret, api_key} in
// connectors.token (kind='buchhaltungsbutler'). Bewusst NUR Lese-Tools — Enni liest
// Buchhaltungsdaten, schreibt und löscht aber nie.

const BASE = 'https://webapp.buchhaltungsbutler.de/api/v1'

async function bbCredentials(userId) {
  const raw = decryptSecret((await connectorForUser('buchhaltungsbutler', userId, { fresh: true }))?.token || null)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return parsed?.api_client && parsed?.api_secret && parsed?.api_key ? parsed : null
  } catch {
    return null
  }
}

export function invalidateBuchhaltungsbutlerCache() {}

// Alle BB-Endpoints sind POST mit application/x-www-form-urlencoded Body.
// Rate-Limit laut Doku: 100 Requests pro Mandant pro Minute.
async function bbFetch(creds, path, params = {}) {
  const body = new URLSearchParams({ api_key: creds.api_key })
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    body.set(key, String(value))
  }
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${creds.api_client}:${creds.api_secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`BuchhaltungsButler ${res.status}: ${text.slice(0, 400)}`)
  return text
}

// Verbindungstest beim Anlegen — liefert die Anzahl der Konten des Mandanten
export async function probeBuchhaltungsbutler(creds) {
  const raw = await bbFetch(creds, '/accounts/get')
  const parsed = JSON.parse(raw)
  if (parsed?.success !== true) throw new Error(parsed?.message || 'API meldet success=false')
  return `${parsed?.rows ?? 0} Konten sichtbar`
}

const TOOL_DEFS = [
  {
    name: 'bb_get_receipts',
    description:
      'Listet Belege (Rechnungen) aus BuchhaltungsButler. list_direction "inbound" = Eingangsrechnungen (Lieferanten), "outbound" = Ausgangsrechnungen (an Kunden). Filterbar nach Bezahlstatus, Gegenpartei, Rechnungsnummer und Belegdatum. Für "offene Rechnungen": payment_status="unpaid".',
    input_schema: {
      type: 'object',
      properties: {
        list_direction: { type: 'string', enum: ['inbound', 'outbound'], description: 'inbound = Eingangsbelege, outbound = Ausgangsbelege' },
        payment_status: { type: 'string', enum: ['paid', 'unpaid'], description: 'Optional: nur bezahlte oder unbezahlte Belege' },
        counterparty: { type: 'string', description: 'Optional: Gegenpartei (Rechnungssteller bei inbound, Empfänger bei outbound)' },
        invoicenumber: { type: 'string', description: 'Optional: exakte Rechnungsnummer' },
        date_from: { type: 'string', description: 'Optional: Belegdatum ab, Format YYYY-MM-DD' },
        date_to: { type: 'string', description: 'Optional: Belegdatum bis, Format YYYY-MM-DD' },
        limit: { type: 'number', description: 'Max. Treffer, Default 50, Maximum 500' },
        offset: { type: 'number', description: 'Offset fürs Blättern, Default 0' },
      },
      required: ['list_direction'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_receipt',
    description:
      'Liest einen einzelnen Beleg vollständig anhand seiner id_by_customer (aus bb_get_receipts). Liefert alle Metadaten inkl. Positionen — aber nicht die PDF-Datei selbst.',
    input_schema: {
      type: 'object',
      properties: {
        id_by_customer: { type: 'number', description: 'Die id_by_customer des Belegs' },
      },
      required: ['id_by_customer'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_postings',
    description:
      'Listet Buchungen (Journal) aus BuchhaltungsButler in einem Zeitraum. Filterbar nach Konto, Buchungskonto (Sachkonto/Kreditor/Debitor), Status und Kostenstelle. date_from und date_to sind Pflicht.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Buchungsdatum ab, Format YYYY-MM-DD (Pflicht)' },
        date_to: { type: 'string', description: 'Buchungsdatum bis, Format YYYY-MM-DD (Pflicht)' },
        account: { type: 'string', description: 'Optional: Komma-Liste von Konten, z. B. "all financial accounts" oder Kontonummern' },
        postingaccount: { type: 'string', description: 'Optional: Komma-Liste von Buchungskonten, z. B. "all debtors", "all creditors" oder Nummern' },
        posting_status: { type: 'string', enum: ['all', 'fixed', 'unfixed'], description: 'Optional: Buchungsstatus, Default all' },
        cost_location: { type: 'string', description: 'Optional: Kostenstellen-Code' },
        limit: { type: 'number', description: 'Max. Treffer, Default 100, Maximum 1000' },
        offset: { type: 'number', description: 'Offset fürs Blättern, Default 0' },
      },
      required: ['date_from', 'date_to'],
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_transactions',
    description:
      'Listet Banktransaktionen (Kontoumsätze) aus BuchhaltungsButler. Filterbar nach Zeitraum, Konto und Zahler/Empfänger. Für Liquiditäts- und Zahlungsfragen die primäre Quelle.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Optional: Buchungsdatum ab, Format YYYY-MM-DD' },
        date_to: { type: 'string', description: 'Optional: Buchungsdatum bis, Format YYYY-MM-DD' },
        account: { type: 'number', description: 'Optional: Kontonummer des Bankkontos (aus bb_get_accounts)' },
        to_from: { type: 'string', description: 'Optional: Zahler/Empfänger der Transaktion' },
        limit: { type: 'number', description: 'Max. Treffer, Default 50, Maximum 500' },
        offset: { type: 'number', description: 'Offset fürs Blättern, Default 0' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_accounts',
    description: 'Listet alle Konten des Mandanten (Bankkonten, Kasse) mit Kontonummern. Nützlich als erster Call, um Kontonummern für bb_get_transactions zu kennen.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bb_get_postingaccounts',
    description: 'Listet Buchungskonten (Sachkonten/SKR, optional inkl. Kreditoren/Debitoren) mit Nummer und Name.',
    input_schema: {
      type: 'object',
      properties: {
        exclude_creditors: { type: 'boolean', description: 'Optional: Kreditoren-Konten ausblenden' },
        exclude_debtors: { type: 'boolean', description: 'Optional: Debitoren-Konten ausblenden' },
        limit: { type: 'number', description: 'Max. Treffer, Default 1000' },
        offset: { type: 'number', description: 'Offset fürs Blättern, Default 0' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_creditors',
    description: 'Listet Kreditoren (Lieferanten-Stammdaten) mit Buchungskonto-Nummern.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max. Treffer, Default 25' },
        offset: { type: 'number', description: 'Offset fürs Blättern, Default 0' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_debtors',
    description: 'Listet Debitoren (Kunden-Stammdaten) mit Buchungskonto-Nummern.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max. Treffer, Default 25' },
        offset: { type: 'number', description: 'Offset fürs Blättern, Default 0' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bb_get_cost_locations',
    description: 'Listet Kostenstellen mit Codes. Codes sind als Filter in bb_get_postings nutzbar.',
    input_schema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Optional: nur diese eine Kostenstelle' },
        limit: { type: 'number', description: 'Max. Treffer, Default 1000' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'bb_raw_get',
    description:
      'Generischer LESE-Zugriff auf jeden Get-Endpoint der BuchhaltungsButler-API v1 (nur Pfade, die "get" enthalten — z. B. "/receipts/assigned-transactions/get"). params werden als Form-Felder mitgesendet. Nur für Fälle, die die anderen bb_-Tools nicht abdecken.',
    input_schema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'API-Pfad relativ zu /api/v1, muss mit / beginnen und "get" enthalten' },
        params: { type: 'object', description: 'Form-Parameter als Key-Value-Objekt (optional)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
]

// Tools nur anbieten, wenn ein BuchhaltungsButler-Connector über einen Space zugänglich ist
export async function buchhaltungsbutlerToolDefinitions(userId) {
  return (await connectorForUser('buchhaltungsbutler', userId)) ? TOOL_DEFS : []
}

const clip = (s) => (s.length > 40000 ? s.slice(0, 40000) + '\n\n[... gekürzt]' : s)

export async function runBuchhaltungsbutlerTool(name, input, ctx = {}) {
  const creds = await bbCredentials(ctx.userId)
  if (!creds) throw new Error('BuchhaltungsButler ist nicht über einen für dich zugänglichen Space aktiviert.')

  if (name === 'bb_get_receipts') {
    return clip(await bbFetch(creds, '/receipts/get', {
      list_direction: input.list_direction,
      payment_status: input.payment_status,
      counterparty: input.counterparty,
      invoicenumber: input.invoicenumber,
      date_from: input.date_from,
      date_to: input.date_to,
      limit: Math.min(input.limit || 50, 500),
      offset: input.offset || 0,
    }))
  }
  if (name === 'bb_get_receipt') {
    return clip(await bbFetch(creds, '/receipts/get/id_by_customer', { id_by_customer: input.id_by_customer }))
  }
  if (name === 'bb_get_postings') {
    return clip(await bbFetch(creds, '/postings/get', {
      date_from: input.date_from,
      date_to: input.date_to,
      account: input.account,
      postingaccount: input.postingaccount,
      posting_status: input.posting_status,
      cost_location: input.cost_location,
      limit: Math.min(input.limit || 100, 1000),
      offset: input.offset || 0,
    }))
  }
  if (name === 'bb_get_transactions') {
    return clip(await bbFetch(creds, '/transactions/get', {
      date_from: input.date_from,
      date_to: input.date_to,
      account: input.account,
      to_from: input.to_from,
      limit: Math.min(input.limit || 50, 500),
      offset: input.offset || 0,
    }))
  }
  if (name === 'bb_get_accounts') {
    return clip(await bbFetch(creds, '/accounts/get'))
  }
  if (name === 'bb_get_postingaccounts') {
    return clip(await bbFetch(creds, '/settings/get/postingaccounts', {
      exclude_creditors: input.exclude_creditors,
      exclude_debtors: input.exclude_debtors,
      limit: Math.min(input.limit || 1000, 1000),
      offset: input.offset || 0,
    }))
  }
  if (name === 'bb_get_creditors') {
    return clip(await bbFetch(creds, '/settings/get/creditors', {
      limit: Math.min(input.limit || 25, 200),
      offset: input.offset || 0,
    }))
  }
  if (name === 'bb_get_debtors') {
    return clip(await bbFetch(creds, '/settings/get/debtors', {
      limit: Math.min(input.limit || 25, 200),
      offset: input.offset || 0,
    }))
  }
  if (name === 'bb_get_cost_locations') {
    return clip(await bbFetch(creds, '/cost-locations/get', {
      code: input.code,
      limit: Math.min(input.limit || 1000, 1000),
    }))
  }
  if (name === 'bb_raw_get') {
    const path = String(input.path || '')
    // Lese-Schutz: die BB-API ist komplett POST — schreibende/löschende Endpoints
    // heißen add/update/delete/create/upload/assign/unconfirm/restore. Zugelassen
    // sind nur Pfade mit "get"-Segment, damit bleibt das Tool hart read-only.
    if (!path.startsWith('/')) throw new Error('path muss mit / beginnen')
    if (!/(^|\/)get(\/|$)|\/get$/.test(path)) throw new Error('Nur Lese-Endpoints erlaubt: der Pfad muss ein "get"-Segment enthalten (z. B. /postings/get).')
    return clip(await bbFetch(creds, path, input.params || {}))
  }
  throw new Error(`Unbekanntes BuchhaltungsButler-Tool: ${name}`)
}
