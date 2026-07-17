import webpush from 'web-push'
import { db } from './db.js'

const vapid = {
  subject: process.env.VAPID_SUBJECT || 'mailto:notifications@enneo.ai',
  publicKey: process.env.VAPID_PUBLIC_KEY || '',
  privateKey: process.env.VAPID_PRIVATE_KEY || '',
}
if (vapid.publicKey && vapid.privateKey) {
  webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
}

export function pushPublicKey() {
  return vapid.publicKey
}

export async function createNotification(notification) {
  const { data, error } = await db.from('notifications').insert(notification).select('*').single()
  if (error) throw new Error(error.message)
  return data
}

export async function createNotifications(notifications) {
  if (!notifications.length) return []
  const { data, error } = await db.from('notifications').insert(notifications).select('*')
  if (error) throw new Error(error.message)
  return data || []
}

function aliasSet(profile) {
  const display = (profile.display_name || '').trim().toLowerCase()
  const email = (profile.email || '').split('@')[0].toLowerCase()
  return new Set([display, display.split(/\s+/)[0], email].filter(Boolean))
}

function compactMessage(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, 240)
}

export async function notifyPodMentions({ pod, actorId, messageId, conversationId, threadRootId, text }) {
  const raw = String(text || '')
  const tokens = [...raw.matchAll(/@([\wÀ-ÿ.\-]+)/g)].map((match) => match[1].toLowerCase())
  const hasTeam = tokens.includes('team')
  const directTokens = new Set(tokens.filter((token) => !['team', 'enni'].includes(token)))
  if (!hasTeam && !directTokens.size) return []

  const [{ data: profiles }, { data: members }] = await Promise.all([
    db.from('profiles').select('id, email, display_name, account_status').eq('account_status', 'active'),
    db.from('pod_members').select('user_id').eq('pod_id', pod.id),
  ])
  const allowed = new Set([pod.created_by, ...(members || []).map((member) => member.user_id)])
  const participants = (profiles || []).filter((profile) => profile.id !== actorId && allowed.has(profile.id))
  const recipients = new Map()
  if (hasTeam) participants.forEach((profile) => recipients.set(profile.id, 'team_mention'))
  for (const profile of participants) {
    if ([...aliasSet(profile)].some((alias) => directTokens.has(alias))) recipients.set(profile.id, 'mention')
  }
  if (!recipients.size) return []

  const actor = (profiles || []).find((profile) => profile.id === actorId)
  const actorName = actor?.display_name || actor?.email?.split('@')[0] || 'Ein Teammitglied'
  const body = compactMessage(raw)
  return createNotifications([...recipients].map(([userId, type]) => ({
    user_id: userId,
    type,
    actor_id: actorId,
    pod_id: pod.id,
    conversation_id: conversationId,
    message_id: messageId,
    title: type === 'mention' ? `${actorName} hat dich erwähnt` : `${actorName} hat @team erwähnt`,
    body,
    action_url: `/pod/${pod.id}?tab=convs&conversation=${conversationId}${threadRootId ? `&thread=${threadRootId}` : ''}`,
    metadata: { pod_name: pod.name },
  })))
}

export async function notifyPodThreadReply({ pod, actorId, messageId, conversationId, threadRootId, text, excludeUserIds = [] }) {
  if (!threadRootId) return []
  const [{ data: root }, { data: replies }, { data: actor }] = await Promise.all([
    db.from('messages').select('author_id').eq('id', threadRootId).maybeSingle(),
    db.from('messages').select('author_id').eq('thread_root_id', threadRootId),
    db.from('profiles').select('display_name, email').eq('id', actorId).maybeSingle(),
  ])
  const excluded = new Set([actorId, ...excludeUserIds])
  const recipients = [...new Set([root?.author_id, ...(replies || []).map((item) => item.author_id)].filter((id) => id && !excluded.has(id)))]
  const actorName = actor?.display_name || actor?.email?.split('@')[0] || 'Ein Teammitglied'
  return createNotifications(recipients.map((userId) => ({
    user_id: userId,
    type: 'thread_reply',
    actor_id: actorId,
    pod_id: pod.id,
    conversation_id: conversationId,
    message_id: messageId,
    title: `${actorName} hat im Thread geantwortet`,
    body: compactMessage(text),
    action_url: `/pod/${pod.id}?tab=convs&conversation=${conversationId}&thread=${threadRootId}`,
    metadata: { pod_name: pod.name, thread_root_id: threadRootId },
  })))
}

