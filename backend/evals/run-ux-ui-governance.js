import { createClient } from '@supabase/supabase-js'
import { db } from '../src/db.js'
import { uxUiToolDefinitions, runUxUiTool } from '../src/tools/ux-ui.js'

for (const name of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[name]) throw new Error(`${name} fehlt`)
}

const createdUsers = []
const password = `Governance-${crypto.randomUUID()}-Aa1!`

async function createUser(role) {
  const email = `enni-ux-${role}-${Date.now()}-${createdUsers.length}@example.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  const user = data.user
  createdUsers.push(user.id)
  if (role === 'admin') await db.from('profiles').update({ is_admin: true }).eq('id', user.id)

  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: session, error: signInError } = await client.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError
  return { id: user.id, client, token: session.session.access_token }
}

let requestId = null
try {
  const member = await createUser('member')
  const otherMember = await createUser('member')
  const admin = await createUser('admin')

  const memberDefs = await uxUiToolDefinitions(member.id)
  const adminDefs = await uxUiToolDefinitions(admin.id)
  const created = JSON.parse(await runUxUiTool('ux_ui_request_change', {
    title: 'Marketplace-Aktionen zentrieren',
    request_text: 'Die beiden Aktionen im Marketplace sind visuell versetzt und sollen als Gruppe zentriert werden.',
    target_project: 'enneo/enneo',
    target_route: '/spaces/marketplace',
    acceptance_criteria: ['Beide Buttons teilen dieselbe Mittelachse wie die Seitenüberschrift', 'Kein horizontaler Overflow auf 390 px'],
    evidence_summary: 'Screenshot zeigt die Button-Gruppe deutlich rechts von der Überschrift.',
  }, { userId: member.id }))
  requestId = created.request.id

  const memberOwn = JSON.parse(await runUxUiTool('ux_ui_list_my_requests', {}, { userId: member.id }))
  const otherOwn = JSON.parse(await runUxUiTool('ux_ui_list_my_requests', {}, { userId: otherMember.id }))
  const { data: otherRlsRows, error: otherRlsError } = await otherMember.client.from('ui_change_requests').select('id')
  const { data: adminRlsRows, error: adminRlsError } = await admin.client.from('ui_change_requests').select('id')
  const { error: directInsertError } = await member.client.from('ui_change_requests').insert({
    requested_by: otherMember.id,
    title: 'Nicht erlaubt',
    request_text: 'Dieser accountuebergreifende Direkt-Insert muss blockiert werden.',
    acceptance_criteria: ['blockiert'],
  })

  let memberAdminBlocked = false
  try {
    await runUxUiTool('ux_ui_manage_request', { request_id: requestId, status: 'approved' }, { userId: member.id })
  } catch (error) {
    memberAdminBlocked = /Nur Admins/.test(error.message)
  }

  await db.from('profiles').update({ account_status: 'disabled' }).eq('id', member.id)
  const { data: disabledRows, error: disabledRowsError } = await member.client.from('ui_change_requests').select('id')
  await db.from('profiles').update({ account_status: 'active' }).eq('id', member.id)

  const approved = JSON.parse(await runUxUiTool('ux_ui_manage_request', {
    request_id: requestId,
    status: 'approved',
    admin_notes: 'Scope und Kriterien geprüft.',
  }, { userId: admin.id }))

  const checks = {
    memberOnlyRequestTools: memberDefs.length === 2 && memberDefs.every((tool) => ['ux_ui_request_change', 'ux_ui_list_my_requests'].includes(tool.name)),
    adminGetsPrivilegedTools: adminDefs.some((tool) => tool.name === 'ux_ui_manage_request') && adminDefs.some((tool) => tool.name === 'gitlab_ui_create_branch'),
    requestCreatedForSelf: created.request.requested_by === member.id,
    memberSeesOwn: memberOwn.some((item) => item.id === requestId),
    otherMemberCannotSee: otherOwn.length === 0 && !otherRlsError && otherRlsRows.length === 0,
    adminSeesAll: !adminRlsError && adminRlsRows.some((item) => item.id === requestId),
    browserWritesBlocked: Boolean(directInsertError),
    memberAdminToolBlocked: memberAdminBlocked,
    disabledJwtCannotRead: !disabledRowsError && disabledRows.length === 0,
    adminCanApprove: approved.status === 'approved' && approved.assigned_to === admin.id,
  }
  const pass = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ pass, checks, member_tools: memberDefs.map((tool) => tool.name), admin_tools: adminDefs.map((tool) => tool.name) }))
  if (!pass) process.exitCode = 1
} finally {
  if (requestId) await db.from('ui_change_requests').delete().eq('id', requestId)
  for (const userId of createdUsers.reverse()) await db.auth.admin.deleteUser(userId)
}
