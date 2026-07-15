import { db } from '../src/db.js'

const email = `enni-ux-visual-${Date.now()}@example.invalid`
const password = `Visual-${crypto.randomUUID()}-Aa1!`
let userId = null
let requestId = null

async function cleanup() {
  if (requestId) await db.from('ui_change_requests').delete().eq('id', requestId)
  if (userId) await db.auth.admin.deleteUser(userId)
}

try {
  const { data: auth, error: authError } = await db.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  })
  if (authError) throw authError
  userId = auth.user.id

  const { error: profileError } = await db.from('profiles').update({
    is_admin: true,
    display_name: 'UX Visual Admin',
  }).eq('id', userId)
  if (profileError) throw profileError

  const { data: request, error: requestError } = await db.from('ui_change_requests').insert({
    requested_by: userId,
    title: 'Marketplace-Aktionen zentrieren',
    request_text: 'Die beiden Aktionen im Marketplace sauber zentrieren und WhatsApp sowie Telegram unter Remote Control gruppieren.',
    target_project: 'enneo/ops-fe',
    target_route: '/spaces/marketplace',
    acceptance_criteria: [
      'Beide Aktionen bilden eine optisch zentrierte Gruppe',
      'Remote Control ist eine eigene, klar erkennbare Sektion',
      'Mobile Ansicht bleibt ohne horizontalen Overflow nutzbar',
    ],
    evidence: [{ type: 'screenshot', summary: 'Versetzte Buttons im aktuellen Marketplace.' }],
    status: 'requested',
  }).select().single()
  if (requestError) throw requestError
  requestId = request.id

  console.log(JSON.stringify({ ready: true, email, password }))
  process.stdin.resume()
  await new Promise((resolve) => process.stdin.once('data', resolve))
  process.stdin.pause()
} finally {
  await cleanup()
}
