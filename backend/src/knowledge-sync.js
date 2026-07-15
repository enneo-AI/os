import crypto from 'node:crypto'
import { db } from './db.js'
import { reindexPage } from './tools/wiki.js'
import { logAudit } from './audit.js'

const SIX_HOURS = 6 * 60 * 60 * 1000
const running = new Set()

const hash = (value) => crypto.createHash('sha256').update(value || '').digest('hex')
const slugForUrl = (url) => {
  const path = new URL(url).pathname.replace(/^\/de\//, '').replace(/^\/+|\/+$/g, '') || 'start'
  return `product-docs/${path.replace(/\//g, '__').replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}`.slice(0, 240)
}

function parseGermanDocs(raw) {
  const pages = []
  const pagePattern = /## ([^\n]+)\n\n\*\*URL:\*\* (https:\/\/docs\.enneo\.ai\/de\/[^\s]+)\n(?:\*\*Description:\*\*[^\n]*\n)?\n([\s\S]*?)(?=\n---\n\n## [^\n]+\n\n\*\*URL:\*\*|$)/g
  for (const match of raw.matchAll(pagePattern)) {
    const [, title, url, body] = match
    pages.push({ title: title.trim(), url: url.trim(), content: `# ${title.trim()}\n\n> Quelle: ${url.trim()}\n\n${body.trim()}` })
  }
  return pages
}

async function syncDocs(source) {
  const response = await fetch(source.source_url, { headers: { 'User-Agent': 'enneo-os-knowledge-sync/1.0' } })
  if (!response.ok) throw new Error(`Dokumentation ${response.status}`)
  const raw = await response.text()
  const pages = parseGermanDocs(raw)
  const [{ data: tracked }, { data: legacy }, { data: companySpace }] = await Promise.all([
    db.from('knowledge_source_documents').select('*').eq('source_id', source.id),
    db.from('wiki_pages').select('id, slug, title, content').like('slug', 'product-docs/%'),
    db.from('spaces').select('id').eq('name', 'Company Data').maybeSingle(),
  ])
  const trackedByKey = new Map((tracked || []).map((row) => [row.source_key, row]))
  const legacyByUrl = new Map((legacy || []).filter((row) => /^https:\/\//.test(row.title || '')).map((row) => [row.title, row]))
  const legacyBySlug = new Map((legacy || []).map((row) => [row.slug, row]))
  const changed = pages.filter((page) => {
    const trackedRow = trackedByKey.get(page.url)
    if (trackedRow) return trackedRow.content_hash !== hash(page.content)
    return true // bestehende Legacy-Seite einmal sauber der Quelle zuordnen und re-indexieren
  })
  const limit = Math.max(1, Math.min(Number(source.config?.new_pages_per_run || 20), 50))
  let processed = 0
  for (const page of changed.slice(0, limit)) {
    const trackedRow = trackedByKey.get(page.url)
    const old = trackedRow?.wiki_page_id
      ? (legacy || []).find((row) => row.id === trackedRow.wiki_page_id)
      : legacyByUrl.get(page.url) || legacyBySlug.get(slugForUrl(page.url))
    const payload = {
      slug: old?.slug || slugForUrl(page.url),
      title: page.title,
      content: page.content,
      space_id: companySpace?.id || null,
      visibility: 'team',
      updated_by: source.created_by || null,
      ...(old ? {} : { created_by: source.created_by || null }),
    }
    const { data: wiki, error } = await db
      .from('wiki_pages')
      .upsert(payload, { onConflict: 'slug' })
      .select('id, slug, title, content')
      .single()
    if (error) throw new Error(error.message)
    await reindexPage(wiki)
    await db.from('knowledge_source_documents').upsert({
      source_id: source.id,
      source_key: page.url,
      source_url: page.url,
      content_hash: hash(page.content),
      wiki_page_id: wiki.id,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'source_id,source_key' })
    processed++
  }
  return { seen: pages.length, changed: processed, remaining: Math.max(0, changed.length - processed), contentHash: hash(raw) }
}

async function gitlab(path, params = {}) {
  const base = (process.env.GITLAB_BASE_URL || 'https://gitlab.com').replace(/\/$/, '')
  const url = new URL(`${base}/api/v4${path}`)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value))
  const response = await fetch(url, { headers: { 'PRIVATE-TOKEN': process.env.GITLAB_TOKEN || '' } })
  if (!response.ok) throw new Error(`GitLab ${response.status}: ${(await response.text()).slice(0, 180)}`)
  return response.json()
}

async function syncMergeRequests(source) {
  if (!process.env.GITLAB_TOKEN) throw new Error('GITLAB_TOKEN fehlt')
  const projectPath = source.config?.project_path || 'enneo/enneo'
  const project = await gitlab(`/projects/${encodeURIComponent(projectPath)}`)
  const days = Math.max(7, Math.min(Number(source.config?.lookback_days || 90), 365))
  const updatedAfter = new Date(Date.now() - days * 86400000).toISOString()
  const rows = await gitlab(`/projects/${project.id}/merge_requests`, {
    state: 'merged', order_by: 'updated_at', sort: 'desc', per_page: 100, updated_after: updatedAfter,
  })
  let added = 0
  for (const mr of rows) {
    if (!mr.merged_at) continue
    const content = `${mr.title}\n${mr.description || ''}\n${mr.web_url}`
    const { data: existing } = await db
      .from('release_entries').select('content_hash').eq('source_id', source.id).eq('external_id', `mr:${mr.iid}`).maybeSingle()
    if (!existing || existing.content_hash !== hash(content)) added++
    const { error } = await db.from('release_entries').upsert({
      source_id: source.id,
      external_id: `mr:${mr.iid}`,
      title: mr.title,
      summary: String(mr.description || '').trim().slice(0, 1200),
      source_url: mr.web_url,
      author: mr.author?.name || null,
      published_at: mr.merged_at,
      content_hash: hash(content),
    }, { onConflict: 'source_id,external_id' })
    if (error) throw new Error(error.message)
  }
  return { seen: rows.length, changed: 0, entriesAdded: added, contentHash: hash(JSON.stringify(rows.map((r) => [r.iid, r.updated_at]))) }
}

export async function syncKnowledgeSource(sourceId, actorId = null) {
  if (running.has(sourceId)) return { ok: false, error: 'Synchronisierung läuft bereits' }
  running.add(sourceId)
  const { data: source } = await db.from('knowledge_sources').select('*').eq('id', sourceId).maybeSingle()
  if (!source) { running.delete(sourceId); throw new Error('Quelle nicht gefunden') }
  const { data: run } = await db.from('knowledge_sync_runs').insert({ source_id: source.id, status: 'running' }).select('id').single()
  try {
    const result = source.kind === 'docs_full' ? await syncDocs(source) : await syncMergeRequests(source)
    await Promise.all([
      db.from('knowledge_sources').update({
        last_synced_at: new Date().toISOString(), last_content_hash: result.contentHash, last_error: null,
      }).eq('id', source.id),
      db.from('knowledge_sync_runs').update({
        status: 'success', documents_seen: result.seen || 0, documents_changed: result.changed || 0,
        entries_added: result.entriesAdded || 0, finished_at: new Date().toISOString(),
      }).eq('id', run.id),
    ])
    if (actorId) await logAudit(actorId, 'knowledge_source.sync', 'knowledge_source', source.id, result)
    return { ok: true, ...result }
  } catch (error) {
    await Promise.all([
      db.from('knowledge_sources').update({ last_synced_at: new Date().toISOString(), last_error: error.message.slice(0, 500) }).eq('id', source.id),
      db.from('knowledge_sync_runs').update({ status: 'failed', error: error.message.slice(0, 1000), finished_at: new Date().toISOString() }).eq('id', run.id),
    ])
    throw error
  } finally {
    running.delete(sourceId)
  }
}

export async function syncAllKnowledgeSources() {
  const { data: sources } = await db.from('knowledge_sources').select('*').eq('enabled', true)
  for (const source of sources || []) {
    try { await syncKnowledgeSource(source.id) }
    catch (error) { console.error(`Knowledge-Sync "${source.name}" fehlgeschlagen:`, error.message) }
  }
}

export async function releaseNotesPromptBlock(days = 30) {
  const since = new Date(Date.now() - days * 86400000).toISOString()
  const { data } = await db.from('release_entries').select('title, summary, source_url, author, published_at').gte('published_at', since).order('published_at', { ascending: false }).limit(40)
  if (!data?.length) return null
  return '# Aktuelle Enneo-Produktänderungen\n' + data.map((entry) =>
    `- ${entry.published_at.slice(0, 10)} · ${entry.title}${entry.author ? ` · ${entry.author}` : ''}${entry.summary ? `\n  ${entry.summary.replace(/\s+/g, ' ').slice(0, 220)}` : ''}${entry.source_url ? `\n  Quelle: ${entry.source_url}` : ''}`
  ).join('\n')
}

export function startKnowledgeSyncTicker() {
  setTimeout(() => syncAllKnowledgeSources().catch(console.error), 15000)
  setInterval(() => syncAllKnowledgeSources().catch(console.error), SIX_HOURS)
  console.log('Knowledge-Sync gestartet (6h-Intervall)')
}
