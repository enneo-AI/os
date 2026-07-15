import { createClient } from '@supabase/supabase-js'

const url = process.env.SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required')

const admin = createClient(url, serviceKey, { auth: { persistSession: false } })
const password = `Pulse-${crypto.randomUUID()}-Aa1!`
const users = []
let podId = null

function userClient(token) {
  return createClient(url, serviceKey, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  })
}

async function createUser(label) {
  const email = `pod-pulse-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 6)}@example.invalid`
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  users.push(data.user.id)
  const loginClient = createClient(url, serviceKey, { auth: { persistSession: false } })
  const { data: login, error: loginError } = await loginClient.auth.signInWithPassword({ email, password })
  if (loginError) throw loginError
  return { id: data.user.id, client: userClient(login.session.access_token) }
}

async function assertOk(label, result) {
  if (result.error) throw new Error(`${label}: ${result.error.message}`)
  return result.data
}

try {
  const owner = await createUser('owner')
  const teammate = await createUser('teammate')
  const outsider = await createUser('outsider')

  const pod = await assertOk('create restricted pod', await owner.client
    .from('pods')
    .insert({ name: 'Pulse RLS Test', open: false, created_by: owner.id, project_status: 'at_risk', current_focus: 'Blocker lösen' })
    .select()
    .single())
  podId = pod.id

  await assertOk('add teammate', await owner.client.from('pod_members').insert({ pod_id: pod.id, user_id: teammate.id }))
  const task = await assertOk('create rich task', await owner.client
    .from('pod_tasks')
    .insert({ pod_id: pod.id, title: 'API-Freigabe klären', description: 'Owner und Scope bestätigen', priority: 'urgent', status: 'blocked', created_by: owner.id })
    .select()
    .single())

  const teammateTasks = await assertOk('teammate sees task', await teammate.client.from('pod_tasks').select('id,status,priority').eq('pod_id', pod.id))
  if (teammateTasks.length !== 1 || teammateTasks[0].status !== 'blocked') throw new Error('teammate task visibility failed')

  const comment = await assertOk('teammate comments', await teammate.client
    .from('pod_task_comments')
    .insert({ task_id: task.id, pod_id: pod.id, author_id: teammate.id, body: 'Ich kläre das heute.' })
    .select()
    .single())
  if (!comment?.id) throw new Error('comment insert returned no row')

  const spoof = await teammate.client.from('pod_task_comments').insert({ task_id: task.id, pod_id: pod.id, author_id: owner.id, body: 'Spoof' })
  if (!spoof.error) throw new Error('author spoof unexpectedly succeeded')

  const outsiderTasks = await assertOk('outsider task isolation', await outsider.client.from('pod_tasks').select('id').eq('pod_id', pod.id))
  const outsiderComments = await assertOk('outsider comment isolation', await outsider.client.from('pod_task_comments').select('id').eq('pod_id', pod.id))
  if (outsiderTasks.length || outsiderComments.length) throw new Error('restricted pod leaked to outsider')

  const updated = await assertOk('teammate updates task', await teammate.client.from('pod_tasks').update({ status: 'in_progress' }).eq('id', task.id).select().single())
  if (updated.status !== 'in_progress') throw new Error('task status update failed')

  console.log(JSON.stringify({ ok: true, checks: 7 }))
} finally {
  if (podId) await admin.from('pods').delete().eq('id', podId)
  for (const id of users) await admin.auth.admin.deleteUser(id)
}
