import express from 'express'
import cors from 'cors'
import { randomBytes } from 'node:crypto'
import { db, getUserFromRequest } from './db.js'
import { runEnniTurn, ALLOWED_MODELS, generateTitle, decideThreadReply, availableToolDefinitions } from './agent.js'
import { attachmentsToBlocks, attachmentMeta } from './attachments.js'
import { logUsage } from './usage.js'
import { startRoutineTicker, runRoutine } from './routines.js'
import { startKnowledgeSyncTicker, syncKnowledgeSource } from './knowledge-sync.js'
import { logAudit } from './audit.js'
import { getAttioRecordSummary, hasAttioConnection, searchAttioRecords } from './tools/attio.js'
import {
  createNotification, createNotifications, notifyPodMentions, notifyPodThreadReply, pushPublicKey, startPushTicker,
} from './notifications.js'
import { loadSkillWithContexts, savePersonalContext } from './contexts.js'
import { podContextPrompt } from './pod-context.js'

const app = express()
app.use(express.json({ limit: '30mb' })) // Anhänge kommen als Base64 im Body
app.use(
  cors({
    origin: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(','),
  })
)

app.get('/health', async (_req, res) => {
  let pdf = 'ok'
  try {
    const { chromiumInfo } = await import('./pdf.js')
    pdf = chromiumInfo()
  } catch (err) {
    pdf = err.message
  }
  res.json({ ok: true, pdf })
})

// Visueller Tool-Picker im Skill-Editor. Liefert nur Namen/Beschreibungen, keine
// Schemas oder Credentials; Sichtbarkeit dynamischer Connectoren ist user-scoped.
app.get('/api/tools/catalog', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const definitions = await availableToolDefinitions(user.id)
  const seen = new Set()
  const tools = definitions
    .filter((tool) => tool?.name && !seen.has(tool.name) && seen.add(tool.name))
    .map((tool) => ({ name: tool.name, description: tool.description || '' }))
  res.json({ tools })
})

app.put('/api/me/personal-context', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const context = await savePersonalContext(user.id, req.body || {})
    await logAudit(user.id, 'context.personal.update', 'context', context.id, { source: context.source })
    res.json({ context })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

// Von Enni erstellte Dateien inline ausliefern (Supabase Storage serviert HTML
// als text/plain, Anti-XSS). Autorisierung steckt in der Storage-Signed-URL selbst —
// wir akzeptieren ausschließlich Signed-URLs unseres eigenen generated-files-Buckets.
app.get('/files', async (req, res) => {
  const u = String(req.query.u || '')
  const allowedPrefix = `${process.env.SUPABASE_URL}/storage/v1/object/sign/generated-files/`
  if (!u.startsWith(allowedPrefix)) return res.status(400).send('Ungültiger Datei-Link')
  try {
    const r = await fetch(u)
    if (!r.ok) return res.status(r.status).send('Datei-Link abgelaufen oder ungültig')
    const name = decodeURIComponent(u.split('?')[0].split('/').pop() || 'datei')
    const { MIME } = await import('./tools/files.js')
    const ext = name.split('.').pop()
    res.setHeader('Content-Type', MIME[ext] || 'application/octet-stream')
    res.setHeader('Content-Disposition', `inline; filename="${name.replace(/"/g, '')}"`)
    res.send(Buffer.from(await r.arrayBuffer()))
  } catch (err) {
    res.status(500).send(`Auslieferung fehlgeschlagen: ${err.message}`)
  }
})

// Pod-Inhalte sind nur für Ersteller oder akzeptierte Mitglieder zugänglich.
// `open` macht den Pod auffindbar, erteilt aber keinen Datenzugriff.
async function podIfVisible(podId, userId) {
  const { data: pod } = await db.from('pods').select('*').eq('id', podId).maybeSingle()
  if (!pod) return null
  if (pod.created_by === userId) return pod
  const { data: member } = await db
    .from('pod_members').select('user_id').eq('pod_id', podId).eq('user_id', userId).maybeSingle()
  if (member) return pod
  return null
}

async function podAttioAccess(podId, userId) {
  const pod = await podIfVisible(podId, userId)
  if (!pod) return null
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  return { pod, canManage: pod.created_by === userId || !!profile?.is_admin }
}

async function podAttioState(podId) {
  const [{ data: link }, { data: related }] = await Promise.all([
    db.from('pod_attio_links').select('*').eq('pod_id', podId).maybeSingle(),
    db.from('pod_attio_related_records').select('*').eq('pod_id', podId).order('linked_at'),
  ])
  return { link: link || null, related: related || [] }
}

function attioSnapshot(record) {
  return {
    object: record.object,
    record_id: record.record_id,
    name: record.name,
    secondary: record.secondary,
    domain: record.domain,
    email: record.email,
    web_url: record.web_url,
  }
}

async function podAttioPrompt(podId) {
  const { link, related } = await podAttioState(podId)
  if (!link) return ''
  const relatedLine = related.length
    ? related.map((item) => `${item.attio_object === 'people' ? 'Kontakt' : 'Deal'}: ${item.record_name} (object=${item.attio_object}, record_id=${item.attio_record_id})`).join('; ')
    : 'Keine zusätzlichen Kontakte oder Deals verknüpft.'
  return `\n\n# Verknüpfter Attio-Kunde\nPrimärer Kunde: ${link.record_name}${link.record_domain ? ` (${link.record_domain})` : ''}. Attio: object=companies, record_id=${link.attio_record_id}${link.record_url ? `, web_url=${link.record_url}` : ''}.\n${relatedLine}\nDiese Verknüpfung ist die eindeutige Kundenidentität in diesem Pod. Suche nicht erneut nach dem Kundennamen. Lade nicht reflexhaft die gesamte CRM-Historie. Wenn die konkrete Anfrage Kundenhistorie, Verträge, E-Mails, Notizen, Meetings oder Transkripte braucht, verwende gezielt die read-only attio_-Tools mit den IDs oben. Für Meetings nutze linked_object=companies und linked_record_id=${link.attio_record_id}. Attio bleibt read-only.`
}

app.get('/api/pods/:id/attio', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const access = await podAttioAccess(req.params.id, user.id)
  if (!access) return res.status(404).json({ error: 'Pod nicht gefunden' })
  const [state, connected] = await Promise.all([podAttioState(req.params.id), hasAttioConnection(user.id)])
  res.json({ ...state, can_manage: access.canManage, connected })
})

