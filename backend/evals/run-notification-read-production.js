import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const backend = process.env.BACKEND_URL || 'https://enneo-os-backend-production.up.railway.app'
if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const password = `Notification-${crypto.randomUUID()}-Aa1!`
const users = []
let conversationId = null

async function createUser(label) {
  const email = `notification-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}@example.invalid`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  users.push(data.user.id)
  const auth = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: login, error: loginError } = await auth.auth.signInWithPassword({ email, password })
  if (loginError) throw loginError
  return { id: data.user.id, token: login.session.access_token }
}

async function markRead(user, id) {
  const response = await fetch(`${backend}/api/conversations/${id}/read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${user.token}` },
  })
  return { status: response.status, body: await response.json().catch(() => ({})) }
}

try {
  const owner = await createUser('owner')
  const outsider = await createUser('outsider')
  const { data: conversation, error: conversationError } = await admin.from('conversations').insert({
    user_id: owner.id,
    title: 'Notification Read Test',
    unread: true,
  }).select('id').single()
  if (conversationError) throw conversationError
  conversationId = conversation.id

  const { data: notification, error: notificationError } = await admin.from('notifications').insert({
    user_id: owner.id,
    type: 'agent_complete',
    conversation_id: conversation.id,
    title: 'Enni ist fertig',
    body: 'Testantwort',
    action_url: `/chat/${conversation.id}`,
  }).select('id').single()
  if (notificationError) throw notificationError

  const blocked = await markRead(outsider, conversation.id)
  if (blocked.status !== 404) throw new Error(`outsider read unexpectedly returned ${blocked.status}`)

  const read = await markRead(owner, conversation.id)
  if (read.status !== 200) throw new Error(`owner read returned ${read.status}: ${JSON.stringify(read.body)}`)

  const [{ data: finalConversation }, { data: finalNotification }] = await Promise.all([
    admin.from('conversations').select('unread').eq('id', conversation.id).single(),
    admin.from('notifications').select('read_at,push_state,push_attempted_at').eq('id', notification.id).single(),
  ])
  const checks = {
    outsiderBlocked: blocked.status === 404,
    ownerAccepted: read.status === 200,
    conversationRead: finalConversation?.unread === false,
    notificationRead: Boolean(finalNotification?.read_at),
    pendingPushSkipped: finalNotification?.push_state === 'skipped' && Boolean(finalNotification?.push_attempted_at),
  }
  if (!Object.values(checks).every(Boolean)) throw new Error(`checks failed: ${JSON.stringify(checks)}`)
  console.log(JSON.stringify({ ok: true, checks }))
} finally {
  if (conversationId) await admin.from('conversations').delete().eq('id', conversationId)
  for (const id of users) await admin.auth.admin.deleteUser(id)
}
