import { db } from '../src/db.js'
import { runGitlabTool } from '../src/tools/gitlab.js'
import { runUxUiTool } from '../src/tools/ux-ui.js'

if (!process.env.GITLAB_TOKEN) throw new Error('GITLAB_TOKEN fehlt')

const createdUsers = []
let requestId = null
let projectId = null
let branch = null

async function cleanupBranch() {
  if (!projectId || !branch) return
  const base = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/$/, '')
  const response = await fetch(`${base}/api/v4/projects/${projectId}/repository/branches/${encodeURIComponent(branch)}`, {
    method: 'DELETE',
    headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN },
  })
  if (!response.ok && response.status !== 404) throw new Error(`Testbranch-Cleanup fehlgeschlagen: GitLab ${response.status}`)
}

try {
  const email = `enni-ux-gitlab-admin-${Date.now()}@example.invalid`
  const { data: created, error } = await db.auth.admin.createUser({
    email,
    password: `GitLab-${crypto.randomUUID()}-Aa1!`,
    email_confirm: true,
  })
  if (error) throw error
  createdUsers.push(created.user.id)
  await db.from('profiles').update({ is_admin: true }).eq('id', created.user.id)

  const projects = JSON.parse(await runGitlabTool('gitlab_search_projects', { query: 'ops-fe' }))
  const project = projects.find((item) => String(item.path).toLowerCase() === 'enneo/ops-fe')
  if (!project) throw new Error('Testprojekt enneo/ops-fe nicht gefunden')
  projectId = project.id

  const requested = JSON.parse(await runUxUiTool('ux_ui_request_change', {
    title: 'Temporärer GitLab-Governance-Smoke-Test',
    request_text: 'Prüft, dass Admin-UX/UI-Writes ausschließlich auf einem enni/ui-Branch stattfinden.',
    target_project: project.path,
    target_route: '/smoke-test',
    acceptance_criteria: ['Branch wird erstellt', 'Datei wird nur auf dem Testbranch erstellt', 'Branch wird anschließend gelöscht'],
    evidence_summary: 'Automatisierter Governance-Test ohne Produktänderung.',
  }, { userId: created.user.id }))
  requestId = requested.request.id
  await runUxUiTool('ux_ui_manage_request', {
    request_id: requestId,
    status: 'approved',
    admin_notes: 'Automatischer Smoke-Test.',
  }, { userId: created.user.id })

  const stamp = Date.now()
  branch = `enni/ui-governance-smoke-${stamp}`
  const branchResult = JSON.parse(await runUxUiTool('gitlab_ui_create_branch', {
    request_id: requestId,
    project_id: projectId,
    branch_name: branch,
  }, { userId: created.user.id }))
  const smokePath = `docs/.enni-ui-governance-smoke-${stamp}.md`
  const fileResult = JSON.parse(await runUxUiTool('gitlab_ui_write_file', {
    request_id: requestId,
    project_id: projectId,
    branch_name: branch,
    file_path: smokePath,
    content: '# Temporary Enni UX/UI governance smoke test\n\nThis branch is deleted automatically.\n',
    commit_message: 'test: verify Enni UI branch governance',
  }, { userId: created.user.id }))
  const writtenContent = await runGitlabTool('gitlab_read_file', {
    project_id: projectId,
    file_path: smokePath,
    ref: branch,
  })

  const checks = {
    correctProject: branchResult.project === 'enneo/ops-fe',
    protectedBranchPrefix: branchResult.branch === branch && branch.startsWith('enni/ui-'),
    fileCreatedOnBranch: fileResult.action === 'created' && fileResult.branch === branch && writtenContent.includes('Temporary Enni UX/UI governance smoke test'),
  }
  const pass = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ pass, checks, project: project.path, branch }))
  if (!pass) process.exitCode = 1
} finally {
  await cleanupBranch()
  if (requestId) await db.from('ui_change_requests').delete().eq('id', requestId)
  for (const userId of createdUsers.reverse()) await db.auth.admin.deleteUser(userId)
}