app.get('/api/pods/:id/attio/search', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const access = await podAttioAccess(req.params.id, user.id)
  if (!access) return res.status(404).json({ error: 'Pod nicht gefunden' })
  if (!access.canManage) return res.status(403).json({ error: 'Nur Pod-Owner und Admins dürfen Verknüpfungen ändern.' })
  const object = String(req.query.object || 'companies')
  const query = String(req.query.q || '').trim()
  if (!query) return res.json({ records: [] })
  try {
    res.json({ records: await searchAttioRecords(user.id, object, query, 12) })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.put('/api/pods/:id/attio', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const access = await podAttioAccess(req.params.id, user.id)
  if (!access) return res.status(404).json({ error: 'Pod nicht gefunden' })
  if (!access.canManage) return res.status(403).json({ error: 'Nur Pod-Owner und Admins dürfen Verknüpfungen ändern.' })
  if (!req.body?.record_id) return res.status(400).json({ error: 'record_id fehlt' })
  try {
    const record = await getAttioRecordSummary(user.id, 'companies', req.body.record_id)
    const now = new Date().toISOString()
    const { data, error } = await db.from('pod_attio_links').upsert({
      pod_id: req.params.id,
      attio_object: 'companies',
      attio_record_id: record.record_id,
      record_name: record.name,
      record_domain: record.domain,
      record_url: record.web_url,
      snapshot: attioSnapshot(record),
      linked_by: user.id,
      linked_at: now,
      synced_at: now,
    }).select('*').single()
    if (error) throw error
    await logAudit(user.id, 'pod.attio.link', 'pod', req.params.id, { attio_record_id: record.record_id })
    res.json({ link: data })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/pods/:id/attio/sync', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const access = await podAttioAccess(req.params.id, user.id)
  if (!access) return res.status(404).json({ error: 'Pod nicht gefunden' })
  if (!access.canManage) return res.status(403).json({ error: 'Nur Pod-Owner und Admins dürfen synchronisieren.' })
  const state = await podAttioState(req.params.id)
  if (!state.link) return res.status(404).json({ error: 'Kein Attio-Kunde verknüpft' })
  try {
    const primary = await getAttioRecordSummary(user.id, 'companies', state.link.attio_record_id)
    const now = new Date().toISOString()
    const { error } = await db.from('pod_attio_links').update({
      record_name: primary.name,
      record_domain: primary.domain,
      record_url: primary.web_url,
      snapshot: attioSnapshot(primary),
      synced_at: now,
    }).eq('pod_id', req.params.id)
    if (error) throw error
    await Promise.all(state.related.map(async (item) => {
      const record = await getAttioRecordSummary(user.id, item.attio_object, item.attio_record_id)
      const { error: relatedError } = await db.from('pod_attio_related_records').update({
        record_name: record.name,
        record_detail: record.secondary,
        record_url: record.web_url,
        snapshot: attioSnapshot(record),
        synced_at: now,
      }).eq('id', item.id)
      if (relatedError) throw relatedError
    }))
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/pods/:id/attio', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const access = await podAttioAccess(req.params.id, user.id)
  if (!access) return res.status(404).json({ error: 'Pod nicht gefunden' })
  if (!access.canManage) return res.status(403).json({ error: 'Nur Pod-Owner und Admins dürfen Verknüpfungen ändern.' })
  const { error } = await db.from('pod_attio_links').delete().eq('pod_id', req.params.id)
  if (error) return res.status(400).json({ error: error.message })
  await logAudit(user.id, 'pod.attio.unlink', 'pod', req.params.id)
  res.json({ ok: true })
})

app.post('/api/pods/:id/attio/related', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const access = await podAttioAccess(req.params.id, user.id)
  if (!access) return res.status(404).json({ error: 'Pod nicht gefunden' })
  if (!access.canManage) return res.status(403).json({ error: 'Nur Pod-Owner und Admins dürfen Verknüpfungen ändern.' })
  const object = String(req.body?.object || '')
  if (!['people', 'deals'].includes(object) || !req.body?.record_id) return res.status(400).json({ error: 'Ungültiger Record' })
  try {
    const record = await getAttioRecordSummary(user.id, object, req.body.record_id)
    const { data, error } = await db.from('pod_attio_related_records').upsert({
      pod_id: req.params.id,
      attio_object: object,
      attio_record_id: record.record_id,
      record_name: record.name,
      record_detail: record.secondary,
      record_url: record.web_url,
      snapshot: attioSnapshot(record),
      linked_by: user.id,
      synced_at: new Date().toISOString(),
    }, { onConflict: 'pod_id,attio_object,attio_record_id' }).select('*').single()
    if (error) throw error
    res.json({ record: data })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.delete('/api/pods/:id/attio/related/:object/:recordId', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const access = await podAttioAccess(req.params.id, user.id)
  if (!access) return res.status(404).json({ error: 'Pod nicht gefunden' })
  if (!access.canManage) return res.status(403).json({ error: 'Nur Pod-Owner und Admins dürfen Verknüpfungen ändern.' })
  const { error } = await db.from('pod_attio_related_records').delete()
    .eq('pod_id', req.params.id).eq('attio_object', req.params.object).eq('attio_record_id', req.params.recordId)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ ok: true })
})

// Verlauf ab dem letzten Compaction-Anker aufbauen (Dust-Muster).
// In Pod-Konversationen werden User-Messages mit dem Autor-Namen geprefixt.
async function buildHistory(convId, isPod = false, threadRootId = null) {
  let query = db
    .from('messages')
    .select('role, content, author_id')
    .eq('conversation_id', convId)
    .order('created_at')
  query = threadRootId
    ? query.or(`id.eq.${threadRootId},thread_root_id.eq.${threadRootId}`)
    : query.is('thread_root_id', null)
  const { data: all } = await query
  const msgs = all || []
  let names = {}
  if (isPod) {
    const ids = [...new Set(msgs.map((m) => m.author_id).filter(Boolean))]
    if (ids.length) {
      const { data: profs } = await db.from('profiles').select('id, display_name, email').in('id', ids)
      names = Object.fromEntries((profs || []).map((p) => [p.id, p.display_name || p.email]))
    }
  }
  let lastCompaction = -1
  msgs.forEach((m, i) => { if (m.role === 'compaction') lastCompaction = i })
  const history = []
  if (lastCompaction >= 0) {
    history.push({
      role: 'user',
      content: `<gespraechszusammenfassung>\nDer bisherige Verlauf dieser Konversation wurde komprimiert. Zusammenfassung:\n\n${msgs[lastCompaction].content}\n</gespraechszusammenfassung>`,
    })
    history.push({ role: 'assistant', content: 'Verstanden — ich setze das Gespräch auf Basis dieser Zusammenfassung fort.' })
  }
  for (const m of msgs.slice(lastCompaction + 1)) {
    if ((m.role === 'user' || m.role === 'assistant') && m.content) {
      const prefix = isPod && m.role === 'user' && names[m.author_id] ? `${names[m.author_id]}: ` : ''
      history.push({ role: m.role, content: prefix + m.content })
    }
  }
  return history
}

// Konversations-Liste + Verlauf holt das Frontend direkt aus Supabase (RLS: owner-only).
// Das Backend braucht nur den Chat-Endpoint.

// Laufende Turns pro Konversation — Grundlage für den Stop-Button (POST /:id/stop).
// Ein Prozess pro Railway-Service, daher reicht eine In-Memory-Map.
const activeTurns = new Map() // convId -> AbortController

async function clearConversationRun(conversationId, conversationPatch = {}) {
  const { error: conversationError } = await db.from('conversations').update({ working: false, ...conversationPatch }).eq('id', conversationId)
  if (conversationError) throw conversationError
  const { error: runError } = await db.from('conversation_runs').delete().eq('conversation_id', conversationId)
  if (runError) throw runError
}

async function recoverStaleConversationRuns() {
  const cutoff = new Date(Date.now() - 10 * 60_000).toISOString()
  const { data: stale, error } = await db.from('conversation_runs').select('conversation_id').lt('updated_at', cutoff)
  if (error) return console.error('Stale Conversation-Runs konnten nicht geprüft werden:', error.message)
  for (const run of stale || []) {
    await clearConversationRun(run.conversation_id).catch((cleanupError) => {
      console.error('Stale Conversation-Run konnte nicht entfernt werden:', cleanupError.message)
    })
  }
}
setInterval(recoverStaleConversationRuns, 60_000).unref()

async function conversationIfVisible(conversationId, userId) {
  const { data: conversation } = await db
    .from('conversations')
    .select('id, user_id, pod_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (!conversation) return null
  if (conversation.pod_id) return (await podIfVisible(conversation.pod_id, userId)) ? conversation : null
  return conversation.user_id === userId ? conversation : null
}

app.post('/api/conversations/:id/stop', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const c = await conversationIfVisible(req.params.id, user.id)
  if (!c) return res.status(404).json({ error: 'Conversation nicht gefunden' })
  const ctl = activeTurns.get(c.id)
  if (!ctl) {
    // Kein laufender Turn in diesem Prozess (z.B. nach Restart hängengebliebenes Flag) → aufräumen
    await clearConversationRun(c.id)
    return res.json({ ok: true, running: false })
  }
  ctl.abort()
  res.json({ ok: true, running: true })
})

app.post('/api/conversations/:id/read', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const conversation = await conversationIfVisible(req.params.id, user.id)
  if (!conversation) return res.status(404).json({ error: 'Conversation nicht gefunden' })

  const now = new Date().toISOString()
  const { error: conversationError } = await db
    .from('conversations')
    .update({ unread: false })
    .eq('id', conversation.id)
  if (conversationError) return res.status(400).json({ error: conversationError.message })

  // Eine aktive Ansicht gewinnt gegen den Push-Ticker: noch nicht versendete
  // Benachrichtigungen werden gelesen + übersprungen, bereits versendete nur gelesen.
  const { error: pendingError } = await db
    .from('notifications')
    .update({ read_at: now, push_state: 'skipped', push_attempted_at: now })
    .eq('user_id', user.id)
    .eq('conversation_id', conversation.id)
    .is('read_at', null)
    .eq('push_state', 'pending')
  if (pendingError) return res.status(400).json({ error: pendingError.message })
  const { error: readError } = await db
    .from('notifications')
    .update({ read_at: now })
    .eq('user_id', user.id)
    .eq('conversation_id', conversation.id)
    .is('read_at', null)
  if (readError) return res.status(400).json({ error: readError.message })

  res.json({ ok: true, read_at: now })
})

app.post('/api/chat', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })

  const clientVersion = String(req.get('x-enneo-client-version') || '').slice(0, 120)
  if (!clientVersion) {
    // Tabs von vor dem Release-Guard funktionieren weiterhin, werden aber sichtbar:
    // So lässt sich ein Alt-Client künftig eindeutig von einem aktuellen UI-Bug trennen.
    logAudit(user.id, 'client.legacy_chat', 'frontend', null, {
      path: '/api/chat',
      user_agent: String(req.get('user-agent') || '').slice(0, 300),
    }).catch(() => {})
  }

  const { conversation_id, message, model, attachments, thread_root_id } = req.body || {}
  if (!message?.trim() && !attachments?.length) return res.status(400).json({ error: 'message fehlt' })
  if (model && !ALLOWED_MODELS.includes(model)) return res.status(400).json({ error: 'Unbekanntes Modell' })
  let fileBlocks = []
  let turnLocked = false
  try {
    fileBlocks = attachmentsToBlocks(attachments)
  } catch (err) {
    return res.status(400).json({ error: err.message })
  }

  // Conversation anlegen oder laden — eigene ODER sichtbare Pod-Konversation
  let convId = conversation_id
  let isNewConversation = !conversation_id
  let pod = null
  if (convId) {
    const { data } = await db
      .from('conversations')
      .select('id, user_id, pod_id')
      .eq('id', convId)
      .maybeSingle()
    if (!data) return res.status(404).json({ error: 'Conversation nicht gefunden' })
    if (data.pod_id) {
      pod = await podIfVisible(data.pod_id, user.id)
      if (!pod) return res.status(404).json({ error: 'Kein Zugriff auf diesen Pod' })
    } else if (data.user_id !== user.id) {
      return res.status(404).json({ error: 'Conversation nicht gefunden' })
    }
  } else {
    if (req.body.pod_id) {
      pod = await podIfVisible(req.body.pod_id, user.id)
      if (!pod) return res.status(404).json({ error: 'Kein Zugriff auf diesen Pod' })
    }
    const { data, error } = await db
      .from('conversations')
      .insert({ user_id: user.id, title: (message || '').slice(0, 80), pod_id: pod?.id || null })
      .select('id')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    convId = data.id
  }

  // Ein Thread verweist immer auf eine Root-Nachricht derselben Pod-Konversation.
  // Die Datenbank validiert das zusätzlich per Trigger.
  let threadRoot = null
  let priorThreadMessages = []
  if (thread_root_id) {
    if (!pod) return res.status(400).json({ error: 'Threads sind nur in Pods verfügbar' })
    const { data: root } = await db.from('messages').select('id, conversation_id, thread_root_id, role, content, author_id')
      .eq('id', thread_root_id).maybeSingle()
    if (!root || root.conversation_id !== convId || root.thread_root_id || root.role !== 'user') {
      return res.status(400).json({ error: 'Ungültige Thread-Hauptnachricht' })
    }
    threadRoot = root
    const { data: rows } = await db.from('messages').select('role, content, author_id, created_at')
      .eq('thread_root_id', thread_root_id).order('created_at')
    priorThreadMessages = rows || []
  }

  // Verlauf ab letztem Compaction-Anker laden und User-Message persistieren.
  // Datei-Inhalte gehen nur in DIESEM Turn ans Modell; im Verlauf bleibt ein Text-Marker.
  const prior = await buildHistory(convId, !!pod, thread_root_id || null)
  const meta = attachmentMeta(attachments)
  const storedText = meta.length
    ? `${message || ''}\n\n[Angehängte Dateien: ${meta.map((m) => m.name).join(', ')}]`.trim()
    : message
  const { data: userMessage, error: userMessageError } = await db.from('messages').insert({
    conversation_id: convId,
    role: 'user',
    content: storedText,
    attachments: meta.length ? meta : null,
    author_id: user.id,
    thread_root_id: thread_root_id || null,
  }).select('id').single()
  if (userMessageError) return res.status(500).json({ error: userMessageError.message })
  if (pod) {
    try {
      const mentionNotifications = await notifyPodMentions({
        pod, actorId: user.id, messageId: userMessage.id, conversationId: convId,
        threadRootId: thread_root_id || null, text: message,
      })
      if (thread_root_id) await notifyPodThreadReply({
        pod, actorId: user.id, messageId: userMessage.id, conversationId: convId,
        threadRootId: thread_root_id, text: message,
        excludeUserIds: mentionNotifications.map((item) => item.user_id),
      })
    } catch (error) {
      console.error('Mention-Benachrichtigung fehlgeschlagen:', error.message)
    }
  }
  const turnContent = fileBlocks.length
    ? [...fileBlocks, { type: 'text', text: message || 'Bitte analysiere die angehängten Dateien.' }]
    : message
  const history = [...prior, { role: 'user', content: turnContent }]

  // SSE-Stream öffnen
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  // Multi-Session: der Client darf wegnavigieren/schließen — der Turn läuft serverseitig
  // weiter und persistiert. res.write nach Disconnect darf den Loop nicht crashen.
  // Zusätzlich spiegelt der Progress-Broadcaster den Fortschritt über Supabase Realtime,
  // damit ein Wiedereinstieg mittendrin die aktuellen Gedanken live sieht.
  const { createProgressBroadcaster } = await import('./progress.js')
  const progress = createProgressBroadcaster(convId)
  const emit = (event) => {
    try {
      res.write(`data: ${JSON.stringify(event)}\n\n`)
    } catch { /* Client weg — Turn läuft weiter, Ergebnis landet in der DB */ }
    try {
      progress.take(event)
    } catch { /* Broadcast ist Best-Effort */ }
  }
  emit({ type: 'conversation', conversation_id: convId })

  // Auto-Titel läuft PARALLEL zum Turn: Haiku (günstigstes Modell) analysiert die erste
  // Nachricht und formt einen Titel mit 1-5 Wörtern — nicht die Nachricht selbst als Titel.
  const titlePromise =
    isNewConversation && message?.trim()
      ? generateTitle(message).catch((err) => {
          console.error('auto-title failed:', err.message)
          return null
        })
      : null

  try {
    // Pod-Konversationen sind Team-Chat: Enni antwortet NUR, wenn er mit @enni erwähnt wird.
    // Ohne Erwähnung wird die Nachricht nur persistiert (Team-Nachricht, kein LLM-Call).
    // Ausnahme: ein Slash-Skill-Aufruf (/health-check …) richtet sich immer an Enni —
    // unabhängig davon, ob er am Satzanfang oder mitten in der Nachricht steht.
    const slashMatch = (message || '').match(/(?:^|\s)\/([a-z0-9][a-z0-9-]*)\b/i)
    const enniMentioned = /@enni\b/i.test(message || '') || !!slashMatch
    const threadWasActive = !!threadRoot && (
      /@enni\b/i.test(threadRoot.content || '') ||
      /(?:^|\s)\/[a-z0-9][a-z0-9-]*\b/i.test(threadRoot.content || '') ||
      priorThreadMessages.some((item) => item.role === 'assistant')
    )
    let shouldReply = enniMentioned
    let decisionCost = 0
    if (pod && threadRoot && !shouldReply && threadWasActive) {
      const authorIds = [...new Set(priorThreadMessages.map((item) => item.author_id).filter(Boolean))]
      const { data: authors } = authorIds.length
        ? await db.from('profiles').select('id, display_name, email').in('id', authorIds)
        : { data: [] }
      const names = Object.fromEntries((authors || []).map((item) => [item.id, item.display_name || item.email]))
      try {
        const decision = await decideThreadReply({
          root: threadRoot.content,
          replies: priorThreadMessages.map((item) => ({ ...item, author: item.role === 'assistant' ? 'Enni' : names[item.author_id] })),
          latest: message || '[Datei angehängt]',
          senderName: user.user_metadata?.full_name || user.email,
        })
        shouldReply = decision.respond
        decisionCost = await logUsage({
          userId: user.id, conversationId: convId, messageId: userMessage.id,
          model: decision.model, usage: decision.usage, source: 'thread_decision',
        })
      } catch (error) {
        console.error('Thread-Entscheidung fehlgeschlagen:', error.message)
        shouldReply = false
      }
    }
    const responseThreadRootId = pod && shouldReply ? (thread_root_id || userMessage.id) : null
    // Frontends von vor dem Thread-DOM-Fix würden beim Umbau der optimistischen
    // Nachricht mit HierarchyRequestError abbrechen. Für diese bereits geöffneten
    // Tabs das UI-only Event auslassen; Persistenz und Enni-Antwort bleiben normal,
    // beim nächsten Laden rendert die DB-Historie den Thread korrekt.
    if (pod && clientVersion) emit({
      type: 'thread_context',
      user_message_id: userMessage.id,
      thread_root_id: thread_root_id || userMessage.id,
      is_thread_reply: !!thread_root_id,
      enni_active: threadWasActive || enniMentioned,
      reply_expected: shouldReply,
    })
    if (pod && !shouldReply) {
      if (titlePromise) {
        const t = await titlePromise
        if (t?.title) {
          await db.from('conversations').update({ title: t.title }).eq('id', convId)
          await logUsage({ userId: user.id, conversationId: convId, messageId: null, model: t.model, usage: t.usage })
          emit({ type: 'title', title: t.title })
        }
      }
      await db.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId)
      emit({ type: 'done', message_id: null, cost_eur: decisionCost, team_message: true, thread_observed: !!threadRoot })
      progress.close()
      res.end()
      return
    }

    // Pod-Kontext: Instructions for Agents + Absender-Attribution + Pod-Tools-Hinweis
    let extraSystem = null
    if (pod) {
      const senderName = user.user_metadata?.full_name || user.email
      extraSystem =
        `Diese Konversation läuft im Pod "${pod.name}" — ein geteilter Projekt-Raum (Team-Chat, mehrere Personen lesen und schreiben mit). ` +
        `${threadRoot ? 'Du antwortest innerhalb eines Threads. Enni wurde für diesen Thread aktiviert und prüft Folgeantworten automatisch; antworte nur, wenn dein Beitrag jetzt wirklich hilfreich ist. ' : 'Du wurdest gerade mit @enni gerufen. '}Die aktuelle Nachricht kommt von ${senderName}. User-Nachrichten sind mit dem Absender-Namen geprefixt. ` +
        `Du hast Zugriff auf den GESAMTEN Pod über die pod_-Tools: Aufgabenliste (pod_list_tasks), geteilte Dateien (pod_list_files / pod_read_file), Notizen und Meeting-Transkripte (pod_list_notes / pod_read_note) sowie die anderen Konversationen (pod_list_conversations / pod_read_conversation). Nutze sie, wenn die Frage Pod-Kontext braucht. Liste Notizen zuerst und lade lange Transkripte nur gezielt, wenn sie für die Frage relevant sind.` +
        (pod.description ? `\nPod-Beschreibung: ${pod.description}` : '')
      extraSystem += await podContextPrompt(pod)
      extraSystem += await podAttioPrompt(pod.id)
    }
    // Slash-Command: /slug an einer beliebigen Wortposition ruft einen Skill explizit auf —
    // voller Skill geht als System-Block mit, Enni startet mit einem Workflow-Overview.
    if (slashMatch) {
      const skill = await loadSkillWithContexts(slashMatch[1].toLowerCase(), user.id)
      // Persönliche Skills gelten nur für ihren Ersteller (team-weite für alle)
      const visibleRequiredCount = (skill?.skill_contexts || []).filter((link) => link.requirement === 'required').length
      if (skill?.enabled && visibleRequiredCount === skill.required_context_count && (skill.visibility === 'team' || skill.created_by === user.id)) {
        const { skillText } = await import('./tools/skills.js')
        extraSystem =
          (extraSystem ? extraSystem + '\n\n' : '') +
          `Der Nutzer hat den Skill /${skill.slug} explizit per Slash-Command aufgerufen. Vollständiger Skill:\n\n${skillText(skill, user.id)}\n\nBeginne deine Antwort mit einem kompakten Workflow-Overview (nummerierte Schritte, je eine Zeile — was du jetzt tun wirst), dann arbeite den Workflow ab. Fehlen dir dafür nötige Inputs, stelle GENAU EINE gebündelte Rückfrage nach allen fehlenden Angaben.`
      }
    }

    // Multi-Session-Lock: pro Konversation nur EIN laufender Turn. Atomar via
    // UPDATE … WHERE working=false — verlieren beide gleichzeitig, gewinnt genau einer.
    const turnStartedIso = new Date().toISOString()
    const { data: lock } = await db
      .from('conversations')
      .update({ working: true })
      .eq('id', convId)
      .eq('working', false)
      .select('id')
    if (!lock?.length) {
      emit({ type: 'error', message: 'Enni arbeitet in dieser Konversation gerade an einer anderen Nachricht — kurz warten, deine Nachricht ist gespeichert.' })
      progress.close()
      res.end()
      return
    }
    turnLocked = true
    progress.start({
      podId: pod?.id || null,
      threadRootId: responseThreadRootId,
      userMessageId: userMessage.id,
      startedAt: turnStartedIso,
    })

    let result
    const abortCtl = new AbortController()
    activeTurns.set(convId, abortCtl)
    const turnStarted = Date.now()
    try {
      result = await runEnniTurn(history, emit, model, extraSystem, {
        userId: user.id,
        conversationId: convId,
        podId: pod?.id || null,
        signal: abortCtl.signal,
      })
    } catch (err) {
      throw err
    } finally {
      activeTurns.delete(convId)
    }
    const durationMs = Date.now() - turnStarted

    // Assistant-Message inkl. Gedankenkette + Tool-Calls persistieren. Selbst wenn
    // ein Provider künftig wider Erwarten leer zurückkommt, landet nie wieder eine
    // leere Enni-Nachricht im Verlauf.
    const persistedAssistantText = result.text?.trim() || (result.aborted
      ? '_Gestoppt._'
      : 'Dieser Arbeitslauf wurde ohne vollständige Abschlussantwort beendet. Bitte sende den noch offenen Teil erneut.')
    const { data: msg } = await db
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: persistedAssistantText,
        thinking: result.thinking || null,
        tool_calls: result.toolCalls.length ? result.toolCalls : null,
        duration_ms: durationMs,
        thread_root_id: responseThreadRootId,
      })
      .select('id')
      .single()

    const cost = await logUsage({
      userId: user.id,
      conversationId: convId,
      messageId: msg?.id,
      model: result.model,
      usage: result.usage,
    })
    if (msg?.id) {
      const skillEvents = []
      for (const slug of result.autoSkills || []) skillEvents.push({ slug, mode: 'auto' })
      if (slashMatch?.[1]) skillEvents.push({ slug: slashMatch[1].toLowerCase(), mode: 'explicit' })
      for (const call of result.toolCalls || []) {
        if (call.name === 'skill_read' && call.input?.slug) skillEvents.push({ slug: String(call.input.slug).replace(/^\//, '').toLowerCase(), mode: 'tool' })
      }
      const uniqueEvents = [...new Map(skillEvents.map((event) => [`${event.slug}:${event.mode}`, event])).values()]
      if (uniqueEvents.length) {
        const { error: skillUsageError } = await db.from('skill_usage_events').upsert(
          uniqueEvents.map((event) => ({ user_id: user.id, conversation_id: convId, message_id: msg.id, skill_slug: event.slug, mode: event.mode })),
          { onConflict: 'message_id,skill_slug,mode', ignoreDuplicates: true }
        )
        if (skillUsageError) console.error('Skill-Usage konnte nicht gespeichert werden:', skillUsageError.message)
      }
    }
    // unread=true → grüner Sidebar-Punkt; der Client löscht es sofort, wenn er live zuschaut
    await progress.close()
    await clearConversationRun(convId, { updated_at: new Date().toISOString(), unread: true })
    turnLocked = false

    if (!result.aborted) {
      try {
        await createNotification({
          user_id: user.id,
          type: 'agent_complete',
          pod_id: pod?.id || null,
          conversation_id: convId,
          message_id: msg?.id || null,
          title: 'Enni ist fertig',
          body: (result.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
          action_url: pod ? `/pod/${pod.id}?tab=convs&conversation=${convId}${responseThreadRootId ? `&thread=${responseThreadRootId}` : ''}` : `/chat/${convId}`,
          metadata: { duration_ms: durationMs },
        })
      } catch (error) {
        console.error('Enni-Fertig-Benachrichtigung fehlgeschlagen:', error.message)
      }
    }

    emit({ type: 'done', message_id: msg?.id, cost_eur: cost, usage: result.usage, duration_ms: durationMs, stopped: result.aborted || undefined })

    if (titlePromise) {
      const t = await titlePromise
      if (t?.title) {
        await db.from('conversations').update({ title: t.title }).eq('id', convId)
        await logUsage({ userId: user.id, conversationId: convId, messageId: msg?.id, model: t.model, usage: t.usage })
        emit({ type: 'title', title: t.title })
      }
    }
  } catch (err) {
    console.error('chat error:', err)
    if (turnLocked) {
      await progress.close()
      await clearConversationRun(convId).catch((cleanupError) => {
        console.error('Conversation-Run konnte nicht aufgeräumt werden:', cleanupError.message)
      })
      turnLocked = false
    }
    emit({ type: 'error', message: err.message })
  }
  progress.close()
  res.end()
})

app.post('/api/client-errors', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const payload = req.body || {}
  await logAudit(user.id, 'client.error', 'frontend', payload.conversation_id || null, {
    client_version: String(payload.client_version || req.get('x-enneo-client-version') || '').slice(0, 120),
    context: String(payload.context || '').slice(0, 120),
    message: String(payload.message || '').slice(0, 1000),
    stack: String(payload.stack || '').slice(0, 6000),
    path: String(payload.path || '').slice(0, 500),
    user_agent: String(req.get('user-agent') || '').slice(0, 300),
  })
  res.status(204).end()
})

