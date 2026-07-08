// Selbst verknüpfte MCP-Server (Tabelle `connectors`): Tools werden live vom Server
// geladen und Enni unter dem Namespace `mcp__{slug}__{tool}` bereitgestellt.
// Transport: Streamable HTTP (offizielles MCP-SDK), optionaler Bearer-Token.

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { db } from '../db.js'

const CACHE_TTL_MS = 60_000
let cache = { at: 0, defs: [], routes: new Map() } // routes: namespacedName -> {url, token, realName}

const slugify = (name) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24) || 'mcp'

async function connect(url, token) {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
  })
  const client = new Client({ name: 'enneo-os', version: '1.0.0' })
  await client.connect(transport)
  return client
}

// Verbindungstest + Tool-Discovery — wird beim Anlegen eines Connectors aufgerufen
export async function probeMcpServer(url, token) {
  const client = await connect(url, token)
  try {
    const { tools } = await client.listTools()
    return tools.map((t) => ({ name: t.name, description: t.description || '' }))
  } finally {
    await client.close().catch(() => {})
  }
}

export async function addConnector({ name, url, token, category }, userId) {
  const tools = await probeMcpServer(url, token) // wirft bei unerreichbar/ungültig
  const { data, error } = await db
    .from('connectors')
    .insert({
      name: name.trim(),
      url: url.trim(),
      token: token?.trim() || null,
      category: category === 'connection' ? 'connection' : 'tool',
      tool_count: tools.length,
      created_by: userId,
    })
    .select('id, name, category, tool_count')
    .single()
  if (error) throw new Error(error.message)
  cache.at = 0
  return { ...data, tools: tools.map((t) => t.name) }
}

export async function removeConnector(id) {
  const { error } = await db.from('connectors').delete().eq('id', id)
  if (error) throw new Error(error.message)
  cache.at = 0
}

// Tool-Definitionen aller Connectors — gecacht, Fehler pro Server nicht-fatal
export async function mcpToolDefinitions() {
  if (Date.now() - cache.at < CACHE_TTL_MS) return cache.defs
  const { data: connectors } = await db.from('connectors').select('id, name, url, token')
  const defs = []
  const routes = new Map()
  for (const c of connectors || []) {
    try {
      const client = await connect(c.url, c.token)
      try {
        const { tools } = await client.listTools()
        const slug = slugify(c.name)
        for (const t of tools) {
          const nsName = `mcp__${slug}__${t.name}`.slice(0, 128).replace(/[^a-zA-Z0-9_-]/g, '_')
          if (routes.has(nsName)) continue
          routes.set(nsName, { url: c.url, token: c.token, realName: t.name })
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
  cache = { at: Date.now(), defs, routes }
  return defs
}

export async function runMcpTool(name, input) {
  if (Date.now() - cache.at >= CACHE_TTL_MS) await mcpToolDefinitions()
  const route = cache.routes.get(name)
  if (!route) throw new Error(`Unbekanntes MCP-Tool: ${name} (Connector entfernt?)`)
  const client = await connect(route.url, route.token)
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
