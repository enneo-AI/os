// GitLab read-only Connector (REST v4, PAT mit read_api Scope).
// Base-URL + Token kommen aus Env — nie im Repo.

const BASE = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/$/, '')

async function gl(path, params = {}) {
  const url = new URL(`${BASE}/api/v4${path}`)
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v))
  const res = await fetch(url, {
    headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN || '' },
  })
  if (!res.ok) throw new Error(`GitLab ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json()
}

export const gitlabToolDefinitions = [
  {
    name: 'gitlab_search_projects',
    description: 'Sucht GitLab-Projekte (Repos) im enneo-GitLab nach Name.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Projektname oder Teil davon' } },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'gitlab_search_code',
    description:
      'Durchsucht den Code eines Projekts (blobs-Suche). Nutze das, um herauszufinden, WO etwas implementiert ist.',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer', description: 'Numerische Projekt-ID aus gitlab_search_projects' },
        query: { type: 'string', description: 'Suchbegriff (Funktionsname, String, Config-Key)' },
      },
      required: ['project_id', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'gitlab_read_file',
    description: 'Liest eine Datei aus einem GitLab-Projekt (Default-Branch, außer ref angegeben).',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer' },
        file_path: { type: 'string', description: 'Pfad im Repo, z.B. "src/app/main.py"' },
        ref: { type: 'string', description: 'Branch oder Commit (optional)' },
      },
      required: ['project_id', 'file_path'],
      additionalProperties: false,
    },
  },
  {
    name: 'gitlab_list_merge_requests',
    description: 'Listet die neuesten Merge Requests eines Projekts (Titel, Status, Autor).',
    input_schema: {
      type: 'object',
      properties: {
        project_id: { type: 'integer' },
        state: { type: 'string', enum: ['opened', 'merged', 'closed', 'all'] },
      },
      required: ['project_id'],
      additionalProperties: false,
    },
  },
]

export async function runGitlabTool(name, input) {
  if (!process.env.GITLAB_TOKEN) {
    return 'GitLab ist noch nicht verbunden (GITLAB_TOKEN fehlt). Sag dem Nutzer, dass der Connector noch konfiguriert werden muss.'
  }

  if (name === 'gitlab_search_projects') {
    const data = await gl('/projects', {
      search: input.query,
      simple: true,
      per_page: 10,
      order_by: 'last_activity_at',
    })
    return JSON.stringify(
      data.map((p) => ({ id: p.id, path: p.path_with_namespace, description: p.description }))
    )
  }

  if (name === 'gitlab_search_code') {
    const data = await gl(`/projects/${input.project_id}/search`, {
      scope: 'blobs',
      search: input.query,
      per_page: 10,
    })
    return JSON.stringify(
      data.map((b) => ({ path: b.path, startline: b.startline, data: b.data?.slice(0, 500) }))
    )
  }

  if (name === 'gitlab_read_file') {
    const encoded = encodeURIComponent(input.file_path)
    const params = { ref: input.ref || 'HEAD' }
    const data = await gl(`/projects/${input.project_id}/repository/files/${encoded}`, params)
    const content = Buffer.from(data.content, 'base64').toString('utf8')
    return content.length > 50000 ? content.slice(0, 50000) + '\n\n[... gekürzt]' : content
  }

  if (name === 'gitlab_list_merge_requests') {
    const data = await gl(`/projects/${input.project_id}/merge_requests`, {
      state: input.state || 'opened',
      per_page: 10,
      order_by: 'updated_at',
    })
    return JSON.stringify(
      data.map((mr) => ({
        iid: mr.iid,
        title: mr.title,
        state: mr.state,
        author: mr.author?.name,
        updated_at: mr.updated_at,
      }))
    )
  }

  throw new Error(`Unbekanntes GitLab-Tool: ${name}`)
}