// Kontext komprimieren (Dust-Muster): Zusammenfassung als compaction-Message einfügen
// Diktat: Speech-to-Text via ElevenLabs Scribe (scribe_v1) — versteht Deutsch und
// Englisch GEMISCHT in derselben Aufnahme (Code-Switching), was die Web Speech API
// nicht kann. Braucht ELEVENLABS_API_KEY als Railway-Env; ohne Key antwortet der
// Endpoint 503 und das Frontend fällt auf die Browser-Erkennung zurück.
app.post('/api/transcribe', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const key = process.env.ELEVENLABS_API_KEY
  if (!key) return res.status(503).json({ error: 'stt_unconfigured' })
  try {
    const { audio_base64, mime } = req.body || {}
    if (!audio_base64) return res.status(400).json({ error: 'audio_base64 fehlt' })
    const bytes = Buffer.from(audio_base64, 'base64')
    if (bytes.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'Audio größer als 15 MB' })
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: mime || 'audio/webm' }), 'audio.webm')
    form.append('model_id', 'scribe_v1')
    form.append('tag_audio_events', 'false')
    form.append('diarize', 'false')
    const r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: { 'xi-api-key': key },
      body: form,
    })
    const data = await r.json()
    if (!r.ok) throw new Error(data?.detail?.message || data?.detail || `ElevenLabs HTTP ${r.status}`)
    res.json({ text: data.text || '', language_code: data.language_code || null })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.post('/api/compact', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { conversation_id } = req.body || {}
  const { data: conv } = await db
    .from('conversations')
    .select('id, user_id, title')
    .eq('id', conversation_id)
    .maybeSingle()
  if (!conv || conv.user_id !== user.id) return res.status(404).json({ error: 'Conversation nicht gefunden' })

  const history = await buildHistory(conversation_id)
  if (history.length < 4) return res.status(400).json({ error: 'Zu wenig Verlauf zum Komprimieren' })

  try {
    const transcript = history
      .map((m) => `${m.role === 'user' ? 'Nutzer' : 'Enni'}: ${m.content}`)
      .join('\n\n')
    const { compactConversation } = await import('./agent.js')
    const { summary, usage, model } = await compactConversation(conv.title, transcript)

    const { data: msg } = await db
      .from('messages')
      .insert({ conversation_id, role: 'compaction', content: summary })
      .select('id')
      .single()
    const cost = await logUsage({
      userId: user.id,
      conversationId: conversation_id,
      messageId: msg?.id,
      model,
      usage,
    })
    res.json({ ok: true, summary, cost_eur: cost })
  } catch (err) {
    console.error('compact error:', err)
    res.status(500).json({ error: err.message })
  }
})

