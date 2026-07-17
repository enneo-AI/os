import { decryptSecret } from '../crypto.js'
import { connectorForUser } from '../connector-access.js'

// ============================================================ Slack (nativ, read-only)
// Per OAuth verbunden und verschlüsselt in `connectors` gespeichert. Bewusst nur
// Lese-Tools; öffentliche Channels kann die App selbstständig betreten,
// private Channels nur, wenn sie dort manuell eingeladen wurde.

const BASE = 'https://slack.com/api'
let userCache = { at: 0, names: new Map() } // Slack-User-ID -> Anzeigename

// Per-User-Aufloesung: eigener persoenlicher Connector hat Vorrang vor dem Team-Connector
async function slackToken(userId) {
  return decryptSecret((await connectorForUser('slack', userId, { fresh: true }))?.token || null)
}

export function invalidateSlackCache() {
  userCache.at = 0
}

async function slackCall(token, method, params = {}) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params),
  })
  const json = await res.json()
  if (!json.ok) throw new Error(`Slack ${method}: ${json.error}`)
  return json
}

// Verbindungstest beim Anlegen — liefert Workspace + Bot-Namen
export async function probeSlack(token) {
  const auth = await slackCall(token, 'auth.test')
  return { team: auth.team, bot: auth.user }
}

export async function revokeSlackToken(token) {
  if (!token) return
  await slackCall(decryptSecret(token), 'auth.revoke')
}

// User-IDs zu Namen auflösen (<@U123> in Messages), Team-weit gecacht (10 Min)
async function userNames(token) {
  if (Date.now() - userCache.at < 10 * 60_000) return userCache.names
  const names = new Map()
  try {
    let cursor
    do {
      const page = await slackCall(token, 'users.list', { limit: 200, ...(cursor ? { cursor } : {}) })
      for (const u of page.members || []) names.set(u.id, u.profile?.display_name || u.real_name || u.name)
      cursor = page.response_metadata?.next_cursor
    } while (cursor)
  } catch (err) {
    console.error('Slack users.list fehlgeschlagen (users:read-Scope fehlt?):', err.message)
  }
  userCache = { at: Date.now(), names }
  return names
}

function renderMessages(messages, names) {
  return (messages || [])
    .map((m) => {
      const who = names.get(m.user) || m.username || m.bot_id || 'unbekannt'
      const when = m.ts ? new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''
      const text = (m.text || '').replace(/<@([A-Z0-9]+)>/g, (_, id) => '@' + (names.get(id) || id))
      const thread = m.reply_count ? ` [Thread: ${m.reply_count} Antworten, thread_ts=${m.thread_ts || m.ts}]` : ''
      return `[${when}] ${who}: ${text}${thread}`
    })
    .join('\n')
}

const TOOL_DEFS = [
  {
    name: 'slack_list_channels',
    description:
      'Listet die Slack-Channels des Workspaces (öffentliche; private nur wo der Bot Mitglied ist) mit ID, Name und Thema. Rufe das zuerst auf, um die Channel-ID für slack_read_channel zu finden.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optionaler Namensfilter, z. B. "support"' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'slack_read_channel',
    description:
      'Liest die letzten Nachrichten eines Slack-Channels (neueste zuerst). Öffentlichen Channels tritt der Bot automatisch bei. Threads sind markiert — Details über slack_read_thread.',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel-ID aus slack_list_channels (z. B. "C0123…")' },
        limit: { type: 'number', description: 'Anzahl Nachrichten, Default 30, max 100' },
        oldest_days: { type: 'number', description: 'Nur Nachrichten der letzten N Tage (optional)' },
      },
      required: ['channel_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'slack_read_thread',
    description: 'Liest einen kompletten Slack-Thread (alle Antworten).',
    input_schema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string', description: 'Channel-ID' },
        thread_ts: { type: 'string', description: 'Der thread_ts-Wert aus slack_read_channel' },
      },
      required: ['channel_id', 'thread_ts'],
      additionalProperties: false,
    },
  },
]

export async function slackToolDefinitions(userId) {
  return (await connectorForUser('slack', userId)) ? TOOL_DEFS : []
}

const clip = (s) => (s.length > 40000 ? s.slice(0, 40000) + '\n\n[... gekürzt]' : s)

export async function runSlackTool(name, input, ctx = {}) {
  const token = await slackToken(ctx.userId)
  if (!token) throw new Error('Slack ist nicht über einen für dich zugänglichen Space aktiviert.')

  if (name === 'slack_list_channels') {
    const out = []
    let cursor
    do {
      const page = await slackCall(token, 'conversations.list', {
        types: 'public_channel,private_channel',
        exclude_archived: true,
        limit: 200,
        ...(cursor ? { cursor } : {}),
      })
      out.push(...(page.channels || []))
      cursor = page.response_metadata?.next_cursor
    } while (cursor && out.length < 1000)
    const q = (input.query || '').toLowerCase()
    const filtered = q ? out.filter((c) => c.name.includes(q) || (c.topic?.value || '').toLowerCase().includes(q)) : out
    return clip(
      filtered
        .map((c) => `#${c.name} (${c.id})${c.is_private ? ' [privat]' : ''}${c.topic?.value ? ` — ${c.topic.value}` : ''}`)
        .join('\n') || 'Keine Channels gefunden.'
    )
  }

  if (name === 'slack_read_channel') {
    const params = { channel: input.channel_id, limit: Math.min(input.limit || 30, 100) }
    if (input.oldest_days) params.oldest = String(Date.now() / 1000 - input.oldest_days * 86400)
    let history
    try {
      history = await slackCall(token, 'conversations.history', params)
    } catch (err) {
      if (String(err.message).includes('not_in_channel')) {
        // Öffentlichem Channel automatisch beitreten, dann erneut lesen
        await slackCall(token, 'conversations.join', { channel: input.channel_id })
        history = await slackCall(token, 'conversations.history', params)
      } else throw err
    }
    const names = await userNames(token)
    return clip(renderMessages(history.messages, names) || 'Keine Nachrichten im Zeitraum.')
  }

  if (name === 'slack_read_thread') {
    const replies = await slackCall(token, 'conversations.replies', {
      channel: input.channel_id,
      ts: input.thread_ts,
      limit: 100,
    })
    const names = await userNames(token)
    return clip(renderMessages(replies.messages, names) || 'Thread leer.')
  }

  throw new Error(`Unbekanntes Slack-Tool: ${name}`)
}