function timeInZone(timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: timeZone || 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((part) => [part.type, part.value]))
  return Number(parts.hour === '24' ? 0 : parts.hour) * 60 + Number(parts.minute)
}

function minutes(value) {
  const [hour, minute] = String(value || '00:00').split(':').map(Number)
  return hour * 60 + minute
}

function isQuiet(preference) {
  if (!preference?.quiet_hours_enabled) return false
  const now = timeInZone(preference.timezone)
  const start = minutes(preference.quiet_start)
  const end = minutes(preference.quiet_end)
  return start <= end ? now >= start && now < end : now >= start || now < end
}

async function deliverPush(notification) {
  const { data: fresh } = await db
    .from('notifications')
    .select('read_at, push_state')
    .eq('id', notification.id)
    .maybeSingle()
  if (!fresh || fresh.read_at || fresh.push_state !== 'pending') {
    if (fresh?.push_state === 'pending') {
      await db.from('notifications').update({ push_state: 'skipped', push_attempted_at: new Date().toISOString() }).eq('id', notification.id)
    }
    return
  }
  const [{ data: preference }, { data: subscriptions }] = await Promise.all([
    db.from('notification_preferences').select('*').eq('user_id', notification.user_id).maybeSingle(),
    db.from('push_subscriptions').select('*').eq('user_id', notification.user_id).eq('enabled', true),
  ])
  const muted = notification.pod_id && (preference?.muted_pod_ids || []).includes(notification.pod_id)
  if (!vapid.publicKey || !preference?.browser_push || muted || isQuiet(preference) || !subscriptions?.length) {
    await db.from('notifications').update({ push_state: 'skipped', push_attempted_at: new Date().toISOString() }).eq('id', notification.id)
    return
  }

  const payload = JSON.stringify({
    title: notification.title,
    body: notification.body,
    url: notification.action_url || '/chat',
    tag: `enneo-${notification.type}-${notification.message_id || notification.id}`,
    icon: '/icons/enni.png',
  })
  let delivered = false
  let transientFailure = false
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      }, payload, { TTL: 60 * 60 * 8, urgency: notification.type.includes('mention') ? 'high' : 'normal' })
      delivered = true
      await db.from('push_subscriptions').update({ failure_count: 0, last_success_at: new Date().toISOString() }).eq('id', subscription.id)
    } catch (error) {
      if ([404, 410].includes(error.statusCode)) {
        await db.from('push_subscriptions').delete().eq('id', subscription.id)
      } else {
        transientFailure = true
        await db.from('push_subscriptions').update({ failure_count: subscription.failure_count + 1 }).eq('id', subscription.id)
        console.error('Web Push fehlgeschlagen:', error.statusCode || error.message)
      }
    }
  }
  await db.from('notifications').update({
    push_state: delivered ? 'sent' : transientFailure ? 'failed' : 'skipped',
    push_attempted_at: new Date().toISOString(),
  }).eq('id', notification.id)
}

let tickerRunning = false
async function pushTick() {
  if (tickerRunning) return
  tickerRunning = true
  try {
    const { data, error } = await db.from('notifications').select('*').eq('push_state', 'pending').is('read_at', null).order('created_at').limit(50)
    if (error) throw error
    for (const notification of data || []) await deliverPush(notification)
  } catch (error) {
    console.error('Notification-Push-Ticker:', error.message)
  } finally {
    tickerRunning = false
  }
}

export function startPushTicker() {
  setInterval(pushTick, 5000)
  setTimeout(pushTick, 750)
  console.log(`Web-Push-Ticker gestartet (${vapid.publicKey ? 'VAPID aktiv' : 'VAPID nicht konfiguriert'})`)
}