// Enneo-Write-Freigabe: Karte im Chat → hier passiert der echte API-Call (Audit via Tabelle)
app.post('/api/enneo-write/:id/approve', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { executeWriteProposal } = await import('./tools/enneo.js')
    res.json(await executeWriteProposal(req.params.id, user.id))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/enneo-write/:id/reject', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { rejectWriteProposal } = await import('./tools/enneo.js')
    res.json(await rejectWriteProposal(req.params.id, user.id))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Wissens-Update-Review — NUR Admins (Aleksas Vorgabe: Vorschläge werden gesammelt,
// der Admin geht sie regelmäßig durch; normale Nutzer können Enni nicht "schulen").
// Erst hier wird das Wiki wirklich geändert + RAG re-indexiert.
app.post('/api/knowledge-update/:id/approve', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try {
    const { applyKnowledgeUpdate } = await import('./tools/wiki.js')
    const result = await applyKnowledgeUpdate(req.params.id, user.id)
    await logAudit(user.id, 'knowledge_update.approve', 'knowledge_update', req.params.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/knowledge-update/:id/reject', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try {
    const { rejectKnowledgeUpdate } = await import('./tools/wiki.js')
    const result = await rejectKnowledgeUpdate(req.params.id, user.id)
    await logAudit(user.id, 'knowledge_update.reject', 'knowledge_update', req.params.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Connectors (MCP-Server verknüpfen) — nur Admins
async function requireAdmin(req, res) {
  const user = await getUserFromRequest(req)
  if (!user) {
    res.status(401).json({ error: 'Nicht eingeloggt' })
    return null
  }
  const { data: prof } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  if (!prof?.is_admin) {
    res.status(403).json({ error: 'Nur für Admins' })
    return null
  }
  return user
}

// ============================================================ Notifications + Web Push
app.get('/api/notifications', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50))
  let query = db.from('notifications').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(limit)
  if (req.query.filter === 'unread') query = query.is('read_at', null)
  const { data, error } = await query
  if (error) return res.status(400).json({ error: error.message })
  const actorIds = [...new Set((data || []).map((item) => item.actor_id).filter(Boolean))]
  const { data: actors } = actorIds.length
    ? await db.from('profiles').select('id, display_name, email, avatar_url').in('id', actorIds)
    : { data: [] }
  const actorMap = Object.fromEntries((actors || []).map((actor) => [actor.id, actor]))
  res.json({ notifications: (data || []).map((item) => ({ ...item, actor: actorMap[item.actor_id] || null })) })
})

app.post('/api/notifications/read-all', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { error } = await db.from('notifications').update({ read_at: new Date().toISOString() }).eq('user_id', user.id).is('read_at', null)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ ok: true })
})

app.post('/api/notifications/:id/read', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data, error } = await db.from('notifications').update({ read_at: new Date().toISOString() })
    .eq('id', req.params.id).eq('user_id', user.id).select('id').maybeSingle()
  if (error) return res.status(400).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Benachrichtigung nicht gefunden' })
  res.json({ ok: true })
})

app.get('/api/notifications/preferences', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  let { data, error } = await db.from('notification_preferences').select('*').eq('user_id', user.id).maybeSingle()
  if (!data && !error) {
    ;({ data, error } = await db.from('notification_preferences').insert({ user_id: user.id }).select('*').single())
  }
  if (error) return res.status(400).json({ error: error.message })
  res.json({ preferences: data })
})

app.put('/api/notifications/preferences', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const body = req.body || {}
  const mutedIds = [...new Set(Array.isArray(body.muted_pod_ids) ? body.muted_pod_ids.slice(0, 100) : [])]
  const visibleMuted = []
  for (const id of mutedIds) if (await podIfVisible(id, user.id)) visibleMuted.push(id)
  const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/
  const patch = {
    user_id: user.id,
    browser_push: !!body.browser_push,
    muted_pod_ids: visibleMuted,
    quiet_hours_enabled: !!body.quiet_hours_enabled,
    quiet_start: hhmm.test(body.quiet_start || '') ? body.quiet_start : '18:00',
    quiet_end: hhmm.test(body.quiet_end || '') ? body.quiet_end : '08:00',
    timezone: String(body.timezone || 'Europe/Berlin').slice(0, 80),
  }
  const { data, error } = await db.from('notification_preferences').upsert(patch).select('*').single()
  if (error) return res.status(400).json({ error: error.message })
  res.json({ preferences: data })
})

app.get('/api/push/public-key', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const key = pushPublicKey()
  if (!key) return res.status(503).json({ error: 'Browser-Push ist noch nicht konfiguriert.' })
  res.json({ public_key: key })
})

app.post('/api/push/subscribe', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const subscription = req.body?.subscription
  if (!subscription?.endpoint?.startsWith('https://') || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    return res.status(400).json({ error: 'Ungültiges Push-Abonnement' })
  }
  const { data: existingSubscription } = await db.from('push_subscriptions').select('user_id').eq('endpoint', subscription.endpoint).maybeSingle()
  if (existingSubscription && existingSubscription.user_id !== user.id) {
    return res.status(409).json({ error: 'Dieses Push-Abonnement gehört bereits zu einem anderen Account.' })
  }
  const { error } = await db.from('push_subscriptions').upsert({
    user_id: user.id,
    endpoint: subscription.endpoint,
    p256dh: subscription.keys.p256dh,
    auth: subscription.keys.auth,
    user_agent: String(req.headers['user-agent'] || '').slice(0, 500),
    enabled: true,
    failure_count: 0,
  }, { onConflict: 'endpoint' })
  if (error) return res.status(400).json({ error: error.message })
  await db.from('notification_preferences').upsert({ user_id: user.id, browser_push: true }, { onConflict: 'user_id' })
  res.json({ ok: true })
})

app.delete('/api/push/subscribe', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const endpoint = String(req.body?.endpoint || '')
  if (endpoint) await db.from('push_subscriptions').delete().eq('user_id', user.id).eq('endpoint', endpoint)
  await db.from('notification_preferences').upsert({ user_id: user.id, browser_push: false }, { onConflict: 'user_id' })
  res.json({ ok: true })
})

app.get('/api/admin/announcements', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const { data, error } = await db.from('system_announcements').select('*').order('published_at', { ascending: false }).limit(20)
  if (error) return res.status(400).json({ error: error.message })
  res.json({ announcements: data || [] })
})

app.get('/api/admin/impact', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const period = ['week', 'month', 'ytd', 'year', 'all'].includes(req.query.period) ? req.query.period : 'month'
  const now = new Date()
  let start = new Date(0)
  if (period === 'week') { start = new Date(now); start.setDate(now.getDate() - ((now.getDay() + 6) % 7)); start.setHours(0, 0, 0, 0) }
  if (period === 'month') start = new Date(now.getFullYear(), now.getMonth(), 1)
  if (period === 'ytd') start = new Date(now.getFullYear(), 0, 1)
  if (period === 'year') start = new Date(now.getTime() - 365 * 86400000)
  const since = start.toISOString()
  const [{ data: profiles }, { data: conversations }, { data: messages }, { data: skillEvents }] = await Promise.all([
    db.from('profiles').select('id, display_name, email').eq('account_status', 'active'),
    db.from('conversations').select('id, user_id'),
    db.from('messages').select('id, conversation_id, role, tool_calls, created_at').eq('role', 'assistant').gte('created_at', since).limit(10000),
    db.from('skill_usage_events').select('user_id, skill_slug, mode, created_at').gte('created_at', since).limit(10000),
  ])
  const conversationOwners = new Map((conversations || []).map((conversation) => [conversation.id, conversation.user_id]))
  const people = new Map((profiles || []).map((profile) => [profile.id, {
    user_id: profile.id, name: profile.display_name || profile.email, responses: 0, tool_calls: 0,
    estimated_minutes_saved: 0, active_days: new Set(), contributions: 0,
  }]))
  let totalResponses = 0
  let totalTools = 0
  let estimatedMinutes = 0
  for (const message of messages || []) {
    const ownerId = conversationOwners.get(message.conversation_id)
    const person = people.get(ownerId)
    const successfulTools = (message.tool_calls || []).filter((call) => !call.is_error && !call.suppressed)
    const files = successfulTools.filter((call) => call.name === 'create_file').length
    const estimate = 3 + successfulTools.length * 2 + files * 8
    totalResponses += 1; totalTools += successfulTools.length; estimatedMinutes += estimate
    if (person) {
      person.responses += 1; person.tool_calls += successfulTools.length; person.estimated_minutes_saved += estimate
      person.active_days.add(message.created_at.slice(0, 10))
    }
  }
  const contributionTables = ['contexts', 'skills', 'wiki_pages', 'routines']
  const contributions = await Promise.all(contributionTables.map((table) =>
    db.from(table).select('created_by, created_at').gte('created_at', since).limit(10000)
  ))
  for (const result of contributions) for (const row of result.data || []) {
    const person = people.get(row.created_by)
    if (person) person.contributions += 1
  }
  const skillCounts = new Map()
  for (const event of skillEvents || []) skillCounts.set(event.skill_slug, (skillCounts.get(event.skill_slug) || 0) + 1)
  res.json({
    period, since, generated_at: now.toISOString(),
    totals: {
      estimated_minutes_saved: estimatedMinutes,
      estimated_hours_saved: Math.round(estimatedMinutes / 6) / 10,
      fte_days_saved: Math.round(estimatedMinutes / 48) / 10,
      annual_fte_equivalent: Math.round(estimatedMinutes / 1056) / 100,
      responses: totalResponses, tool_calls: totalTools,
      active_users: [...people.values()].filter((person) => person.responses > 0).length,
      contributions: [...people.values()].reduce((sum, person) => sum + person.contributions, 0),
    },
    skills: [...skillCounts.entries()].map(([slug, uses]) => ({ slug, uses })).sort((a, b) => b.uses - a.uses),
    people: [...people.values()].map((person) => ({ ...person, active_days: person.active_days.size }))
      .filter((person) => person.responses || person.contributions)
      .sort((a, b) => b.estimated_minutes_saved - a.estimated_minutes_saved),
    methodology: {
      label: 'Transparente Näherung, keine Zeiterfassung',
      formula: '3 Min. pro Enni-Antwort + 2 Min. pro erfolgreichem Tool-Call + 8 Min. zusätzlich pro erstellter Datei',
      fte_definition: '1 FTE-Tag = 8 Stunden; jährliches FTE-Äquivalent = 220 Arbeitstage',
    },
  })
})

