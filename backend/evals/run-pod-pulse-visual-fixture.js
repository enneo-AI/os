import { db } from '../src/db.js'

const email = `pod-pulse-visual-${Date.now()}@example.invalid`
const password = `Visual-${crypto.randomUUID()}-Aa1!`
let userId = null
let podId = null

const dateFromNow = (days) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

async function cleanup() {
  if (podId) await db.from('pods').delete().eq('id', podId)
  if (userId) await db.auth.admin.deleteUser(userId)
}

try {
  const { data: auth, error: authError } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (authError) throw authError
  userId = auth.user.id
  const { error: profileError } = await db.from('profiles').update({ is_admin: true, display_name: 'Pulse Visual Admin' }).eq('id', userId)
  if (profileError) throw profileError

  const { data: pod, error: podError } = await db.from('pods').insert({
    name: 'STAWAG Rollout',
    description: 'Produktiver AI-Agent-Rollout mit dem Customer-Success-Team',
    open: false,
    created_by: userId,
    project_status: 'at_risk',
    current_focus: 'API-Freigabe sichern und den Pilotbetrieb für nächste Woche stabilisieren.',
    target_date: dateFromNow(18),
  }).select().single()
  if (podError) throw podError
  podId = pod.id

  const { data: tasks, error: taskError } = await db.from('pod_tasks').insert([
    { pod_id: podId, title: 'API-Freigabe mit IT bestätigen', description: 'Benötigte Endpunkte und Scopes final mit dem Security-Team bestätigen.', priority: 'urgent', status: 'blocked', due_date: dateFromNow(-1), assignee: userId, section: 'Pilot', created_by: userId },
    { pod_id: podId, title: 'Testfälle für Eskalationen abschließen', description: '', priority: 'high', status: 'in_progress', due_date: dateFromNow(2), assignee: userId, section: 'Pilot', created_by: userId },
    { pod_id: podId, title: 'Go-live-Kommunikation vorbereiten', description: '', priority: 'high', status: 'open', due_date: dateFromNow(5), section: 'Rollout', created_by: userId },
    { pod_id: podId, title: 'Wissensbasis gegen Produkt-Doku prüfen', description: '', priority: 'normal', status: 'done', due_date: dateFromNow(-2), assignee: userId, section: 'Setup', created_by: userId },
  ]).select()
  if (taskError) throw taskError

  const { error: commentError } = await db.from('pod_task_comments').insert({
    task_id: tasks[0].id,
    pod_id: podId,
    author_id: userId,
    body: 'Security wartet noch auf die finale Scope-Liste. Ich habe den Entwurf im Pod ergänzt.',
  })
  if (commentError) throw commentError

  const { error: convError } = await db.from('conversations').insert({ user_id: userId, pod_id: podId, title: 'Pilot-Readiness und offene Blocker' })
  if (convError) throw convError

  console.log(JSON.stringify({ ready: true, email, password, podId }))
  process.stdin.resume()
  await new Promise((resolve) => process.stdin.once('data', resolve))
  process.stdin.pause()
} finally {
  await cleanup()
}
