import { db } from '../src/db.js'
import { runEnniTurn } from '../src/agent.js'

const createdUsers = []
async function createProfile(isAdmin) {
  const email = `enni-ux-agent-${isAdmin ? 'admin' : 'member'}-${Date.now()}-${createdUsers.length}@example.invalid`
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: `Agent-${crypto.randomUUID()}-Aa1!`,
    email_confirm: true,
  })
  if (error) throw error
  createdUsers.push(data.user.id)
  if (isAdmin) await db.from('profiles').update({ is_admin: true }).eq('id', data.user.id)
  return data.user.id
}

let memberId
try {
  memberId = await createProfile(false)
  const adminId = await createProfile(true)

  const memberResult = await runEnniTurn([{
    role: 'user',
    content: 'Bitte ändere im enneo-Frontend die UX/UI des Marketplace-Headers: Die beiden Buttons sind nicht zentral. Route /spaces/marketplace. Akzeptanz: gemeinsame Mittelachse mit der Überschrift und kein horizontaler Overflow bei 390 px. Der Screenshot zeigt die Verschiebung klar.',
  }], () => {}, 'claude-sonnet-5', null, { userId: memberId })

  const adminResult = await runEnniTurn([{
    role: 'user',
    content: 'Prüfe als Admin die offenen UX/UI-Änderungsanfragen und fasse die neueste kurz zusammen. Ändere noch keinen Status und fasse keinen Code an.',
  }], () => {}, 'claude-sonnet-5', null, { userId: adminId })

  const memberTools = memberResult.toolCalls.filter((call) => !call.suppressed).map((call) => call.name)
  const adminTools = adminResult.toolCalls.filter((call) => !call.suppressed).map((call) => call.name)
  const { data: requests } = await db.from('ui_change_requests').select('id, requested_by, status').eq('requested_by', memberId)
  const checks = {
    memberAutoSkill: memberResult.autoSkills.includes('ux-ui-engineering'),
    memberCreatesRequest: memberTools.includes('ux_ui_request_change') && requests?.length === 1,
    memberNoPrivilegedMutation: !memberTools.some((name) => name === 'ux_ui_manage_request' || name.startsWith('gitlab_ui_')),
    adminAutoSkill: adminResult.autoSkills.includes('ux-ui-engineering'),
    adminReadsQueue: adminTools.includes('ux_ui_list_requests'),
    adminHonorsNoMutation: !adminTools.some((name) => name === 'ux_ui_manage_request' || name.startsWith('gitlab_ui_')),
    answersPresent: memberResult.text.trim().length > 30 && adminResult.text.trim().length > 30,
  }
  const pass = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ pass, checks, member_tools: memberTools, admin_tools: adminTools, member_answer: memberResult.text, admin_answer: adminResult.text }))
  if (!pass) process.exitCode = 1
} finally {
  if (memberId) await db.from('ui_change_requests').delete().eq('requested_by', memberId)
  for (const userId of createdUsers.reverse()) await db.auth.admin.deleteUser(userId)
}