app.post('/api/admin/announcements', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const title = String(req.body?.title || '').trim()
  const body = String(req.body?.body || '').trim()
  const audience = ['all', 'admins', 'members'].includes(req.body?.audience) ? req.body.audience : 'all'
  const actionUrl = String(req.body?.action_url || '').trim()
  if (!title || title.length > 180 || !body || body.length > 2000) return res.status(400).json({ error: 'Titel oder Nachricht ist ungültig.' })
  if (actionUrl && !actionUrl.startsWith('/')) return res.status(400).json({ error: 'Der Link muss ein interner Pfad sein (z. B. /spaces).' })
  const { data: announcement, error } = await db.from('system_announcements').insert({
    title, body, audience, action_url: actionUrl || null, created_by: user.id,
  }).select('*').single()
  if (error) return res.status(400).json({ error: error.message })
  let profilesQuery = db.from('profiles').select('id').eq('account_status', 'active')
  if (audience === 'admins') profilesQuery = profilesQuery.eq('is_admin', true)
  if (audience === 'members') profilesQuery = profilesQuery.eq('is_admin', false)
  const { data: profiles } = await profilesQuery
  await createNotifications((profiles || []).map((profile) => ({
    user_id: profile.id,
    type: 'system_update',
    actor_id: user.id,
    title,
    body,
    action_url: actionUrl || '/chat',
    metadata: { announcement_id: announcement.id, audience },
  })))
  await logAudit(user.id, 'announcement.publish', 'system_announcement', announcement.id, { audience, recipients: profiles?.length || 0 })
  res.json({ announcement, recipients: profiles?.length || 0 })
})

// Kollegen einladen (Admin): erzeugt einen bestätigten Account mit einem zufälligen
// Startpasswort. Damit hängt die Einladung weder von SMTP noch von kurzlebigen
// Einmal-Links ab. Das Startpasswort wird ausschließlich in dieser Response gezeigt
// und bei Abschluss des verpflichtenden Onboardings durch ein eigenes Passwort ersetzt.
const SITE_URL = process.env.SITE_URL || 'https://os.enneo.ai'
function temporaryPassword() {
  // Der feste Präfix garantiert alle konfigurierten Zeichengruppen; der zufällige
  // Anteil liefert 96 Bit Entropie und bleibt URL-/Messenger-sicher.
  return `En!7-${randomBytes(12).toString('base64url')}`
}

async function authUserByEmail(email) {
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 })
    if (error) throw error
    const found = data.users.find((candidate) => candidate.email?.toLowerCase() === email)
    if (found) return found
    if (data.users.length < 1000) break
  }
  return null
}
app.post('/api/invite', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const email = String(req.body?.email || '').trim().toLowerCase()
  const role = req.body?.role === 'admin' ? 'admin' : 'member'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Bitte gib eine gültige E-Mail-Adresse ein.' })
  }
  const { error: pendingError } = await db.from('pending_invites').upsert({
    email, requested_role: role, invited_by: user.id,
    expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  }, { onConflict: 'email' })
  if (pendingError) return res.status(400).json({ error: pendingError.message })
  const password = temporaryPassword()
  let existing = false
  let target = null
  try {
    target = await authUserByEmail(email)
    if (target) {
      existing = true
      const { data: profile } = await db.from('profiles')
        .select('onboarding_completed_at').eq('id', target.id).maybeSingle()
      if (profile?.onboarding_completed_at) {
        await db.from('pending_invites').delete().eq('email', email)
        return res.status(409).json({ error: 'Dieser Account ist bereits eingerichtet. Nutze bei Bedarf die Passwort-zurücksetzen-Funktion.' })
      }
      const { data, error } = await db.auth.admin.updateUserById(target.id, {
        password,
        email_confirm: true,
        app_metadata: { ...(target.app_metadata || {}), credential_mode: 'temporary_password' },
      })
      if (error) throw error
      target = data.user
    } else {
      const { data, error } = await db.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: String(req.body?.name || '').trim() },
        app_metadata: { credential_mode: 'temporary_password' },
      })
      if (error) throw error
      target = data.user
    }
    const { error: profileError } = await db.from('profiles').update({
      is_admin: role === 'admin',
      account_status: 'active',
      onboarding_completed_at: null,
      tour_completed_at: null,
    }).eq('id', target.id)
    if (profileError) throw profileError
  } catch (error) {
    await db.from('pending_invites').delete().eq('email', email)
    return res.status(400).json({ error: error.message })
  }
  await db.from('pending_invites').delete().eq('email', email)
  await logAudit(user.id, existing ? 'member.credentials_rotate' : 'member.invite', 'profile', target.id, {
    role, credential_mode: 'temporary_password',
  })
  res.json({
    email,
    temporary_password: password,
    login_url: SITE_URL,
    existing,
    role,
  })
})

app.patch('/api/admin/members/:id', async (req, res) => {
  const actor = await requireAdmin(req, res)
  if (!actor) return
  const { data: target } = await db.from('profiles').select('id, email, is_admin, account_status').eq('id', req.params.id).maybeSingle()
  if (!target) return res.status(404).json({ error: 'Account nicht gefunden' })
  const nextRole = req.body?.role === undefined ? null : req.body.role
  const nextStatus = req.body?.status === undefined ? null : req.body.status
  if (nextRole !== null && !['member', 'admin'].includes(nextRole)) return res.status(400).json({ error: 'Ungültige Rolle' })
  if (nextStatus !== null && !['active', 'disabled'].includes(nextStatus)) return res.status(400).json({ error: 'Ungültiger Status' })
  if (target.id === actor.id && (nextRole === 'member' || nextStatus === 'disabled')) {
    return res.status(400).json({ error: 'Du kannst deinen eigenen Admin-Zugang nicht herabstufen oder deaktivieren.' })
  }
  if (target.is_admin && (nextRole === 'member' || nextStatus === 'disabled')) {
    const { count } = await db.from('profiles').select('*', { count: 'exact', head: true }).eq('is_admin', true).eq('account_status', 'active')
    if ((count || 0) <= 1) return res.status(400).json({ error: 'Der letzte aktive Admin kann nicht entfernt werden.' })
  }
  const patch = {}
  if (nextRole !== null) patch.is_admin = nextRole === 'admin'
  if (nextStatus !== null) patch.account_status = nextStatus
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Keine Änderung angegeben' })
  const { data, error } = await db.from('profiles').update(patch).eq('id', target.id)
    .select('id, email, display_name, is_admin, account_status, role_title').single()
  if (error) return res.status(400).json({ error: error.message })
  await logAudit(actor.id, 'member.update', 'profile', target.id, {
    before: { role: target.is_admin ? 'admin' : 'member', status: target.account_status },
    after: { role: data.is_admin ? 'admin' : 'member', status: data.account_status },
  })
  res.json({ member: data })
})

app.post('/api/admin/knowledge-sources/:id/sync', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try { res.json(await syncKnowledgeSource(req.params.id, user.id)) }
  catch (error) { res.status(500).json({ error: error.message }) }
})

app.post('/api/routines', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: actor } = await db.from('profiles').select('is_admin, account_status').eq('id', user.id).maybeSingle()
  if (actor?.account_status !== 'active') return res.status(403).json({ error: 'Account ist deaktiviert' })

  const input = req.body?.routine || {}
  const id = String(input.id || '').trim() || null
  const name = String(input.name || '').trim()
  const prompt = String(input.prompt || '').trim()
  const cron = String(input.cron || '').trim()
  const scheduleLabel = String(input.schedule_label || '').trim()
  const requestedAudience = ['personal', 'all', 'restricted'].includes(input.audience) ? input.audience : 'personal'
  const audience = actor?.is_admin ? requestedAudience : 'personal'
  if (!name || !prompt || cron.split(/\s+/).length !== 5) return res.status(400).json({ error: 'Name, Auftrag und gültiger Zeitplan sind Pflicht.' })
  if (!ALLOWED_MODELS.includes(input.model)) return res.status(400).json({ error: 'Modell ist nicht erlaubt' })

  let existing = null
  if (id) {
    const { data } = await db.from('routines').select('*').eq('id', id).maybeSingle()
    existing = data
    if (!existing) return res.status(404).json({ error: 'Routine nicht gefunden' })
    if (!actor?.is_admin && (existing.created_by !== user.id || existing.visibility === 'team')) {
      return res.status(403).json({ error: 'Diese Routine kann nur ein Admin bearbeiten.' })
    }
  }

  let accountIds = [...new Set((Array.isArray(req.body?.account_ids) ? req.body.account_ids : []).map(String).filter(Boolean))]
  if (audience === 'restricted') {
    const { data: activeAccounts } = await db.from('profiles').select('id').eq('account_status', 'active').in('id', accountIds)
    accountIds = (activeAccounts || []).map((profile) => profile.id)
    if (!accountIds.length) return res.status(400).json({ error: 'Wähle mindestens einen aktiven Account aus.' })
  } else {
    accountIds = []
  }

  const podId = audience === 'personal' ? (input.pod_id || null) : null
  const routineOwnerId = existing?.created_by || user.id
  if (podId && !(await podIfVisible(podId, routineOwnerId))) {
    return res.status(403).json({ error: 'Der Ziel-Pod ist für diesen Routine-Account nicht verfügbar.' })
  }
  const visibility = audience === 'personal'
    ? (!actor?.is_admin && existing?.visibility === 'proposed' ? 'proposed' : 'personal')
    : 'team'
  const row = {
    name,
    prompt,
    cron,
    schedule_label: scheduleLabel,
    pod_id: podId,
    model: input.model,
    enabled: input.enabled !== false,
    audience,
    visibility,
  }
  const query = existing
    ? db.from('routines').update(row).eq('id', existing.id)
    : db.from('routines').insert({ ...row, created_by: user.id })
  const { data: routine, error } = await query.select('*').single()
  if (error) return res.status(400).json({ error: error.message })

  const { error: clearError } = await db.from('routine_accounts').delete().eq('routine_id', routine.id)
  if (clearError) return res.status(400).json({ error: clearError.message })
  if (accountIds.length) {
    const { error: assignmentError } = await db.from('routine_accounts').insert(
      accountIds.map((accountId) => ({ routine_id: routine.id, user_id: accountId }))
    )
    if (assignmentError) return res.status(400).json({ error: assignmentError.message })
  }
  await logAudit(user.id, existing ? 'routine.update' : 'routine.create', 'routine', routine.id, { audience, account_ids: accountIds })
  res.json({ routine: { ...routine, routine_accounts: accountIds.map((user_id) => ({ user_id })) } })
})

