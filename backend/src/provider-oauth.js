import crypto from 'node:crypto'
import { db } from './db.js'
import { encryptSecret, decryptSecret } from './crypto.js'
import { probeSlack, invalidateSlackCache } from './tools/slack.js'
import { probeAttio, invalidateAttioCache } from './tools/attio.js'
import { invalidateProductivityCache } from './tools/productivity.js'

const frontendOrigin = () => (process.env.FRONTEND_ORIGIN || process.env.SITE_URL || 'https://os.enneo.ai').split(',')[0]
const backendOrigin = () => process.env.BACKEND_ORIGIN || `https://${process.env.RAILWAY_PUBLIC_DOMAIN || 'enneo-os-backend-production.up.railway.app'}`
const stateHash = (state) => crypto.createHash('sha256').update(state).digest('hex')

export const OAUTH_PROVIDERS = {
  outlook: {
    label: 'Outlook', icon: 'outlook.svg', category: 'Produktivität',
    description: 'E-Mails, Postfächer und Kalender · read-only', toolCount: 4,
    setupUrl: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade',
    setupHint: 'Microsoft Entra → App registrations → New registration → Web Redirect URI eintragen.',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'],
  },
  google_drive: {
    label: 'Google Drive', icon: 'google-drive.svg', category: 'Produktivität',
    description: 'Dokumente und Ordner · read-only', toolCount: 3,
    setupUrl: 'https://console.cloud.google.com/apis/credentials',
    setupHint: 'Google Cloud → OAuth consent screen + Web application → Redirect URI eintragen.',
    scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.readonly'],
  },
  notion: {
    label: 'Notion', icon: 'notion.svg', category: 'Wissen',
    description: 'Freigegebene Seiten und Datenbanken · read-only', toolCount: 3,
    setupUrl: 'https://www.notion.so/profile/integrations',
    setupHint: 'Notion → Develop or manage integrations → Public integration → Redirect URI eintragen.',
    scopes: [],
  },
  attio: {
    label: 'Attio', icon: 'attio.ico', category: 'CRM',
    description: 'Accounts, Kontakte, Deals und Notizen · read-only', toolCount: 7,
    setupUrl: 'https://build.attio.com/',
    setupHint: 'Attio Developer Dashboard → OAuth aktivieren → Redirect URI und Read-Scopes eintragen.',
    scopes: [],
  },
  slack: {
    label: 'Slack', icon: 'slack.svg', category: 'Kommunikation',
    description: 'Channels und Threads · read-only', toolCount: 3,
    setupUrl: 'https://api.slack.com/apps',
    setupHint: 'Slack API → Create App → OAuth & Permissions → Redirect URI und Bot Scopes eintragen.',
    scopes: ['channels:read', 'channels:history', 'channels:join', 'groups:read', 'groups:history', 'users:read'],
  },
}

export const providerRedirectUri = (provider) => `${backendOrigin()}/api/oauth/${provider}/callback`

export async function providerStatus() {
  const { data } = await db.from('oauth_provider_configs').select('provider, client_id, tenant_id, enabled, configured_at')
  const configured = new Map((data || []).map((row) => [row.provider, row]))
  return Object.entries(OAUTH_PROVIDERS).map(([provider, meta]) => {
    const row = configured.get(provider)
    const environmentFallback = provider === 'slack' && process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET
    return {
      provider, ...meta, scopes: meta.scopes,
      configured: !!row?.enabled || !!environmentFallback,
      clientIdHint: row?.client_id ? `${row.client_id.slice(0, 5)}…${row.client_id.slice(-4)}` : environmentFallback ? 'Railway-Konfiguration' : null,
      tenantId: row?.tenant_id || null,
      configuredAt: row?.configured_at || null,
      redirectUri: providerRedirectUri(provider),
    }
  })
}

export async function saveProviderConfig(provider, input, actorId) {
  if (!OAUTH_PROVIDERS[provider]) throw new Error('Unbekannter OAuth-Anbieter')
  const clientId = String(input.client_id || '').trim()
  const clientSecret = String(input.client_secret || '').trim()
  if (!clientId || !clientSecret) throw new Error('Client-ID und Client-Secret sind Pflicht')
  const { error } = await db.from('oauth_provider_configs').upsert({
    provider,
    client_id: clientId,
    client_secret: encryptSecret(clientSecret),
    tenant_id: provider === 'outlook' ? String(input.tenant_id || 'organizations').trim() : null,
    enabled: true,
    configured_by: actorId,
  }, { onConflict: 'provider' })
  if (error) throw new Error(error.message)
  return (await providerStatus()).find((row) => row.provider === provider)
}

export async function getProviderConfig(provider) {
  const { data } = await db.from('oauth_provider_configs').select('*').eq('provider', provider).eq('enabled', true).maybeSingle()
  if (data) return { ...data, client_secret: decryptSecret(data.client_secret) }
  // Übergang: bestehende Slack-Railway-Konfiguration funktioniert weiterhin und
  // kann später bequem über die Admin-UI in die Datenbank übernommen werden.
  if (provider === 'slack' && process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET) {
    return { provider, client_id: process.env.SLACK_CLIENT_ID, client_secret: process.env.SLACK_CLIENT_SECRET }
  }
  throw Object.assign(new Error(`${OAUTH_PROVIDERS[provider]?.label || provider} muss einmalig von einem Admin eingerichtet werden.`), { code: 'provider_not_configured' })
}

