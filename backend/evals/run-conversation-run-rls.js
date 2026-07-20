import { createClient } from '@supabase/supabase-js'
import { db } from '../src/db.js'
import { SUPABASE_ANON_KEY } from '../../frontend/config.js'

const stamp = Date.now()
const password = `Run-State-${crypto.randomUUID()}-Aa1!`
const users = []
let conversationId = null

async function createSession(label) {
  const email = `conversation-run-${label}-${stamp}@example.invalid`
  const { data: created, error: createError } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (createError) throw createError
  users.push(created.user.id)
  const client = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY)
  const { data: signedIn, error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return { id: created.user.id, client, token: signedIn.session.access_token }
}

async function cleanup() {
  if (conversationId) await db.from('conversations').delete().eq('id', conversationId)
  for (const userId of users) await db.auth.admin.deleteUser(userId)
}

try {
  const owner = await createSession('owner')
  const outsider = await createSession('outsider')
  const { data: conversation, error: conversationError } = await db.from('conversations').insert({
    user_id: owner.id,
    title: 'Conversation run RLS eval',
    working: true,
  }).select('id').single()
  if (conversationError) throw conversationError
  conversationId = conversation.id
  const { error: runError } = await db.from('conversation_runs').insert({
    conversation_id: conversationId,
    user_message_id: null,
    status: 'Enni denkt nach …',
    phase: 'thinking',
  })
  if (runError) throw runError

  const ownerClient = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${owner.token}` } },
  })
  const outsiderClient = createClient(process.env.SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${outsider.token}` } },
  })
  const [{ data: ownerRows, error: ownerError }, { data: outsiderRows, error: outsiderError }] = await Promise.all([
    ownerClient.from('conversation_runs').select('conversation_id, phase').eq('conversation_id', conversationId),
    outsiderClient.from('conversation_runs').select('conversation_id, phase').eq('conversation_id', conversationId),
  ])
  if (ownerError) throw ownerError
  if (outsiderError) throw outsiderError
  const { error: outsiderWriteError } = await outsiderClient.from('conversation_runs').insert({
    conversation_id: conversationId,
    phase: 'thinking',
    status: 'unauthorized',
  })

  const result = {
    owner_can_read: ownerRows?.length === 1,
    outsider_isolated: outsiderRows?.length === 0,
    client_writes_blocked: !!outsiderWriteError,
  }
  if (!Object.values(result).every(Boolean)) throw new Error(`Conversation-Run RLS eval failed: ${JSON.stringify(result)}`)
  console.log(JSON.stringify(result))
} finally {
  await cleanup()
}