app.post('/api/routines/:id/:action(approve|reject|demote)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const visibility = req.params.action === 'approve' ? 'team' : 'personal'
  const audience = req.params.action === 'approve' ? 'all' : 'personal'
  const { data, error } = await db.from('routines').update({ visibility, audience, pod_id: null }).eq('id', req.params.id)
    .select('id, name, visibility, audience').maybeSingle()
  if (error) return res.status(400).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Routine nicht gefunden' })
  await db.from('routine_accounts').delete().eq('routine_id', data.id)
  await logAudit(user.id, `routine.${req.params.action}`, 'routine', data.id, { visibility, audience })
  res.json({ ok: true, routine: data })
})

app.post('/api/wiki-pages/:id/:action(approve|reject|demote)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const visibility = req.params.action === 'approve' ? 'team' : 'personal'
  const { data, error } = await db.from('wiki_pages').update({ visibility, updated_by: user.id }).eq('id', req.params.id)
    .select('id, slug, title, content, visibility').maybeSingle()
  if (error) return res.status(400).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Seite nicht gefunden' })
  if (req.params.action === 'approve') {
    try {
      const { reindexPage } = await import('./tools/wiki.js')
      await reindexPage(data)
    } catch (indexError) {
      await db.from('wiki_pages').update({ visibility: 'proposed', updated_by: user.id }).eq('id', data.id)
      return res.status(500).json({ error: `Freigabe zurückgerollt, weil die Indexierung fehlgeschlagen ist: ${indexError.message}` })
    }
  }
  await logAudit(user.id, `wiki_page.${req.params.action}`, 'wiki_page', data.id, { visibility })
  res.json({ ok: true, page: data })
})

app.post('/api/wiki-pages/bulk-approve', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const ids = [...new Set((Array.isArray(req.body?.ids) ? req.body.ids : []).map(String).filter(Boolean))].slice(0, 50)
  if (!ids.length) return res.status(400).json({ error: 'Keine Seiten ausgewählt.' })
  const { data: pages, error } = await db.from('wiki_pages')
    .select('id, slug, title, content, visibility').in('id', ids).eq('visibility', 'proposed')
  if (error) return res.status(400).json({ error: error.message })
  if (!pages?.length) return res.status(404).json({ error: 'Keine offenen Seiten gefunden.' })
  const { reindexPage } = await import('./tools/wiki.js')
  const approved = []
  const failed = []
  for (const page of pages) {
    const { error: updateError } = await db.from('wiki_pages').update({ visibility: 'team', updated_by: user.id }).eq('id', page.id).eq('visibility', 'proposed')
    if (updateError) { failed.push({ id: page.id, title: page.title, error: updateError.message }); continue }
    try {
      await reindexPage(page)
      approved.push({ id: page.id, slug: page.slug, title: page.title })
    } catch (indexError) {
      await db.from('wiki_pages').update({ visibility: 'proposed', updated_by: user.id }).eq('id', page.id)
      failed.push({ id: page.id, title: page.title, error: indexError.message })
    }
  }
  await logAudit(user.id, 'wiki_page.bulk_approve', 'wiki_page_collection', null, {
    requested: ids.length, approved: approved.length, failed: failed.length,
  })
  res.status(failed.length ? 207 : 200).json({ ok: !failed.length, approved, failed })
})

app.post('/api/connectors', async (req, res) => {
  // Jeder Account darf Connections im Marketplace speichern. Die Connection
  // bleibt fuer Enni inaktiv, bis ein Space sie explizit autorisiert.
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: prof } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  const isAdmin = !!prof?.is_admin
  const { name, url, token, category, kind, auth_type: authType } = req.body || {}
  const requestedTeam = req.body?.scope === 'team'
  if (requestedTeam && !isAdmin) return res.status(403).json({ error: 'Nur Admins können eine gemeinsame Service-Verbindung anlegen.' })
  const personal = !requestedTeam
  // Persönliche Credentials gehören ausnahmslos dem eingeloggten Account.
  // Auch Admins dürfen keine Verbindung stellvertretend für andere anlegen.
  const owner = personal ? user.id : null
  const visibility = personal ? 'personal' : 'team'

  // Legacy-Fallback für bestehende Clients; die sichtbare UI nutzt ausschließlich OAuth.
  if (kind === 'slack') {
    if (!token?.trim()) return res.status(400).json({ error: 'Bot-Token ist Pflicht' })
    try {
      const [{ probeSlack, invalidateSlackCache }, { encryptSecret }] = await Promise.all([
        import('./tools/slack.js'),
        import('./crypto.js'),
      ])
      const info = await probeSlack(token.trim())
      // Re-Connect ersetzt den Token — im jeweiligen Scope (persoenlich vs. team)
      let oldQ = db.from('connectors').select('id').eq('kind', 'slack')
      oldQ = personal ? oldQ.eq('owner', user.id).neq('visibility', 'team') : oldQ.eq('visibility', 'team')
      const { data: previous } = await oldQ
      let delQ = db.from('connectors').delete().eq('kind', 'slack')
      delQ = personal ? delQ.eq('owner', user.id).neq('visibility', 'team') : delQ.eq('visibility', 'team')
      await delQ
      const { data, error } = await db
        .from('connectors')
        .insert({
          name: 'Slack',
          url: 'https://slack.com',
          token: encryptSecret(token.trim()),
          category: 'connection',
          kind: 'slack',
          tool_count: 3,
          created_by: user.id,
          owner,
          visibility,
        })
        .select('id, name')
        .single()
      if (error) throw new Error(error.message)
      const { moveConnectorAssignments } = await import('./connector-access.js')
      await moveConnectorAssignments((previous || []).map((row) => row.id), data.id)
      invalidateSlackCache()
      return res.json({ ...data, workspace: info.team, bot: info.bot })
    } catch (err) {
      return res.status(400).json({ error: `Slack-Verbindung fehlgeschlagen: ${err.message}` })
    }
  }

  // Nativer Attio-Connector: nur API-Key nötig, Verbindungstest gegen /v2/self
  if (kind === 'attio') {
    if (!token?.trim()) return res.status(400).json({ error: 'API-Key ist Pflicht' })
    try {
      const [{ probeAttio, invalidateAttioCache }, { encryptSecret }] = await Promise.all([
        import('./tools/attio.js'), import('./crypto.js'),
      ])
      const workspace = await probeAttio(token.trim())
      // Re-Connect ersetzt den Key — im jeweiligen Scope (persoenlich vs. team)
      let oldQ = db.from('connectors').select('id').eq('kind', 'attio')
      oldQ = personal ? oldQ.eq('owner', user.id).neq('visibility', 'team') : oldQ.eq('visibility', 'team')
      const { data: previous } = await oldQ
      let delQ = db.from('connectors').delete().eq('kind', 'attio')
      delQ = personal ? delQ.eq('owner', user.id).neq('visibility', 'team') : delQ.eq('visibility', 'team')
      await delQ
      const { data, error } = await db
        .from('connectors')
        .insert({
          name: 'Attio',
          url: 'https://api.attio.com',
          token: encryptSecret(token.trim()),
          category: 'connection',
          kind: 'attio',
          tool_count: 7,
          created_by: user.id,
          owner,
          visibility,
        })
        .select('id, name')
        .single()
      if (error) throw new Error(error.message)
      const { moveConnectorAssignments } = await import('./connector-access.js')
      await moveConnectorAssignments((previous || []).map((row) => row.id), data.id)
      invalidateAttioCache()
      return res.json({ ...data, workspace })
    } catch (err) {
      return res.status(400).json({ error: `Attio-Verbindung fehlgeschlagen: ${err.message}` })
    }
  }

  if (!name?.trim() || !url?.trim()) return res.status(400).json({ error: 'Name und URL sind Pflicht' })
  if (!/^https:\/\//.test(url.trim())) return res.status(400).json({ error: 'URL muss mit https:// beginnen' })
  try {
    const { addConnector } = await import('./tools/mcp.js')
    res.json(await addConnector({ name, url, token, authType: authType || 'manual', category, owner, visibility }, user.id))
  } catch (err) {
    res.status(400).json({ error: `Verbindung fehlgeschlagen: ${err.message}` })
  }
})

// Enni Research Lab: fehlendes Tool nennen oder verlinken → offizielle Quellen
// recherchieren → sicherer Blueprint → Admin-Review → Marketplace.
app.get('/api/tool-requests', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  let query = db.from('tool_requests').select('*').order('created_at', { ascending: false }).limit(100)
  if (!profile?.is_admin) query = query.or(`status.eq.approved,requested_by.eq.${user.id}`)
  const { data, error } = await query
  if (error) return res.status(400).json({ error: error.message })
  res.json({ requests: data || [], is_admin: !!profile?.is_admin })
})

app.post('/api/tool-requests', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const name = String(req.body?.name || '').trim().slice(0, 100)
  const sourceUrl = String(req.body?.source_url || '').trim()
  const note = String(req.body?.request_note || '').trim().slice(0, 1000)
  if (!name && !sourceUrl) return res.status(400).json({ error: 'Nenne das Tool oder füge einen Link ein.' })
  if (sourceUrl) {
    try {
      const parsed = new URL(sourceUrl)
      const host = parsed.hostname.toLowerCase()
      const privateHost = host === 'localhost' || host === '::1' || host.endsWith('.local') || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\./.test(host)
      if (parsed.protocol !== 'https:' || privateHost) throw new Error('invalid')
    } catch {
      return res.status(400).json({ error: 'Bitte verwende eine öffentliche https://-Adresse.' })
    }
  }
  const { data, error } = await db.from('tool_requests').insert({
    requested_by: user.id,
    name: name || null,
    source_url: sourceUrl || null,
    request_note: note || null,
    status: 'queued',
  }).select('*').single()
  if (error) return res.status(400).json({ error: error.message })
  await logAudit(user.id, 'tool_research.request', 'tool_request', data.id, { name, source_url: sourceUrl || null })
  const { researchToolRequest } = await import('./tool-research.js')
  setImmediate(() => researchToolRequest(data.id))
  res.status(202).json({ request: data })
})

app.post('/api/tool-requests/:id/retry', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  const { data: request } = await db.from('tool_requests').select('id, requested_by').eq('id', req.params.id).maybeSingle()
  if (!request) return res.status(404).json({ error: 'Anfrage nicht gefunden' })
  if (!profile?.is_admin && request.requested_by !== user.id) return res.status(403).json({ error: 'Nicht erlaubt' })
  await db.from('tool_requests').update({ status: 'queued', research_error: null }).eq('id', request.id)
  const { researchToolRequest } = await import('./tool-research.js')
  setImmediate(() => researchToolRequest(request.id))
  res.status(202).json({ ok: true })
})

app.post('/api/tool-requests/:id/:action(approve|reject)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const status = req.params.action === 'approve' ? 'approved' : 'rejected'
  const { data: existing } = await db.from('tool_requests').select('id, status, research').eq('id', req.params.id).maybeSingle()
  if (!existing) return res.status(404).json({ error: 'Anfrage nicht gefunden' })
  if (req.params.action === 'approve' && existing.status !== 'review') {
    return res.status(400).json({ error: 'Nur vollständig recherchierte Entwürfe können veröffentlicht werden.' })
  }
  let research = existing.research || {}
  if (req.params.action === 'approve') {
    try {
      const { certifyToolBlueprint } = await import('./tool-research.js')
      const certification = await certifyToolBlueprint(research, { requestId: existing.id, userId: user.id })
      research = { ...research, certification, connect_ready: certification.status === 'verified' }
    } catch (error) {
      return res.status(400).json({ error: `Technische Zertifizierung fehlgeschlagen: ${error.message}` })
    }
  }
  const now = new Date().toISOString()
  const { data, error } = await db.from('tool_requests').update({
    status,
    research,
    reviewed_by: user.id,
    reviewed_at: now,
    published_at: status === 'approved' ? now : null,
  }).eq('id', existing.id).select('*').single()
  if (error) return res.status(400).json({ error: error.message })
  await logAudit(user.id, `tool_research.${req.params.action}`, 'tool_request', data.id, {
    integration_type: data.research?.integration_type,
    connect_ready: !!data.research?.connect_ready,
  })
  res.json({ request: data })
})

