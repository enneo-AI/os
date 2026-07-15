import { db } from '../db.js'
import { logAudit } from '../audit.js'

const GITLAB_BASE = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/$/, '')
const WRITE_NAMESPACE = (process.env.GITLAB_WRITE_NAMESPACE || 'enneo').toLowerCase()
const ADMIN_STATUSES = ['approved', 'implementing', 'changes_requested', 'completed', 'rejected']
const IMPLEMENTABLE_STATUSES = new Set(['approved', 'implementing'])

const commonDefinitions = [
  {
    name: 'ux_ui_request_change',
    description:
      'Erstellt eine strukturierte UX/UI-Aenderungsanfrage fuer den eigenen Account. Das ist fuer Members der EINZIGE erlaubte Abschluss des UX/UI-Engineering-Skills: keine Branches, Dateien, Merge Requests oder fremden Accounts veraendern.',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Kurzer, konkreter Titel der Aenderung' },
        request_text: { type: 'string', description: 'Problem, Nutzerziel und gewuenschte Aenderung' },
        target_project: { type: 'string', description: 'Projekt/Repository, sofern bekannt' },
        target_route: { type: 'string', description: 'Seite, Route oder Komponente, sofern bekannt' },
        acceptance_criteria: { type: 'array', items: { type: 'string' }, maxItems: 10 },
        evidence_summary: { type: 'string', description: 'Was Screenshot, Feedback oder Beobachtung konkret belegt' },
      },
      required: ['title', 'request_text', 'acceptance_criteria'],
      additionalProperties: false,
    },
  },
  {
    name: 'ux_ui_list_my_requests',
    description: 'Listet ausschliesslich die eigenen UX/UI-Aenderungsanfragen und ihren Status.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

const adminDefinitions = [
  {
    name: 'ux_ui_list_requests',
    description: 'ADMIN ONLY: Listet die org-weite UX/UI-Request-Queue zur Pruefung und Umsetzung.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['requested', ...ADMIN_STATUSES] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'ux_ui_manage_request',
    description:
      'ADMIN ONLY: Genehmigt, lehnt ab, fordert Aenderungen an oder dokumentiert Umsetzung/Abschluss einer UX/UI-Anfrage. completed ist erst nach angelegtem Merge Request erlaubt.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        status: { type: 'string', enum: ADMIN_STATUSES },
        admin_notes: { type: 'string' },
        verification: { type: 'string', description: 'Build-, CI- oder visuelle Pruefung beim Abschluss' },
      },
      required: ['request_id', 'status'],
      additionalProperties: false,
    },
  },
  {
    name: 'gitlab_ui_create_branch',
    description:
      'ADMIN ONLY: Erstellt fuer eine genehmigte UX/UI-Anfrage einen geschuetzten GitLab-Branch. Nur enneo-Namespace, nur Prefix enni/ui-, niemals Default-Branch.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        project_id: { type: 'integer' },
        branch_name: { type: 'string', description: 'Muss mit enni/ui- beginnen' },
        ref: { type: 'string', description: 'Ausgangs-Branch; standardmaessig Default-Branch' },
      },
      required: ['request_id', 'project_id', 'branch_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'gitlab_ui_write_file',
    description:
      'ADMIN ONLY: Erstellt oder aktualisiert eine Textdatei auf einem zuvor angelegten enni/ui-Branch fuer eine genehmigte Anfrage. Direkte Default-Branch-Writes sind technisch blockiert.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        project_id: { type: 'integer' },
        branch_name: { type: 'string' },
        file_path: { type: 'string' },
        content: { type: 'string', description: 'Vollstaendiger neuer Dateiinhalt' },
        commit_message: { type: 'string' },
      },
      required: ['request_id', 'project_id', 'branch_name', 'file_path', 'content', 'commit_message'],
      additionalProperties: false,
    },
  },
  {
    name: 'gitlab_ui_create_merge_request',
    description:
      'ADMIN ONLY: Erstellt einen Merge Request von einem enni/ui-Branch in den Default-Branch. Das Tool kann weder mergen noch Auto-Merge aktivieren.',
    input_schema: {
      type: 'object',
      properties: {
        request_id: { type: 'string' },
        project_id: { type: 'integer' },
        branch_name: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['request_id', 'project_id', 'branch_name', 'title', 'description'],
      additionalProperties: false,
    },
  },
]

export async function uxUiToolDefinitions(userId) {
  if (!userId) return commonDefinitions
  const { data: profile } = await db
    .from('profiles')
    .select('is_admin, account_status')
    .eq('id', userId)
    .maybeSingle()
  return profile?.is_admin && profile.account_status === 'active'
    ? [...commonDefinitions, ...adminDefinitions]
    : commonDefinitions
}

