import { decryptSecret } from '../crypto.js'
import { connectorForUser, connectorsForUser } from '../connector-access.js'

const PROVIDERS = ['outlook', 'google_drive', 'notion']
export function invalidateProductivityCache() {}

async function accessToken(provider, userId) {
  const connector = await connectorForUser(provider, userId, { fresh: true })
  if (!connector) return null
  const expiresSoon = connector.token_expires_at && new Date(connector.token_expires_at).getTime() < Date.now() + 90_000
  if (expiresSoon && connector.refresh_token) {
    const { refreshProviderToken } = await import('../provider-oauth.js')
    const token = await refreshProviderToken(provider, connector)
    return token
  }
  return decryptSecret(connector.token)
}

async function api(provider, userId, url, options = {}) {
  const token = await accessToken(provider, userId)
  if (!token) throw new Error(`${provider} ist nicht verbunden`)
  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      ...(provider === 'notion' ? { 'Notion-Version': '2026-03-11' } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${provider} ${response.status}: ${text.slice(0, 350)}`)
  return text
}

const OUTLOOK_TOOLS = [
  { name: 'outlook_list_messages', description: 'Listet die neuesten Outlook-E-Mails mit Absender, Betreff, Datum und Message-ID.', input_schema: { type: 'object', properties: { limit: { type: 'number' }, folder: { type: 'string', description: 'Ordner-ID oder well-known name, Default inbox' } }, additionalProperties: false } },
  { name: 'outlook_search_messages', description: 'Sucht Outlook-E-Mails nach Wörtern in Betreff, Absender oder Inhalt.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } },
  { name: 'outlook_read_message', description: 'Liest eine Outlook-E-Mail vollständig anhand ihrer Message-ID.', input_schema: { type: 'object', properties: { message_id: { type: 'string' } }, required: ['message_id'], additionalProperties: false } },
  { name: 'outlook_list_calendar', description: 'Listet Outlook-Kalendertermine in einem Zeitraum.', input_schema: { type: 'object', properties: { days_ahead: { type: 'number' }, days_back: { type: 'number' }, limit: { type: 'number' } }, additionalProperties: false } },
]

const DRIVE_TOOLS = [
  { name: 'google_drive_search', description: 'Sucht Dateien und Ordner in Google Drive. Liefert Datei-ID, Typ, Link und Änderungszeit.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } },
  { name: 'google_drive_list_recent', description: 'Listet die zuletzt geänderten Dateien in Google Drive.', input_schema: { type: 'object', properties: { limit: { type: 'number' } }, additionalProperties: false } },
  { name: 'google_drive_read_file', description: 'Liest den Textinhalt einer Google-Drive-Datei. Google Docs werden als Text exportiert; textbasierte Dateien direkt gelesen.', input_schema: { type: 'object', properties: { file_id: { type: 'string' }, mime_type: { type: 'string' } }, required: ['file_id', 'mime_type'], additionalProperties: false } },
]

const NOTION_TOOLS = [
  { name: 'notion_search', description: 'Sucht in den Seiten und Datenbanken, die der Notion-Verbindung freigegeben wurden.', input_schema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false } },
  { name: 'notion_read_page', description: 'Liest eine Notion-Seite samt ihrer Block-Inhalte.', input_schema: { type: 'object', properties: { page_id: { type: 'string' } }, required: ['page_id'], additionalProperties: false } },
  { name: 'notion_query_database', description: 'Liest die neuesten Einträge einer Notion-Datenbank/Data Source.', input_schema: { type: 'object', properties: { data_source_id: { type: 'string' }, limit: { type: 'number' } }, required: ['data_source_id'], additionalProperties: false } },
]

const DEFINITIONS = { outlook: OUTLOOK_TOOLS, google_drive: DRIVE_TOOLS, notion: NOTION_TOOLS }

export async function productivityToolDefinitions(userId) {
  const connected = new Set((await connectorsForUser(userId)).map((row) => row.kind))
  return PROVIDERS.flatMap((provider) => connected.has(provider) ? DEFINITIONS[provider] : [])
}

const clip = (value) => value.length > 40_000 ? `${value.slice(0, 40_000)}\n[… gekürzt]` : value

export async function runProductivityTool(name, input, ctx = {}) {
  const userId = ctx.userId
  if (name === 'outlook_list_messages') {
    const limit = Math.min(input.limit || 20, 50)
    const folder = encodeURIComponent(input.folder || 'inbox')
    return clip(await api('outlook', userId, `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${limit}&$orderby=receivedDateTime%20desc&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,webLink`))
  }
  if (name === 'outlook_search_messages') {
    const params = new URLSearchParams({ '$search': `\"${String(input.query).replace(/\"/g, '')}\"`, '$top': String(Math.min(input.limit || 20, 50)), '$select': 'id,subject,from,receivedDateTime,bodyPreview,isRead,webLink' })
    return clip(await api('outlook', userId, `https://graph.microsoft.com/v1.0/me/messages?${params}`, { headers: { ConsistencyLevel: 'eventual' } }))
  }
  if (name === 'outlook_read_message') return clip(await api('outlook', userId, `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(input.message_id)}?$select=id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink&$expand=attachments($select=id,name,contentType,size,isInline)`))
  if (name === 'outlook_list_calendar') {
    const start = new Date(Date.now() - (input.days_back || 0) * 86400000).toISOString()
    const end = new Date(Date.now() + (input.days_ahead || 14) * 86400000).toISOString()
    const params = new URLSearchParams({ startDateTime: start, endDateTime: end, '$top': String(Math.min(input.limit || 50, 100)), '$orderby': 'start/dateTime', '$select': 'id,subject,start,end,organizer,attendees,location,webLink,isOnlineMeeting' })
    return clip(await api('outlook', userId, `https://graph.microsoft.com/v1.0/me/calendarView?${params}`))
  }
  if (name === 'google_drive_search' || name === 'google_drive_list_recent') {
    const params = new URLSearchParams({ pageSize: String(Math.min(input.limit || 30, 100)), orderBy: 'modifiedTime desc', fields: 'files(id,name,mimeType,modifiedTime,owners(displayName,emailAddress),webViewLink,size)' })
    if (name === 'google_drive_search') params.set('q', `name contains '${String(input.query).replace(/'/g, "\\'")}' and trashed = false`)
    else params.set('q', 'trashed = false')
    return clip(await api('google_drive', userId, `https://www.googleapis.com/drive/v3/files?${params}`))
  }
  if (name === 'google_drive_read_file') {
    const id = encodeURIComponent(input.file_id)
    const googleType = String(input.mime_type).startsWith('application/vnd.google-apps.')
    const url = googleType
      ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=text%2Fplain`
      : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`
    return clip(await api('google_drive', userId, url, { headers: { Accept: 'text/plain' } }))
  }
  if (name === 'notion_search') return clip(await api('notion', userId, 'https://api.notion.com/v1/search', { method: 'POST', body: JSON.stringify({ query: input.query, page_size: Math.min(input.limit || 20, 100), sort: { direction: 'descending', timestamp: 'last_edited_time' } }) }))
  if (name === 'notion_read_page') {
    const id = encodeURIComponent(input.page_id)
    const [page, blocks] = await Promise.all([
      api('notion', userId, `https://api.notion.com/v1/pages/${id}`),
      api('notion', userId, `https://api.notion.com/v1/blocks/${id}/children?page_size=100`),
    ])
    return clip(`${page}\n\nBLOCKS\n${blocks}`)
  }
  if (name === 'notion_query_database') return clip(await api('notion', userId, `https://api.notion.com/v1/data_sources/${encodeURIComponent(input.data_source_id)}/query`, { method: 'POST', body: JSON.stringify({ page_size: Math.min(input.limit || 25, 100) }) }))
  throw new Error(`Unbekanntes Produktivitäts-Tool: ${name}`)
}