// UX/UI-Engineering: Members sehen/erstellen nur eigene Requests; Admins sehen
// die gesamte Queue und verwalten sie. Die eigentliche Code-Umsetzung bleibt in
// Ennis admin-only Tool-Katalog und ist an approved Requests gebunden.
app.get('/api/ui-change-requests', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  try {
    const { runUxUiTool } = await import('./tools/ux-ui.js')
    const raw = await runUxUiTool(profile?.is_admin ? 'ux_ui_list_requests' : 'ux_ui_list_my_requests', {
      limit: Math.min(Number(req.query.limit) || 100, 100),
      ...(req.query.status ? { status: String(req.query.status) } : {}),
    }, { userId: user.id })
    res.json({ requests: JSON.parse(raw), is_admin: !!profile?.is_admin })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

app.post('/api/ui-change-requests', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { runUxUiTool } = await import('./tools/ux-ui.js')
    const raw = await runUxUiTool('ux_ui_request_change', req.body || {}, { userId: user.id })
    res.status(201).json(JSON.parse(raw))
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

app.patch('/api/admin/ui-change-requests/:id', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try {
    const { runUxUiTool } = await import('./tools/ux-ui.js')
    const raw = await runUxUiTool('ux_ui_manage_request', {
      request_id: req.params.id,
      status: req.body?.status,
      admin_notes: req.body?.admin_notes,
      verification: req.body?.verification,
    }, { userId: user.id })
    res.json({ request: JSON.parse(raw) })
  } catch (error) {
    res.status(400).json({ error: error.message })
  }
})

// Einheitliche OAuth-Plattform: Provider-Credentials werden einmalig durch einen
// Admin in enneo OS konfiguriert; Accounts verbinden sich danach per Anbieter-Login.
app.get('/api/oauth/providers', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { providerStatus } = await import('./provider-oauth.js')
    res.json({ providers: await providerStatus() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

app.put('/api/admin/oauth/providers/:provider', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try {
    const { saveProviderConfig } = await import('./provider-oauth.js')
    const provider = await saveProviderConfig(req.params.provider, req.body || {}, user.id)
    await logAudit(user.id, 'oauth_provider.configure', 'oauth_provider', req.params.provider)
    res.json({ provider })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/oauth/:provider/start', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { OAUTH_PROVIDERS, createProviderInstallUrl, providerRedirectUri } = await import('./provider-oauth.js')
  const provider = req.params.provider
  if (!OAUTH_PROVIDERS[provider]) return res.status(404).json({ error: 'OAuth-Anbieter nicht gefunden' })
  const { data: profile } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  const requestedTeam = req.body?.scope === 'team'
  if (requestedTeam && !profile?.is_admin) return res.status(403).json({ error: `Nur Admins können ${OAUTH_PROVIDERS[provider].label} teamweit verbinden.` })
  try {
    const url = await createProviderInstallUrl({ provider, userId: user.id, visibility: requestedTeam ? 'team' : 'personal' })
    res.json({ url })
  } catch (err) {
    res.status(err.code === 'provider_not_configured' ? 409 : 503).json({
      error: err.message, code: err.code || 'oauth_start_failed', redirectUri: providerRedirectUri(provider),
      setupUrl: OAUTH_PROVIDERS[provider].setupUrl,
    })
  }
})

app.get('/api/oauth/:provider/callback', async (req, res) => {
  const provider = req.params.provider
  try {
    const { OAUTH_PROVIDERS, completeProviderOAuth } = await import('./provider-oauth.js')
    if (!OAUTH_PROVIDERS[provider]) return res.status(404).send('OAuth-Anbieter nicht gefunden')
    const url = await completeProviderOAuth({ provider,
      code: String(req.query.code || ''),
      state: String(req.query.state || ''),
      deniedError: String(req.query.error || ''),
    })
    res.redirect(303, url)
  } catch (err) {
    console.error(`${provider} OAuth Callback:`, err.message)
    const { providerOAuthErrorUrl } = await import('./provider-oauth.js')
    res.redirect(303, providerOAuthErrorUrl(provider, 'callback_failed'))
  }
})

// OAuth für offizielle Remote-MCPs. Der MCP-Server übernimmt Discovery,
// Dynamic Client Registration, PKCE, Consent und Token Refresh. Anders als
// bei nativen Provider-Apps ist keine einmalige Admin-Konfiguration nötig.
app.post('/api/mcp/oauth/:provider/start', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { MCP_OAUTH_SERVERS, createMcpOAuthUrl } = await import('./mcp-oauth.js')
    const provider = req.params.provider
    if (!MCP_OAUTH_SERVERS[provider]) return res.status(404).json({ error: 'OAuth-MCP nicht gefunden' })
    const url = await createMcpOAuthUrl({ provider, userId: user.id })
    res.json({ url })
  } catch (err) {
    console.error('MCP OAuth Start:', err.message)
    res.status(503).json({ error: `Anbieter-Login konnte nicht gestartet werden: ${err.message}` })
  }
})

// Approved researched OAuth MCPs use the same SDK-native discovery, DCR, PKCE
// and refresh path as curated providers. The approved blueprint is the dynamic
// registry entry; no code deployment is needed for each future provider.
app.post('/api/tool-requests/:id/oauth/start', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { data: request, error } = await db.from('tool_requests')
      .select('id, status, research')
      .eq('id', req.params.id)
      .maybeSingle()
    if (error || !request) return res.status(404).json({ error: 'Integration nicht gefunden' })
    const blueprint = request.research || {}
    if (request.status !== 'approved' || blueprint.certification?.status !== 'verified' || !blueprint.connect_ready) {
      return res.status(409).json({ error: 'Diese Integration wurde noch nicht technisch zertifiziert.' })
    }
    if (blueprint.integration_type !== 'remote_mcp' || blueprint.auth?.mcp_scheme !== 'oauth' || !blueprint.mcp_url) {
      return res.status(400).json({ error: 'Diese Integration verwendet keinen unterstützten OAuth-MCP-Login.' })
    }
    const { createMcpOAuthUrl } = await import('./mcp-oauth.js')
    const { researchedOAuthProvider } = await import('./tool-research.js')
    const url = await createMcpOAuthUrl({
      provider: researchedOAuthProvider(request.id),
      userId: user.id,
      server: { label: blueprint.display_name, url: blueprint.mcp_url, category: 'tool' },
    })
    res.json({ url })
  } catch (err) {
    console.error('Research MCP OAuth Start:', err.message)
    res.status(503).json({ error: `Anbieter-Login konnte nicht gestartet werden: ${err.message}` })
  }
})

app.get('/api/mcp/oauth/:provider/callback', async (req, res) => {
  try {
    const { completeMcpOAuth } = await import('./mcp-oauth.js')
    const provider = req.params.provider
    const url = await completeMcpOAuth({
      provider,
      code: String(req.query.code || ''),
      state: String(req.query.state || ''),
      deniedError: String(req.query.error || ''),
    })
    res.redirect(303, url)
  } catch (err) {
    console.error('MCP OAuth Callback:', err.message)
    const { mcpOAuthErrorUrl } = await import('./mcp-oauth.js')
    res.redirect(303, mcpOAuthErrorUrl(req.params.provider, 'callback_failed'))
  }
})

// Connection fuer den Teamkatalog beantragen (Owner) bzw. freigeben/ablehnen
// (Admin). Das veraendert nur die Sichtbarkeit im Marketplace; Toolzugriff
// entsteht weiterhin ausschliesslich durch eine Space-Zuordnung.
app.post('/api/connectors/:id/share', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data, error } = await db
    .from('connectors')
    .update({ visibility: 'proposed' })
    .eq('id', req.params.id)
    .eq('owner', user.id)
    .eq('visibility', 'personal')
    .select('id')
    .maybeSingle()
  if (error) return res.status(400).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Tool nicht gefunden oder nicht deins' })
  await logAudit(user.id, 'connector.propose', 'connector', data.id)
  res.json({ ok: true, visibility: 'proposed' })
})

app.post('/api/connectors/:id/:action(approve|reject)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const target = req.params.action === 'approve' ? 'team' : 'personal'
  const { data: conn } = await db.from('connectors').select('id, kind, visibility').eq('id', req.params.id).maybeSingle()
  if (!conn) return res.status(404).json({ error: 'Tool nicht gefunden' })
  let replacedIds = []
  // Pro nativem Anbieter gibt es max. EINEN Team-Connector — alter wird ersetzt.
  if (target === 'team' && ['attio', 'slack', 'outlook', 'google_drive', 'notion'].includes(conn.kind)) {
    const { data: replaced } = await db.from('connectors').select('id').eq('kind', conn.kind).eq('visibility', 'team').neq('id', conn.id)
    replacedIds = (replaced || []).map((row) => row.id)
    await db.from('connectors').delete().eq('kind', conn.kind).eq('visibility', 'team').neq('id', conn.id)
  }
  const { error } = await db.from('connectors').update({ visibility: target }).eq('id', conn.id)
  if (error) return res.status(400).json({ error: error.message })
  if (replacedIds.length) {
    const { moveConnectorAssignments } = await import('./connector-access.js')
    await moveConnectorAssignments(replacedIds, conn.id)
  }
  const { invalidateAttioCache } = await import('./tools/attio.js')
  const { invalidateSlackCache } = await import('./tools/slack.js')
  const { invalidateMcpCache } = await import('./tools/mcp.js')
  const { invalidateProductivityCache } = await import('./tools/productivity.js')
  invalidateAttioCache(); invalidateSlackCache(); invalidateMcpCache(); invalidateProductivityCache()
  await logAudit(user.id, `connector.${req.params.action}`, 'connector', conn.id, { visibility: target })
  res.json({ ok: true, visibility: target })
})

