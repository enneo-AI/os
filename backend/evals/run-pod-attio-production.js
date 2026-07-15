import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const backend = process.env.BACKEND_URL || 'https://enneo-os-backend-production.up.railway.app'
if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const password = `Attio-${crypto.randomUUID()}-Aa1!`
const users = []
let podId = null

function userClient(token) {
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function createUser(label) {
  const email = `pod-attio-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}@example.invalid`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  users.push(data.user.id)
  const login = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: session, error: loginError } = await login.auth.signInWithPassword({ email, password })
  if (loginError) throw loginError
  return { id: data.user.id, token: session.session.access_token, client: userClient(session.session.access_token) }
}

async function api(user, path = '', options = {}) {
  const response = await fetch(`${backend}/api/pods/${podId}/attio${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${user.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  return { status: response.status, data }
}

try {
  const owner = await createUser('owner')
  const member = await createUser('member')
  const outsider = await createUser('outsider')

  const { data: pod, error: podError } = await owner.client.from('pods')
    .insert({ name: 'STAWAG Attio Verknüpfungstest', open: false, created_by: owner.id })
    .select().single()
  if (podError) throw podError
  podId = pod.id
  const { error: memberError } = await owner.client.from('pod_members').insert({ pod_id: podId, user_id: member.id })
  if (memberError) throw memberError

  const initial = await api(owner)
  if (initial.status !== 200 || !initial.data.connected || !initial.data.can_manage) throw new Error(`owner state failed: ${JSON.stringify(initial)}`)

  const search = await api(owner, '/search?object=companies&q=STAWAG')
  if (search.status !== 200 || !search.data.records?.length) throw new Error(`Attio search failed: ${JSON.stringify(search)}`)
  const record = search.data.records[0]

  const linked = await api(owner, '', { method: 'PUT', body: JSON.stringify({ record_id: record.record_id }) })
  if (linked.status !== 200 || linked.data.link?.attio_record_id !== record.record_id) throw new Error(`link failed: ${JSON.stringify(linked)}`)

  const memberState = await api(member)
  if (memberState.status !== 200 || memberState.data.can_manage || memberState.data.link?.attio_record_id !== record.record_id) {
    throw new Error(`member read failed: ${JSON.stringify(memberState)}`)
  }
  const memberWrite = await api(member, '', { method: 'PUT', body: JSON.stringify({ record_id: record.record_id }) })
  if (memberWrite.status !== 403) throw new Error(`member backend write unexpectedly returned ${memberWrite.status}`)

  const directWrite = await member.client.from('pod_attio_links').update({ record_name: 'Manipuliert' }).eq('pod_id', podId)
  if (!directWrite.error) throw new Error('direct authenticated DB write unexpectedly succeeded')

  const outsiderRows = await outsider.client.from('pod_attio_links').select('pod_id').eq('pod_id', podId)
  if (outsiderRows.error || outsiderRows.data.length) throw new Error('restricted Attio link leaked to outsider')

  const synced = await api(owner, '/sync', { method: 'POST' })
  if (synced.status !== 200) throw new Error(`sync failed: ${JSON.stringify(synced)}`)

  const chatResponse = await fetch(`${backend}/api/chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${owner.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pod_id: podId,
      model: 'claude-haiku-4-5',
      message: '@enni Welcher Kunde ist mit diesem Pod verknüpft? Antworte nur mit Name und Domain.',
    }),
  })
  const chatBody = await chatResponse.text()
  const events = chatBody.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  const tools = events.filter((event) => event.type === 'tool_use').map((event) => event.name)
  const conversation = events.find((event) => event.type === 'conversation')
  const { data: answerRow } = await admin.from('messages').select('content')
    .eq('conversation_id', conversation?.conversation_id).eq('role', 'assistant').order('created_at', { ascending: false }).limit(1).maybeSingle()
  const answer = answerRow?.content || ''
  if (!/STAWAG/i.test(answer) || !/stawag\.de/i.test(answer)) throw new Error(`Pod customer context missing: ${answer}`)
  if (tools.length) throw new Error(`Simple identity question loaded CRM tools unnecessarily: ${tools.join(', ')}`)

  console.log(JSON.stringify({ ok: true, checks: 11, customer: record.name, enni_answer: answer, tools }))
} finally {
  if (podId) await admin.from('pods').delete().eq('id', podId)
  for (const id of users) await admin.auth.admin.deleteUser(id)
}