async function requireActiveProfile(userId, admin = false) {
  if (!userId) throw new Error('Nutzerkontext fehlt')
  const { data: profile } = await db
    .from('profiles')
    .select('id, is_admin, account_status')
    .eq('id', userId)
    .maybeSingle()
  if (!profile || profile.account_status !== 'active') throw new Error('Account ist nicht aktiv')
  if (admin && !profile.is_admin) throw new Error('Nur Admins duerfen UX/UI-Anfragen verwalten oder umsetzen')
  return profile
}

function requestSummary(row) {
  return {
    id: row.id,
    title: row.title,
    request_text: row.request_text,
    status: row.status,
    target_project: row.target_project,
    target_route: row.target_route,
    acceptance_criteria: row.acceptance_criteria,
    evidence: row.evidence,
    requested_by: row.requested_by,
    assigned_to: row.assigned_to,
    admin_notes: row.admin_notes,
    result: row.result,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

async function adminRequest(requestId, actorId, implementable = false) {
  await requireActiveProfile(actorId, true)
  const { data: request } = await db.from('ui_change_requests').select('*').eq('id', requestId).maybeSingle()
  if (!request) throw new Error('UX/UI-Anfrage nicht gefunden')
  if (implementable && !IMPLEMENTABLE_STATUSES.has(request.status)) {
    throw new Error('Die UX/UI-Anfrage muss vor einer Code-Aenderung freigegeben sein')
  }
  return request
}

async function gitlab(path, { method = 'GET', query = null, body = null, allow404 = false } = {}) {
  if (!process.env.GITLAB_TOKEN) throw new Error('GitLab ist nicht verbunden')
  const url = new URL(`${GITLAB_BASE}/api/v4${path}`)
  for (const [key, value] of Object.entries(query || {})) {
    if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value))
  }
  const response = await fetch(url, {
    method,
    headers: {
      'PRIVATE-TOKEN': process.env.GITLAB_TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  if (allow404 && response.status === 404) return null
  if (!response.ok) throw new Error(`GitLab ${response.status}: ${(await response.text()).slice(0, 500)}`)
  return response.status === 204 ? null : response.json()
}

async function writableProject(projectId) {
  const project = await gitlab(`/projects/${encodeURIComponent(projectId)}`)
  const path = String(project.path_with_namespace || '').toLowerCase()
  if (project.archived) throw new Error('Archivierte Projekte duerfen nicht veraendert werden')
  if (path.split('/')[0] !== WRITE_NAMESPACE) {
    throw new Error(`Schreibzugriff ist auf den GitLab-Namespace "${WRITE_NAMESPACE}" begrenzt`)
  }
  return project
}

function safeBranch(branch, defaultBranch) {
  const value = String(branch || '').trim()
  if (!/^enni\/ui-[a-z0-9][a-z0-9-]{2,80}$/.test(value)) {
    throw new Error('Branch muss dem Muster enni/ui-kurzer-slug entsprechen')
  }
  if (value === defaultBranch) throw new Error('Default-Branch darf nicht beschrieben werden')
  return value
}

function safeFilePath(filePath) {
  const value = String(filePath || '').trim().replace(/^\/+/, '')
  if (!value || value.includes('..') || /(^|\/)(\.env|credentials?|secrets?)(\.|\/|$)/i.test(value)) {
    throw new Error('Unsicherer oder ungueltiger Dateipfad')
  }
  return value
}

export async function runUxUiTool(name, input, ctx = {}) {
  const actor = await requireActiveProfile(ctx.userId, name !== 'ux_ui_request_change' && name !== 'ux_ui_list_my_requests')

  if (name === 'ux_ui_request_change') {
    const title = String(input.title || '').trim().slice(0, 140)
    const requestText = String(input.request_text || '').trim().slice(0, 8000)
    const criteria = [...new Set((input.acceptance_criteria || []).map((item) => String(item).trim()).filter(Boolean))].slice(0, 10)
    if (title.length < 3 || requestText.length < 10 || !criteria.length) {
      throw new Error('Titel, konkrete Beschreibung und mindestens ein Akzeptanzkriterium sind Pflicht')
    }
    const { data, error } = await db.from('ui_change_requests').insert({
      requested_by: actor.id,
      title,
      request_text: requestText,
      target_project: String(input.target_project || '').trim().slice(0, 200) || null,
      target_route: String(input.target_route || '').trim().slice(0, 300) || null,
      acceptance_criteria: criteria,
      evidence: { summary: String(input.evidence_summary || '').trim().slice(0, 3000) || null },
    }).select('*').single()
    if (error) throw new Error(error.message)
    await logAudit(actor.id, 'ui_change.request', 'ui_change_request', data.id, { title, target_project: data.target_project })
    return JSON.stringify({
      request: requestSummary(data),
      message: 'Die Anfrage wurde fuer den eigenen Account eingereicht. Ein Admin kann sie unter Administration → Freigaben verwalten.',
    })
  }

  if (name === 'ux_ui_list_my_requests') {
    const { data, error } = await db.from('ui_change_requests').select('*')
      .eq('requested_by', actor.id).order('created_at', { ascending: false }).limit(50)
    if (error) throw new Error(error.message)
    return JSON.stringify((data || []).map(requestSummary))
  }

  if (name === 'ux_ui_list_requests') {
    let query = db.from('ui_change_requests').select('*').order('created_at', { ascending: false })
      .limit(Math.min(Math.max(Number(input.limit) || 50, 1), 100))
    if (input.status) query = query.eq('status', input.status)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    return JSON.stringify((data || []).map(requestSummary))
  }

  if (name === 'ux_ui_manage_request') {
    const request = await adminRequest(input.request_id, actor.id)
    const status = String(input.status || '')
    if (!ADMIN_STATUSES.includes(status)) throw new Error('Ungueltiger Status')
    const result = { ...(request.result || {}) }
    if (input.verification?.trim()) result.verification = input.verification.trim().slice(0, 3000)
    if (status === 'completed' && (!result.merge_request_url || !result.verification)) {
      throw new Error('completed erfordert Merge-Request-Link und dokumentierte Verifikation')
    }
    const now = new Date().toISOString()
    const patch = {
      status,
      admin_notes: String(input.admin_notes || '').trim().slice(0, 5000) || request.admin_notes,
      reviewed_by: actor.id,
      reviewed_at: now,
      assigned_to: ['approved', 'implementing', 'completed'].includes(status) ? (request.assigned_to || actor.id) : request.assigned_to,
      result,
      ...(status === 'completed' ? { implemented_by: actor.id, implemented_at: now } : {}),
    }
    const { data, error } = await db.from('ui_change_requests').update(patch).eq('id', request.id).select('*').single()
    if (error) throw new Error(error.message)
    await logAudit(actor.id, `ui_change.${status}`, 'ui_change_request', request.id, { previous_status: request.status })
    return JSON.stringify(requestSummary(data))
  }

  const request = await adminRequest(input.request_id, actor.id, true)
  const project = await writableProject(input.project_id)
  const branch = safeBranch(input.branch_name, project.default_branch)

  if (name === 'gitlab_ui_create_branch') {
    const ref = String(input.ref || project.default_branch)
    const data = await gitlab(`/projects/${project.id}/repository/branches`, {
      method: 'POST', body: { branch, ref },
    })
    const result = { ...(request.result || {}), project_id: project.id, project: project.path_with_namespace, branch }
    await db.from('ui_change_requests').update({ status: 'implementing', assigned_to: actor.id, result }).eq('id', request.id)
    await logAudit(actor.id, 'ui_change.branch_create', 'ui_change_request', request.id, { project: project.path_with_namespace, branch })
    return JSON.stringify({ branch: data.name, project: project.path_with_namespace, web_url: data.web_url })
  }

  if (name === 'gitlab_ui_write_file') {
    const filePath = safeFilePath(input.file_path)
    const content = String(input.content || '')
    if (content.length > 400000) throw new Error('Datei ist fuer einen einzelnen sicheren Write zu gross')
    const encodedPath = encodeURIComponent(filePath)
    const existing = await gitlab(`/projects/${project.id}/repository/files/${encodedPath}`, {
      query: { ref: branch }, allow404: true,
    })
    const data = await gitlab(`/projects/${project.id}/repository/files/${encodedPath}`, {
      method: existing ? 'PUT' : 'POST',
      body: { branch, content, commit_message: String(input.commit_message || '').trim().slice(0, 240) },
    })
    await logAudit(actor.id, existing ? 'ui_change.file_update' : 'ui_change.file_create', 'ui_change_request', request.id, {
      project: project.path_with_namespace, branch, file_path: filePath,
    })
    return JSON.stringify({ action: existing ? 'updated' : 'created', file_path: filePath, branch, commit_id: data?.commit_id })
  }

  if (name === 'gitlab_ui_create_merge_request') {
    const mr = await gitlab(`/projects/${project.id}/merge_requests`, {
      method: 'POST',
      body: {
        source_branch: branch,
        target_branch: project.default_branch,
        title: String(input.title || '').trim().slice(0, 200),
        description: String(input.description || '').trim().slice(0, 10000),
        remove_source_branch: true,
        squash: true,
      },
    })
    const result = {
      ...(request.result || {}),
      project_id: project.id,
      project: project.path_with_namespace,
      branch,
      merge_request_iid: mr.iid,
      merge_request_url: mr.web_url,
    }
    await db.from('ui_change_requests').update({ status: 'implementing', assigned_to: actor.id, result }).eq('id', request.id)
    await logAudit(actor.id, 'ui_change.merge_request_create', 'ui_change_request', request.id, { mr_iid: mr.iid, url: mr.web_url })
    return JSON.stringify({ iid: mr.iid, title: mr.title, state: mr.state, web_url: mr.web_url, auto_merge: false })
  }

  throw new Error(`Unbekanntes UX/UI-Tool: ${name}`)
}
