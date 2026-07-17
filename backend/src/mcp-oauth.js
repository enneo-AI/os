import crypto from 'node:crypto'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { UnauthorizedError, auth } from '@modelcontextprotocol/sdk/client/auth.js'
import { db } from './db.js'
import { decryptSecret, encryptSecret } from './crypto.js'
import { invalidateConnectorAccessCache, moveConnectorAssignments } from './connector-access.js'

const frontendOrigin = () => (process.env.FRONTEND_ORIGIN || process.env.SITE_URL || 'https://os.enneo.ai').split(',')[0]
const backendOrigin = () => process.env.BACKEND_ORIGIN || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'enneo-os-backend-production.up.railway.app'}`
const stateHash = (state) => crypto.createHash('sha256').update(state).digest('hex')

export const MCP_OAUTH_SERVERS = {
  lemlist: {
    label: 'Lemlist',
    url: 'https://app.lemlist.com/mcp',
    category: 'tool',
  },
  ticktick: {
    label: 'TickTick',
    url: 'https://mcp.ticktick.com',
    category: 'tool',
  },
}

export const mcpOAuthRedirectUri = (provider) => `${backendOrigin()}/api/mcp/oauth/${provider}/callback`

function parseEncryptedJson(value) {
  const raw = decryptSecret(value)
  if (!raw) return undefined
  return JSON.parse(raw)
}

function tokenExpiry(tokens) {
  return tokens?.expires_in
    ? new Date(Date.now() + Number(tokens.expires_in) * 1000).toISOString()
    : null
}

class PersistentMcpOAuthProvider {
  constructor({ state, session = null, connector = null }) {
    this._state = state
    this._session = session
    this._connector = connector
    this._provider = session?.provider || connector?.oauth_provider || Object.entries(MCP_OAUTH_SERVERS)
      .find(([, meta]) => meta.url.replace(/\/$/, '') === connector?.url?.replace(/\/$/, ''))?.[0]
    this._authorizationUrl = null
    this._codeVerifier = session?.code_verifier ? decryptSecret(session.code_verifier) : null
    this._clientInformation = parseEncryptedJson(session?.client_information || connector?.oauth_client_information)
    this._tokens = connector ? {
      access_token: decryptSecret(connector.token),
      refresh_token: decryptSecret(connector.refresh_token),
      token_type: 'Bearer',
    } : undefined
  }

  get redirectUrl() {
    if (!this._provider) throw new Error('OAuth-MCP-Anbieter konnte nicht bestimmt werden')
    return mcpOAuthRedirectUri(this._provider)
  }

  get clientMetadata() {
    return {
      client_name: 'enneo OS',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  state() { return this._state }
  clientInformation() { return this._clientInformation }
  tokens() { return this._tokens }
  codeVerifier() {
    if (!this._codeVerifier) throw new Error('PKCE-Verifier fehlt')
    return this._codeVerifier
  }

  async saveClientInformation(clientInformation) {
    this._clientInformation = clientInformation
    const encrypted = encryptSecret(JSON.stringify(clientInformation))
    if (this._session) {
      const { error } = await db.from('mcp_oauth_sessions').update({ client_information: encrypted }).eq('state_hash', this._session.state_hash)
      if (error) throw new Error(error.message)
      this._session.client_information = encrypted
    } else if (this._connector) {
      const { error } = await db.from('connectors').update({ oauth_client_information: encrypted }).eq('id', this._connector.id)
      if (error) throw new Error(error.message)
      this._connector.oauth_client_information = encrypted
    }
  }

  async saveTokens(tokens) {
    this._tokens = {
      ...tokens,
      refresh_token: tokens.refresh_token || this._tokens?.refresh_token,
    }
    if (!this._connector) return
    const { error } = await db.from('connectors').update({
      token: encryptSecret(this._tokens.access_token),
      refresh_token: encryptSecret(this._tokens.refresh_token),
      token_expires_at: tokenExpiry(tokens) || this._connector.token_expires_at,
    }).eq('id', this._connector.id)
    if (error) throw new Error(error.message)
    this._connector.token = encryptSecret(this._tokens.access_token)
    this._connector.refresh_token = encryptSecret(this._tokens.refresh_token)
  }

  redirectToAuthorization(authorizationUrl) {
    this._authorizationUrl = authorizationUrl.toString()
  }

  async saveCodeVerifier(codeVerifier) {
    this._codeVerifier = codeVerifier
    if (!this._session) return
    const encrypted = encryptSecret(codeVerifier)
    const { error } = await db.from('mcp_oauth_sessions').update({ code_verifier: encrypted }).eq('state_hash', this._session.state_hash)
    if (error) throw new Error(error.message)
    this._session.code_verifier = encrypted
  }

  get authorizationUrl() { return this._authorizationUrl }
  get currentTokens() { return this._tokens }
  get currentClientInformation() { return this._clientInformation }
}

async function listToolsWithProvider(serverUrl, provider) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: provider })
  const client = new Client({ name: 'enneo-os', version: '1.0.0' })
  await client.connect(transport)
  try {
    const { tools } = await client.listTools()
    return tools.map((tool) => ({ name: tool.name, description: tool.description || '' }))
  } finally {
    await client.close().catch(() => {})
  }
}

function resultUrl(provider, status, params = {}) {
  const url = new URL('/spaces/marketplace', frontendOrigin())
  url.searchParams.set('oauth', provider)
  url.searchParams.set('status', status)
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, String(value))
  return url.toString()
}

export async function createMcpOAuthUrl({ provider, userId, server = null, cleanup = false }) {
  const meta = server || MCP_OAUTH_SERVERS[provider]
  if (!meta) throw new Error('OAuth-MCP nicht unterstützt')
  if (!/^https:\/\//.test(meta.url || '')) throw new Error('OAuth-MCP benötigt eine öffentliche HTTPS-URL')
  await db.from('mcp_oauth_sessions').delete().lt('expires_at', new Date().toISOString())
  const state = crypto.randomBytes(32).toString('base64url')
  const session = {
    state_hash: stateHash(state), user_id: userId, provider,
    connector_name: meta.label, server_url: meta.url, category: meta.category,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  }
  const { error } = await db.from('mcp_oauth_sessions').insert(session)
  if (error) throw new Error(error.message)
  const oauthProvider = new PersistentMcpOAuthProvider({ state, session })
  const transport = new StreamableHTTPClientTransport(new URL(meta.url), { authProvider: oauthProvider })
  const client = new Client({ name: 'enneo-os', version: '1.0.0' })
  let authorizationUrl = null
  try {
    await client.connect(transport)
    throw new Error(`${meta.label} hat keinen OAuth-Login angefordert`)
  } catch (err) {
    if (!(err instanceof UnauthorizedError) || !oauthProvider.authorizationUrl) {
      await db.from('mcp_oauth_sessions').delete().eq('state_hash', session.state_hash)
      throw err
    }
    authorizationUrl = oauthProvider.authorizationUrl
  } finally {
    await client.close().catch(() => {})
  }
  if (cleanup) await db.from('mcp_oauth_sessions').delete().eq('state_hash', session.state_hash)
  return authorizationUrl
}

async function loadOAuthSession(state) {
  if (!state) throw new Error('OAuth-State fehlt')
  const hash = stateHash(state)
  const { data, error } = await db.from('mcp_oauth_sessions').select('*').eq('state_hash', hash).maybeSingle()
  if (error || !data) throw new Error('OAuth-State ist ungültig oder wurde bereits verwendet')
  if (new Date(data.expires_at) <= new Date()) throw new Error('OAuth-State ist abgelaufen')
  return data
}

export async function completeMcpOAuth({ provider, code, state, deniedError }) {
  const session = await loadOAuthSession(state)
  try {
    if (session.provider !== provider) throw new Error('OAuth-Anbieter stimmt nicht mit dem State überein')
    if (deniedError) return resultUrl(session.provider, 'error', { workspace: session.connector_name, reason: deniedError === 'access_denied' ? 'cancelled' : 'provider_error' })
    if (!code) return resultUrl(session.provider, 'error', { workspace: session.connector_name, reason: 'missing_code' })
    const oauthProvider = new PersistentMcpOAuthProvider({ state, session })
    const authResult = await auth(oauthProvider, { serverUrl: session.server_url, authorizationCode: code })
    if (authResult !== 'AUTHORIZED' || !oauthProvider.currentTokens?.access_token) throw new Error('OAuth-Token konnte nicht übernommen werden')
    const tools = await listToolsWithProvider(session.server_url, oauthProvider)
    const previousQuery = db.from('connectors').select('id')
      .eq('kind', 'mcp').eq('url', session.server_url)
      .eq('owner', session.user_id).neq('visibility', 'team')
    const { data: previous } = await previousQuery
    const tokens = oauthProvider.currentTokens
    const { data: connector, error } = await db.from('connectors').insert({
      name: session.connector_name,
      url: session.server_url,
      token: encryptSecret(tokens.access_token),
      refresh_token: encryptSecret(tokens.refresh_token),
      token_expires_at: tokenExpiry(tokens),
      oauth_client_information: encryptSecret(JSON.stringify(oauthProvider.currentClientInformation)),
      oauth_provider: session.provider,
      auth_type: 'mcp_oauth', category: session.category, kind: 'mcp',
      tool_count: tools.length, created_by: session.user_id, owner: session.user_id,
      visibility: 'personal', scopes: String(tokens.scope || '').split(' ').filter(Boolean),
      external_account_name: `${session.connector_name}-Account`,
    }).select('id').single()
    if (error) throw new Error(error.message)
    const previousIds = (previous || []).map((row) => row.id).filter((id) => id !== connector.id)
    await moveConnectorAssignments(previousIds, connector.id)
    if (previousIds.length) {
      const { error: deleteError } = await db.from('connectors').delete().in('id', previousIds)
      if (deleteError) throw new Error(deleteError.message)
    }
    invalidateConnectorAccessCache()
    return resultUrl(session.provider, 'connected', { workspace: session.connector_name })
  } finally {
    await db.from('mcp_oauth_sessions').delete().eq('state_hash', session.state_hash)
  }
}

export function mcpOAuthErrorUrl(provider = 'lemlist', reason = 'unknown') {
  return resultUrl(provider, 'error', { reason })
}

export function oauthProviderForConnector(connector) {
  return new PersistentMcpOAuthProvider({ state: null, connector })
}