function authorizationConfig(provider, config, state) {
  const redirectUri = providerRedirectUri(provider)
  const meta = OAUTH_PROVIDERS[provider]
  if (provider === 'outlook') {
    const tenant = config.tenant_id || 'organizations'
    return { url: `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/authorize`, params: {
      client_id: config.client_id, response_type: 'code', response_mode: 'query', redirect_uri: redirectUri,
      scope: meta.scopes.join(' '), state, prompt: 'select_account',
    } }
  }
  if (provider === 'google_drive') return { url: 'https://accounts.google.com/o/oauth2/v2/auth', params: {
    client_id: config.client_id, response_type: 'code', redirect_uri: redirectUri, scope: meta.scopes.join(' '), state,
    access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent select_account',
  } }
  if (provider === 'notion') return { url: 'https://api.notion.com/v1/oauth/authorize', params: {
    owner: 'user', client_id: config.client_id, response_type: 'code', redirect_uri: redirectUri, state,
  } }
  if (provider === 'attio') return { url: 'https://app.attio.com/authorize', params: {
    response_type: 'code', client_id: config.client_id, redirect_uri: redirectUri, state,
  } }
  return { url: 'https://slack.com/oauth/v2/authorize', params: {
    client_id: config.client_id, scope: meta.scopes.join(','), redirect_uri: redirectUri, state,
  } }
}

export async function createProviderInstallUrl({ provider, userId, visibility }) {
  if (!OAUTH_PROVIDERS[provider]) throw new Error('Unbekannter OAuth-Anbieter')
  const config = await getProviderConfig(provider)
  await db.from('oauth_states').delete().lt('expires_at', new Date().toISOString())
  const state = crypto.randomBytes(32).toString('base64url')
  const { error } = await db.from('oauth_states').insert({
    state_hash: stateHash(state), user_id: userId, provider, visibility,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  })
  if (error) throw new Error(error.message)
  const auth = authorizationConfig(provider, config, state)
  return `${auth.url}?${new URLSearchParams(auth.params)}`
}

async function consumeState(provider, state) {
  if (!state) throw new Error('OAuth-State fehlt')
  const hash = stateHash(state)
  const { data, error } = await db.from('oauth_states').select('*').eq('state_hash', hash).eq('provider', provider).maybeSingle()
  await db.from('oauth_states').delete().eq('state_hash', hash)
  if (error || !data) throw new Error('OAuth-State ist ungültig oder wurde bereits verwendet')
  if (new Date(data.expires_at) <= new Date()) throw new Error('OAuth-State ist abgelaufen')
  return data
}

async function exchangeCode(provider, code, config) {
  const redirectUri = providerRedirectUri(provider)
  let url
  let headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  let body
  if (provider === 'outlook') {
    url = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant_id || 'organizations')}/oauth2/v2.0/token`
    body = new URLSearchParams({ client_id: config.client_id, client_secret: config.client_secret, code, redirect_uri: redirectUri,
      grant_type: 'authorization_code', scope: OAUTH_PROVIDERS.outlook.scopes.join(' ') })
  } else if (provider === 'google_drive') {
    url = 'https://oauth2.googleapis.com/token'
    body = new URLSearchParams({ client_id: config.client_id, client_secret: config.client_secret, code, redirect_uri: redirectUri, grant_type: 'authorization_code' })
  } else if (provider === 'notion') {
    url = 'https://api.notion.com/v1/oauth/token'
    headers = { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`, 'Notion-Version': '2026-03-11' }
    body = JSON.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri })
  } else if (provider === 'attio') {
    url = 'https://app.attio.com/oauth/token'
    body = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: config.client_id, client_secret: config.client_secret })
  } else {
    url = 'https://slack.com/api/oauth.v2.access'
    body = new URLSearchParams({ client_id: config.client_id, client_secret: config.client_secret, code, redirect_uri: redirectUri })
  }
  const response = await fetch(url, { method: 'POST', headers, body })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token || data.ok === false) throw new Error(`${OAUTH_PROVIDERS[provider].label} OAuth fehlgeschlagen: ${data.error_description || data.error || response.status}`)
  return data
}

async function probeProvider(provider, tokenData) {
  const token = tokenData.access_token
  if (provider === 'slack') {
    const info = await probeSlack(token)
    return { id: tokenData.team?.id || null, name: tokenData.team?.name || info.team || 'Slack Workspace' }
  }
  if (provider === 'attio') return { id: null, name: await probeAttio(token) }
  if (provider === 'notion') return { id: tokenData.workspace_id || null, name: tokenData.workspace_name || 'Notion Workspace' }
  const endpoint = provider === 'outlook' ? 'https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName' : 'https://www.googleapis.com/oauth2/v2/userinfo'
  const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(`${OAUTH_PROVIDERS[provider].label} Profiltest fehlgeschlagen (${response.status})`)
  return provider === 'outlook'
    ? { id: data.id, name: data.mail || data.userPrincipalName || data.displayName }
    : { id: data.id, name: data.email || data.name }
}

