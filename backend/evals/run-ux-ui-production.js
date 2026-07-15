import { createClient } from '@supabase/supabase-js'
import { db } from '../src/db.js'

const apiUrl = (process.env.PRODUCTION_API_URL || 'https://enneo-os-backend-production.up.railway.app').replace(/\/$/, '')
const password = `Production-${crypto.randomUUID()}-Aa1!`
const users = []
let requestId = null

async function user(role) {
  const email = `enni-ux-production-${role}-${Date.now()}-${users.length}@example.invalid`
  const { data, error } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (error) throw error
  users.push(data.user.id)
  if (role === 'admin') await db.from('profiles').update({ is_admin: true }).eq('id', data.user.id)
  const client = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: auth, error: authError } = await client.auth.signInWithPassword({ email, password })
  if (authError) throw authError
  return { id: data.user.id, token: auth.session.access_token }
}

async function api(path, actor, options = {}) {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${actor.token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  return { response, data: await response.json().catch(() => ({})) }
}

try {
  const member = await user('member')
  const other = await user('member')
  const admin = await user('admin')

  const created = await api('/api/ui-change-requests', member, {
    method: 'POST',
    body: JSON.stringify({
      title: 'Production UX/UI Governance Smoke',
      request_text: 'Prüft den produktiven rollenbasierten UX/UI-Anfragefluss ohne Repository-Mutation.',
      target_project: 'enneo/ops-fe',
      target_route: '/spaces/marketplace',
      acceptance_criteria: ['Member-Request wird erstellt', 'Nur Admin kann freigeben'],
      evidence_summary: 'Automatischer Production-Smoke.',
    }),
  })
  requestId = created.data.request?.id

  const [memberList, otherList, adminList, memberCatalog, adminCatalog, forbiddenPatch] = await Promise.all([
    api('/api/ui-change-requests', member),
    api('/api/ui-change-requests', other),
    api('/api/ui-change-requests', admin),
    api('/api/tools/catalog', member),
    api('/api/tools/catalog', admin),
    api(`/api/admin/ui-change-requests/${requestId}`, member, { method: 'PATCH', body: JSON.stringify({ status: 'approved' }) }),
  ])
  const approved = await api(`/api/admin/ui-change-requests/${requestId}`, admin, {
    method: 'PATCH', body: JSON.stringify({ status: 'approved', admin_notes: 'Production-Smoke geprüft.' }),
  })

  const memberTools = (memberCatalog.data.tools || []).map((tool) => tool.name)
  const adminTools = (adminCatalog.data.tools || []).map((tool) => tool.name)
  const checks = {
    create201: created.response.status === 201 && Boolean(requestId),
    memberSeesOwn: memberList.response.ok && memberList.data.requests?.some((item) => item.id === requestId),
    otherMemberIsolated: otherList.response.ok && otherList.data.requests?.length === 0,
    adminSeesQueue: adminList.response.ok && adminList.data.requests?.some((item) => item.id === requestId),
    memberCatalogRestricted: memberTools.includes('ux_ui_request_change') && !memberTools.includes('ux_ui_manage_request') && !memberTools.some((name) => name.startsWith('gitlab_ui_')),
    adminCatalogPrivileged: adminTools.includes('ux_ui_manage_request') && adminTools.includes('gitlab_ui_create_merge_request'),
    memberPatchForbidden: forbiddenPatch.response.status === 403,
    adminApprovalWorks: approved.response.ok && approved.data.request?.status === 'approved',
  }
  const pass = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ pass, checks, deployment: apiUrl }))
  if (!pass) process.exitCode = 1
} finally {
  if (requestId) await db.from('ui_change_requests').delete().eq('id', requestId)
  for (const userId of users.reverse()) await db.auth.admin.deleteUser(userId)
}
