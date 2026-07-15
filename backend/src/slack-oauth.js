import crypto from 'node:crypto'
import { db } from './db.js'
import { encryptSecret } from './crypto.js'
import { invalidateSlackCache, probeSlack } from './tools/slack.js'

const SLACK_SCOPES = [
  'channels:read',
  'channels:history',
  'channels:join',
  'groups:read',
  'groups:history',
  'users:read',
]

const frontendOrigin = () => (process.env.FRONTEND_ORIGIN || process.env.SITE_URL || 'https://os.enneo.ai').split(',')[0]
const redirectUri = () => process.env.SLACK_REDIRECT_URI || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}/api/oauth/slack/callback`
const stateHash = (state) => crypto.createHash('sha256').update(state).digest('hex')

function assertSlackConfig() {
  if (!process.env.SLACK_CLIENT_ID || !process.env.SLACK_CLIENT_SECRET) {
    throw new Error('Slack OAuth ist noch nicht konfiguriert')
  }
  if (!process.env.SLACK_REDIRECT_URI && !process.env.RAILWAY_PUBLIC_DOMAIN) {
    throw new Error('SLACK_REDIRECT_URI fehlt')
  }
}

export async function createSlackInstallUrl({ userId, visibility }) {
  assertSlackConfig()
  await db.from('oauth_states').delete().lt('expires_at', new Date().toISOString())
  const state = crypto.randomBytes(32).toString('base64url')
  const { error } = await db.from('oauth_states').insert({
    state_hash: stateHash(state),
    user_id: userId,
    provider: 'slack',
    visibility,
    expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
  })
  if (error) throw new Error(error.message)
  const params = new URLSearchParams({
    client_id: process.env.SLACK_CLIENT_ID,
    scope: SLACK_SCOPES.join(','),
    redirect_uri: redirectUri(),
    state,
  })
  return `https://slack.com/oauth/v2/authorize?${params}`
}

async function consumeState(state) {
  if (!state) throw new Error('OAuth-State fehlt')
  const hash = stateHash(state)
  const { data, error } = await db.from('oauth_states').select('*').eq('state_hash', hash).maybeSingle()
  await db.from('oauth_states').delete().eq('state_hash', hash)
  if (error || !data) throw new Error('OAuth-State ist ungültig oder wurde bereits verwendet')
  if (new Date(data.expires_at) <= new Date()) throw new Error('OAuth-State ist abgelaufen')
  return data
}

function resultUrl(status, params = {}) {
  const url = new URL('/spaces/marketplace', frontendOrigin())
  url.searchParams.set('oauth', 'slack')
  url.searchParams.set('status', status)
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, String(value))
  return url.toString()
}

export async function completeSlackOAuth({ code, state, deniedError }) {
  const oauthState = await consumeState(state)
  if (deniedError) return resultUrl('error', { reason: deniedError === 'access_denied' ? 'cancelled' : 'provider_error' })
  if (!code) return resultUrl('error', { reason: 'missing_code' })
  assertSlackConfig()

  const tokenResponse = await fetch('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
    }),
  })
  const tokenData = await tokenResponse.json()
  if (!tokenResponse.ok || !tokenData.ok || !tokenData.access_token) {
    throw new Error(`Slack OAuth fehlgeschlagen: ${tokenData.error || tokenResponse.status}`)
  }

  const info = await probeSlack(tokenData.access_token)
  const personal = oauthState.visibility !== 'team'
  let deleteQuery = db.from('connectors').delete().eq('kind', 'slack')
  deleteQuery = personal
    ? deleteQuery.eq('owner', oauthState.user_id).neq('visibility', 'team')
    : deleteQuery.eq('visibility', 'team')
  await deleteQuery

  const { error } = await db.from('connectors').insert({
    name: 'Slack',
    url: 'https://slack.com',
    token: encryptSecret(tokenData.access_token),
    category: 'connection',
    kind: 'slack',
    tool_count: 3,
    created_by: oauthState.user_id,
    owner: personal ? oauthState.user_id : null,
    visibility: personal ? 'personal' : 'team',
    auth_type: 'oauth',
    external_account_id: tokenData.team?.id || null,
    external_account_name: tokenData.team?.name || info.team || null,
    scopes: String(tokenData.scope || '').split(',').filter(Boolean),
  })
  if (error) throw new Error(error.message)
  invalidateSlackCache()
  return resultUrl('connected', { workspace: tokenData.team?.name || info.team })
}

export function slackOAuthErrorUrl(reason = 'unknown') {
  return resultUrl('error', { reason })
}