function resultUrl(provider, status, params = {}) {
  const url = new URL('/spaces/marketplace', frontendOrigin())
  url.searchParams.set('oauth', provider)
  url.searchParams.set('status', status)
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, String(value))
  return url.toString()
}

export async function completeProviderOAuth({ provider, code, state, deniedError }) {
  const oauthState = await consumeState(provider, state)
  if (deniedError) return resultUrl(provider, 'error', { reason: deniedError === 'access_denied' ? 'cancelled' : 'provider_error' })
  if (!code) return resultUrl(provider, 'error', { reason: 'missing_code' })
  const config = await getProviderConfig(provider)
  const tokenData = await exchangeCode(provider, code, config)
  const account = await probeProvider(provider, tokenData)
  const personal = oauthState.visibility !== 'team'
  let previousQuery = db.from('connectors').select('id').eq('kind', provider)
  previousQuery = personal ? previousQuery.eq('owner', oauthState.user_id).neq('visibility', 'team') : previousQuery.eq('visibility', 'team')
  const { data: previous } = await previousQuery
  let deleteQuery = db.from('connectors').delete().eq('kind', provider)
  deleteQuery = personal ? deleteQuery.eq('owner', oauthState.user_id).neq('visibility', 'team') : deleteQuery.eq('visibility', 'team')
  await deleteQuery
  const rawScopes = Array.isArray(tokenData.scope) ? tokenData.scope : String(tokenData.scope || '').split(provider === 'slack' ? ',' : ' ')
  const { data: connector, error } = await db.from('connectors').insert({
    name: OAUTH_PROVIDERS[provider].label,
    url: provider === 'outlook' ? 'https://graph.microsoft.com' : provider === 'google_drive' ? 'https://www.googleapis.com/drive' : provider === 'notion' ? 'https://api.notion.com' : provider === 'attio' ? 'https://api.attio.com' : 'https://slack.com',
    token: encryptSecret(tokenData.access_token), refresh_token: encryptSecret(tokenData.refresh_token || null),
    token_expires_at: tokenData.expires_in ? new Date(Date.now() + Number(tokenData.expires_in) * 1000).toISOString() : null,
    category: 'connection', kind: provider, tool_count: OAUTH_PROVIDERS[provider].toolCount,
    created_by: oauthState.user_id, owner: personal ? oauthState.user_id : null,
    visibility: personal ? 'personal' : 'team', auth_type: 'oauth',
    external_account_id: account.id, external_account_name: account.name, scopes: rawScopes.filter(Boolean),
  }).select('id').single()
  if (error) throw new Error(error.message)
  const { moveConnectorAssignments } = await import('./connector-access.js')
  await moveConnectorAssignments((previous || []).map((row) => row.id), connector.id)
  invalidateSlackCache(); invalidateAttioCache(); invalidateProductivityCache()
  return resultUrl(provider, 'connected', { workspace: account.name })
}

export const providerOAuthErrorUrl = (provider, reason = 'unknown') => resultUrl(provider, 'error', { reason })

export async function refreshProviderToken(provider, connector) {
  if (!connector.refresh_token) return decryptSecret(connector.token)
  const config = await getProviderConfig(provider)
  let url
  let headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }
  let body
  const refreshToken = decryptSecret(connector.refresh_token)
  if (provider === 'notion') {
    url = 'https://api.notion.com/v1/oauth/token'
    headers = { ...headers, 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`, 'Notion-Version': '2026-03-11' }
    body = JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken })
  } else if (provider === 'outlook') {
    url = `https://login.microsoftonline.com/${encodeURIComponent(config.tenant_id || 'organizations')}/oauth2/v2.0/token`
    body = new URLSearchParams({ client_id: config.client_id, client_secret: config.client_secret, grant_type: 'refresh_token', refresh_token: refreshToken, scope: OAUTH_PROVIDERS.outlook.scopes.join(' ') })
  } else if (provider === 'google_drive') {
    url = 'https://oauth2.googleapis.com/token'
    body = new URLSearchParams({ client_id: config.client_id, client_secret: config.client_secret, grant_type: 'refresh_token', refresh_token: refreshToken })
  } else return decryptSecret(connector.token)
  const response = await fetch(url, { method: 'POST', headers, body })
  const data = await response.json().catch(() => ({}))
  if (!response.ok || !data.access_token) throw new Error(`${OAUTH_PROVIDERS[provider].label}-Token konnte nicht erneuert werden`)
  await db.from('connectors').update({
    token: encryptSecret(data.access_token),
    refresh_token: encryptSecret(data.refresh_token || refreshToken),
    token_expires_at: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000).toISOString() : connector.token_expires_at,
  }).eq('id', connector.id)
  return data.access_token
}
