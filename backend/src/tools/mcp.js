// Selbst verknüpfte MCP-Server (Tabelle `connectors`): Tools werden live vom Server
// geladen und Enni unter dem Namespace `mcp__{slug}__{tool}` bereitgestellt.
// Transport: Streamable HTTP (offizielles MCP-SDK), optionaler Bearer-Token.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { db } from '../db.js'
import { decryptSecret, encryptSecret } from '../crypto.js'
import { canUseConnector, connectorsForUser, invalidateConnectorAccessCache, moveConnectorAssignments } from '../connector-access.js'
import { oauthProviderForConnector } from '../mcp-oauth.js'

const CACHE_TTL_MS = 5_000
// Per-User-Caches: jeder Nutzer sieht Team-Connectors + seine eigenen persoenlichen
const caches = new Map() // userId||'team' -> { at, defs, routes: namespacedName -> {url, token, realName} }

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'mcp'

export function mcpHeaders(token, authType = 'manual') {
  if (!token || authType === 'mcp_none') return undefined
  if (authType === 'mcp_x_api_key') return { 'X-API-Key': token }
  return { Authorization: `Bearer ${token}` }
}

async function connect(url, token, authType = 'manual', connector = null) {
  const transport = new StreamableHTTPClientTransport(new URL(url), authType === 'mcp_oauth'
    ? { authProvider: oauthProviderForConnector(connector) }
    : { requestInit: token ? { headers: mcpHeaders(token, authType) } : undefined })
  const client = new Client({ name: 'enneo-os', version: '1.0.0' })
  await client.connect(transport)
  return client
}

// Verbindungstest + Tool-Discovery — wird beim Anlegen eines Connectors aufgerufen
export async function probeMcpServer(url, token, authType = 'manual') {
  const client = await connect(url, token, authType)
  try {
    const { tools } = await client.listTools()
    return tools.map((t) => ({ name: t.name, description: t.description || '' }))
  } finally {
    await client.close().catch(() => {})
  }
}

export async function addConnector({ name, url, token, authType = 'manual', category, owner = null, visibility = 'team' }, userId) {
  const allowedAuthTypes = new Set(['manual', 'mcp_bearer', 'mcp_x_api_key', 'mcp_none'])
  if (!allowedAuthTypes.has(authType)) throw new Error('Nicht unterstützte MCP-Authentifizierung')
  if (['mcp_bearer', 'mcp_x_api_key'].includes(authType) && !token?.trim()) throw new Error('Für diese Authentifizierung ist ein Token erforderlich')
  const normalizedUrl = url.trim()
  const tools = await probeMcpServer(normalizedUrl, token, authType) // wirft bei unerreichbar/ungültig
  let previousQuery = db.from('connectors').select('id').eq('kind', 'mcp').eq('url', normalizedUrl)
  previousQuery = visibility === 'team'
    ? previousQuery.eq('visibility', 'team')
    : previousQuery.eq('owner', owner || userId).neq('visibility', 'team')
  const { data: previous } = await previousQuery
  const { data, error } = await db
    .from('connectors')
    .insert({
      name: name.trim(),
      url: normalizedUrl,
      token: token?.trim() ? encryptSecret(token.trim()) : null,
      auth_type: authType,
      category: category === 'connection' ? 'connection' : 'tool',
      tool_count: tools.length,
      created_by: userId,
      owner,
      visibility,
    })
    .select('id, name, category, tool_count')
    .single()
  if (error) throw new Error(error.message)
  const previousIds = (previous || []).map((row) => row.id).filter((id) => id !== data.id)
  await moveConnectorAssignments(previousIds, data.id)
  if (previousIds.length) {
    const { error: deleteError } = await db.from('connectors').delete().in('id', previousIds)
    if (deleteError) throw new Error(deleteError.message)
  }
  invalidateConnectorAccessCache()
  caches.clear()
  return { ...data, tools: tools.map((t) => t.name) }
}

export async function removeConnector(id) {
  await db.from('space_connections').delete().eq('connection_key', `connector:${id}`)
  const { error } = await db.from('connectors').delete().eq('id', id)
  if (error) throw new Error(error.message)
  invalidateConnectorAccessCache()
  caches.clear()
}

export function invalidateMcpCache() {
  caches.clear()
}

// Tool-Definitionen aller Connectors — gecacht, Fehler pro Server nicht-fatal
export async function mcpToolDefinitions(userId) {
  const key = userId || 'team'
  const cached = caches.get(key)
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.defs
  const visible = await connectorsForUser(userId, 'mcp')
  const defs = []
  const routes = new Map()
  for (const c of visible) {
    try {
      const token = decryptSecret(c.token)
      const client = await connect(c.url, token, c.auth_type, c)
      try {
        const { tools } = await client.listTools()
        const slug = slugify(c.name)
        for (const t of tools) {
          const nsName = `mcp__${slug}__${t.name}`.slice(0, 128).replace(/[^a-zA-Z0-9_-]/g, '_')
          if (routes.has(nsName)) continue
          routes.set(nsName, { connectorId: c.id, connector: c, url: c.url, token, authType: c.auth_type, realName: t.name })
          defs.push({
            name: nsName,
            description: `[${c.name}] ${t.description || t.name}`.slice(0, 1000),
            input_schema: t.inputSchema || { type: 'object', properties: {} },
          })
        }
      } finally {
        await client.close().catch(() => {})
      }
    } catch (err) {
      console.error(`MCP-Connector "${c.name}" nicht erreichbar:`, err.message)
    }
  }
  caches.set(key, { at: Date.now(), defs, routes })
  return defs
}

export async function runMcpTool(name, input, ctx = {}) {
  const key = ctx.userId || 'team'
  if (!caches.get(key) || Date.now() - caches.get(key).at >= CACHE_TTL_MS) await mcpToolDefinitions(ctx.userId)
  const route = caches.get(key)?.routes.get(name)
  if (!route) throw new Error(`Unbekanntes MCP-Tool: ${name} (Connector entfernt?)`)
  if (!(await canUseConnector(route.connectorId, ctx.userId))) {
    caches.delete(key)
    throw new Error('Diese Connection ist in keinem für dich zugänglichen Space aktiviert.')
  }
  const client = await connect(route.url, route.token, route.authType, route.connector)
  try {
    const result = await client.callTool({ name: route.realName, arguments: input || {} })
    const text = (result.content || [])
      .map((b) => (b.type === 'text' ? b.text : `[${b.type}]`))
      .join('\n')
    if (result.isError) throw new Error(text.slice(0, 500) || 'MCP-Tool-Fehler')
    return text.length > 40000 ? text.slice(0, 40000) + '\n\n[... gekürzt]' : text
  } finally {
    await client.close().catch(() => {})
  }
}