app.delete('/api/connectors/:id', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: prof } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  const { data: conn } = await db.from('connectors').select('id, owner, kind, token, auth_type').eq('id', req.params.id).maybeSingle()
  if (!conn) return res.status(404).json({ error: 'Tool nicht gefunden' })
  if (!prof?.is_admin && conn.owner !== user.id) return res.status(403).json({ error: 'Nur eigene Tools oder Admin' })
  try {
    if (conn.kind === 'slack' && conn.auth_type === 'oauth') {
      const { revokeSlackToken } = await import('./tools/slack.js')
      await revokeSlackToken(conn.token).catch((err) => console.warn('Slack-Token konnte nicht widerrufen werden:', err.message))
    }
    const { removeConnector } = await import('./tools/mcp.js')
    await removeConnector(req.params.id)
    const { invalidateAttioCache } = await import('./tools/attio.js')
    invalidateAttioCache()
    const { invalidateSlackCache } = await import('./tools/slack.js')
    invalidateSlackCache()
    const { invalidateProductivityCache } = await import('./tools/productivity.js')
    invalidateProductivityCache()
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// "Lernen & Schließen": Haiku destilliert rein persönliche Account-Learnings.
app.post('/api/conversations/:id/learn', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: conv } = await db
    .from('conversations')
    .select('id, user_id')
    .eq('id', req.params.id)
    .maybeSingle()
  if (!conv || conv.user_id !== user.id) return res.status(404).json({ error: 'Conversation nicht gefunden' })
  try {
    const { learnFromConversation } = await import('./learnings.js')
    res.json(await learnFromConversation(conv.id, user.id))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Learning-Review — nur Admins: approve = Team-weit, reject = bleibt persönlich
app.post('/api/learnings/:id/:action(approve|reject)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try {
    const { reviewLearning } = await import('./learnings.js')
    const result = await reviewLearning(req.params.id, req.params.action, user.id)
    await logAudit(user.id, `learning.${req.params.action}`, 'learning', req.params.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Team-weites Learning deaktivieren (bleibt persönlich beim Urheber)
app.post('/api/learnings/:id/demote', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try {
    const { demoteLearning } = await import('./learnings.js')
    const result = await demoteLearning(req.params.id, user.id)
    await logAudit(user.id, 'learning.demote', 'learning', req.params.id)
    res.json(result)
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

// Skill-Vorschlag freischalten/ablehnen (Admin). 'approve' = team-weit für alle,
// 'reject' = bleibt persönlich beim Ersteller (visibility 'personal'). 'demote' =
// team-weiten Skill wieder zurückstufen (bleibt persönlich beim Ersteller).
app.post('/api/skills/:id/:action(approve|reject|demote)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const target = req.params.action === 'approve' ? 'team' : 'personal'
  const { data, error } = await db
    .from('skills')
    .update({ visibility: target, updated_by: user.id })
    .eq('id', req.params.id)
    .select('id, slug, visibility')
    .maybeSingle()
  if (error) return res.status(400).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Skill nicht gefunden' })
  await logAudit(user.id, `skill.${req.params.action}`, 'skill', data.id, { visibility: data.visibility })
  res.json({ ok: true, visibility: data.visibility })
})

// Wiki-Seite neu für Ennis Suche indexieren — nach jedem Anlegen/Bearbeiten im Editor.
// Ohne Re-Embed würde die semantische Suche mit altem Stand antworten.
app.post('/api/wiki/reindex', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const slug = String(req.body?.slug || '').trim()
  if (!slug) return res.status(400).json({ error: 'slug fehlt' })
  const { data: page } = await db.from('wiki_pages').select('id, slug, title, content').eq('slug', slug).maybeSingle()
  if (!page) return res.status(404).json({ error: 'Seite nicht gefunden' })
  try {
    const { reindexPage } = await import('./tools/wiki.js')
    const chunks = await reindexPage(page)
    res.json({ ok: true, chunks })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Mehrere Markdown-Dateien oder einen ganzen lokalen Ordner als einzelne
// Wiki-Seiten importieren. Nicht-Admins reichen die Sammlung als Team-Vorschlag
// ein; erst die Admin-Freigabe indexiert sie für Enni.
app.post('/api/wiki/import-markdown', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const files = Array.isArray(req.body?.files) ? req.body.files : []
  const spaceId = String(req.body?.space_id || '')
  const folderInput = String(req.body?.folder || '').trim()
  const slugPart = (value) => String(value || '').toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)
  const folder = folderInput.split('/').map(slugPart).filter(Boolean).join('/')

  if (!spaceId) return res.status(400).json({ error: 'Ziel-Space fehlt.' })
  if (!folder) return res.status(400).json({ error: 'Zielordner fehlt.' })
  if (!files.length || files.length > 50) return res.status(400).json({ error: 'Wähle zwischen 1 und 50 Markdown-Dateien.' })

  const normalized = []
  let totalBytes = 0
  for (const item of files) {
    const name = String(item?.name || '').trim()
    const content = String(item?.content || '')
    const title = String(item?.title || '').trim().slice(0, 180)
    if (!/\.(md|markdown)$/i.test(name)) return res.status(400).json({ error: `"${name || 'Datei'}" ist keine Markdown-Datei.` })
    if (!content.trim()) return res.status(400).json({ error: `"${name}" ist leer.` })
    if (!title) return res.status(400).json({ error: `Für "${name}" konnte kein Titel bestimmt werden.` })
    const byteLength = Buffer.byteLength(content, 'utf8')
    if (byteLength > 2_000_000) return res.status(400).json({ error: `"${name}" ist größer als 2 MB.` })
    totalBytes += byteLength
    const fileSlug = slugPart(name.replace(/\.(md|markdown)$/i, ''))
    if (!fileSlug) return res.status(400).json({ error: `Aus "${name}" lässt sich kein Seiten-Slug bilden.` })
    normalized.push({ name, title, content, slug: `${folder}/${fileSlug}`.slice(0, 190) })
  }
  if (totalBytes > 12_000_000) return res.status(400).json({ error: 'Die Sammlung ist größer als 12 MB.' })
  const duplicateSlugs = normalized.filter((item, index) => normalized.findIndex((other) => other.slug === item.slug) !== index)
  if (duplicateSlugs.length) return res.status(409).json({ error: `Doppelte Dateinamen: ${[...new Set(duplicateSlugs.map((item) => item.name))].join(', ')}` })

  try {
    const [{ data: profile }, { data: space }] = await Promise.all([
      db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle(),
      db.from('spaces').select('id, name, restricted, created_by').eq('id', spaceId).maybeSingle(),
    ])
    if (!space) return res.status(404).json({ error: 'Ziel-Space wurde nicht gefunden.' })
    if (space.restricted && !profile?.is_admin && space.created_by !== user.id) {
      const { data: membership } = await db.from('space_members').select('space_id').eq('space_id', spaceId).eq('user_id', user.id).maybeSingle()
      if (!membership) return res.status(403).json({ error: 'Du hast keinen Zugriff auf diesen Restricted Space.' })
    }

    const slugs = normalized.map((item) => item.slug)
    const { data: existing } = await db.from('wiki_pages').select('slug').in('slug', slugs)
    if (existing?.length) {
      return res.status(409).json({ error: `Bereits vorhanden: ${existing.map((page) => page.slug).join(', ')}` })
    }

    const visibility = profile?.is_admin ? 'team' : 'proposed'
    const { data: pages, error } = await db.from('wiki_pages').insert(normalized.map((item) => ({
      slug: item.slug,
      title: item.title,
      content: item.content,
      space_id: spaceId,
      created_by: user.id,
      updated_by: user.id,
      visibility,
    }))).select('id, slug, title, content, visibility')
    if (error) throw new Error(error.message)

    const indexingErrors = []
    if (visibility === 'team') {
      const { reindexPage } = await import('./tools/wiki.js')
      for (const page of pages || []) {
        try { await reindexPage(page) } catch (indexError) { indexingErrors.push({ slug: page.slug, error: indexError.message }) }
      }
    }
    await logAudit(user.id, 'wiki.markdown_batch_import', 'space', spaceId, {
      folder, file_count: pages?.length || 0, visibility, indexing_errors: indexingErrors.length,
    })
    res.json({
      ok: true,
      folder,
      visibility,
      imported: (pages || []).map(({ id, slug, title }) => ({ id, slug, title })),
      indexing_errors: indexingErrors,
      needs_approval: visibility === 'proposed',
    })
  } catch (error) {
    res.status(500).json({ error: error.message })
  }
})

// Seite per URL importieren: Firecrawl-Bridge crawlt → Markdown → wiki_pages → Re-Index.
// Bridge lebt im claude-team-Supabase (FIRECRAWL_BRIDGE_URL + FIRECRAWL_BRIDGE_TOKEN als Env).
app.post('/api/wiki/import-url', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const url = String(req.body?.url || '').trim()
  if (!/^https?:\/\/.+\..+/.test(url)) return res.status(400).json({ error: 'Ungültige URL' })
  if (!process.env.FIRECRAWL_BRIDGE_URL || !process.env.FIRECRAWL_BRIDGE_TOKEN)
    return res.status(500).json({ error: 'URL-Import ist nicht konfiguriert (FIRECRAWL_BRIDGE_URL/TOKEN fehlen)' })
  try {
    const { data: profile } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
    const fc = await fetch(process.env.FIRECRAWL_BRIDGE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.FIRECRAWL_BRIDGE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ tool: 'firecrawl_scrape', args: { url, formats: ['markdown'] } }),
    })
    const payload = await fc.json()
    if (!fc.ok || payload.ok === false) throw new Error(payload.error || `Crawl fehlgeschlagen (${fc.status})`)
    const r = payload.result || payload
    const markdown = r.markdown || r.data?.markdown
    const title = (r.metadata?.title || r.data?.metadata?.title || new URL(url).pathname.split('/').filter(Boolean).pop() || url)
      .toString().slice(0, 140)
    if (!markdown?.trim()) throw new Error('Die Seite lieferte keinen lesbaren Inhalt')

    const slugPart = (t) => t.toLowerCase()
      .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const folder = String(req.body?.folder || '').split('/').map(slugPart).filter(Boolean).join('/') || 'import'
    const slug = `${folder}/${slugPart(title)}`.slice(0, 90)
    const content = `> Quelle: ${url} · importiert am ${new Date().toLocaleDateString('de-DE')}\n\n${markdown}`
    const { data: existingPage } = await db.from('wiki_pages').select('created_by, visibility').eq('slug', slug).maybeSingle()
    if (existingPage && !profile?.is_admin && (existingPage.created_by !== user.id || existingPage.visibility === 'team')) {
      throw new Error(`Es gibt bereits eine Team-Seite mit dem Slug "${slug}".`)
    }
    const { data: page, error } = await db
      .from('wiki_pages')
      .upsert(
        { slug, title, content, space_id: req.body?.space_id || null, created_by: user.id, updated_by: user.id,
          visibility: profile?.is_admin ? 'team' : 'personal' },
        { onConflict: 'slug' }
      )
      .select('id, slug, title, content')
      .single()
    if (error) throw new Error(error.message)
    const { reindexPage } = await import('./tools/wiki.js')
    const chunks = await reindexPage(page)
    res.json({ ok: true, slug: page.slug, title, chunks })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Wiki-Seite löschen — nur Admins (destruktiv; Chunks fliegen mit raus)
app.post('/api/wiki/delete', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const slug = String(req.body?.slug || '').trim()
  if (!slug) return res.status(400).json({ error: 'slug fehlt' })
  try {
    await db.from('wiki_chunks').delete().eq('slug', slug)
    const { error } = await db.from('wiki_pages').delete().eq('slug', slug)
    if (error) throw new Error(error.message)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Routine sofort ausführen (Test-Lauf) — Owner oder Admin
app.post('/api/routines/:id/run', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: r } = await db.from('routines').select('*').eq('id', req.params.id).maybeSingle()
  if (!r) return res.status(404).json({ error: 'Routine nicht gefunden' })
  const { data: prof } = await db.from('profiles').select('is_admin, account_status').eq('id', user.id).maybeSingle()
  if (prof?.account_status !== 'active') return res.status(403).json({ error: 'Account ist deaktiviert' })
  const crossAccount = r.audience === 'all' || r.audience === 'restricted' || r.visibility === 'team'
  if ((crossAccount && !prof?.is_admin) || (!crossAccount && r.created_by !== user.id && !prof?.is_admin)) {
    return res.status(403).json({ error: crossAccount ? 'Accountübergreifende Läufe können nur Admins starten.' : 'Nur Ersteller oder Admin' })
  }
  const result = await runRoutine(r)
  if (!result.ok) return res.status(500).json(result)
  res.json(result)
})

const port = Number(process.env.PORT || 8080)
app.listen(port, () => {
  console.log(`enneo OS backend läuft auf :${port}`)
  startPushTicker()
  startKnowledgeSyncTicker()
  import('./tool-research.js').then(({ resumeToolResearch }) => resumeToolResearch()).catch((err) => console.error('Tool-Recherche konnte nicht fortgesetzt werden:', err.message))
})
startRoutineTicker()
