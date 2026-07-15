import express from 'express'
import cors from 'cors'
import { db, getUserFromRequest } from './db.js'
import { runEnniTurn, ALLOWED_MODELS, generateTitle, availableToolDefinitions } from './agent.js'
import { attachmentsToBlocks, attachmentMeta } from './attachments.js'
import { logUsage } from './usage.js'
import { startRoutineTicker, runRoutine } from './routines.js'
import { startKnowledgeSyncTicker, syncKnowledgeSource } from './knowledge-sync.js'
import { logAudit } from './audit.js'

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

// Pod laden, wenn der User ihn sehen darf (open / Mitglied / Ersteller / Admin)
async function podIfVisible(podId, userId) {
  const { data: pod } = await db.from('pods').select('*').eq('id', podId).maybeSingle()
  if (!pod) return null
  if (pod.open || pod.created_by === userId) return pod
  const { data: member } = await db
    .from('pod_members').select('user_id').eq('pod_id', podId).eq('user_id', userId).maybeSingle()
  if (member) return pod
  const { data: prof } = await db.from('profiles').select('is_admin').eq('id', userId).maybeSingle()
  return prof?.is_admin ? pod : null
}

// Verlauf ab dem letzten Compaction-Anker aufbauen (Dust-Muster).
// In Pod-Konversationen werden User-Messages mit dem Autor-Namen geprefixt.
async function buildHistory(convId, isPod = false) {
  const { data: all } = await db
    .from('messages')
    .select('role, content, author_id')
    .eq('conversation_id', convId)
    .order('created_at')
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

app.post('/api/conversations/:id/stop', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: c } = await db
    .from('conversations')
    .select('id, user_id, pod_id')
    .eq('id', req.params.id)
    .maybeSingle()
  if (!c) return res.status(404).json({ error: 'Conversation nicht gefunden' })
  if (c.pod_id) {
    if (!(await podIfVisible(c.pod_id, user.id))) return res.status(404).json({ error: 'Kein Zugriff' })
  } else if (c.user_id !== user.id) {
    return res.status(404).json({ error: 'Conversation nicht gefunden' })
  }
  const ctl = activeTurns.get(c.id)
  if (!ctl) {
    // Kein laufender Turn in diesem Prozess (z.B. nach Restart hängengebliebenes Flag) → aufräumen
    await db.from('conversations').update({ working: false }).eq('id', c.id)
    return res.json({ ok: true, running: false })
  }
  ctl.abort()
  res.json({ ok: true, running: true })
})

app.post('/api/chat', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })

  const { conversation_id, message, model, attachments } = req.body || {}
  if (!message?.trim() && !attachments?.length) return res.status(400).json({ error: 'message fehlt' })
  if (model && !ALLOWED_MODELS.includes(model)) return res.status(400).json({ error: 'Unbekanntes Modell' })
  let fileBlocks = []
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

  // Verlauf ab letztem Compaction-Anker laden und User-Message persistieren.
  // Datei-Inhalte gehen nur in DIESEM Turn ans Modell; im Verlauf bleibt ein Text-Marker.
  const prior = await buildHistory(convId, !!pod)
  const meta = attachmentMeta(attachments)
  const storedText = meta.length
    ? `${message || ''}\n\n[Angehängte Dateien: ${meta.map((m) => m.name).join(', ')}]`.trim()
    : message
  await db.from('messages').insert({
    conversation_id: convId,
    role: 'user',
    content: storedText,
    attachments: meta.length ? meta : null,
    author_id: user.id,
  })
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
    // Ausnahme: ein Slash-Skill-Aufruf (/health-check …) richtet sich immer an Enni.
    const slashMatch = (message || '').match(/^\/([a-z0-9-]+)/i)
    const enniMentioned = /@enni\b/i.test(message || '') || !!slashMatch
    if (pod && !enniMentioned) {
      if (titlePromise) {
        const t = await titlePromise
        if (t?.title) {
          await db.from('conversations').update({ title: t.title }).eq('id', convId)
          await logUsage({ userId: user.id, conversationId: convId, messageId: null, model: t.model, usage: t.usage })
          emit({ type: 'title', title: t.title })
        }
      }
      await db.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId)
      emit({ type: 'done', message_id: null, cost_eur: 0, team_message: true })
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
        `Du wurdest gerade mit @enni gerufen; die aktuelle Nachricht kommt von ${senderName}. User-Nachrichten sind mit dem Absender-Namen geprefixt. ` +
        `Du hast Zugriff auf den GESAMTEN Pod über die pod_-Tools: Aufgabenliste (pod_list_tasks), geteilte Dateien (pod_list_files / pod_read_file) und die anderen Konversationen (pod_list_conversations / pod_read_conversation). Nutze sie, wenn die Frage Pod-Kontext braucht.` +
        (pod.description ? `\nPod-Beschreibung: ${pod.description}` : '') +
        (pod.instructions ? `\n\nInstructions for Agents (gelten in diesem Pod):\n${pod.instructions}` : '')
    }
    // Slash-Command: /slug am Nachrichtenanfang ruft einen Skill explizit auf —
    // voller Skill geht als System-Block mit, Enni startet mit einem Workflow-Overview.
    if (slashMatch) {
      const { data: skill } = await db
        .from('skills')
        .select('*')
        .eq('slug', slashMatch[1].toLowerCase())
        .eq('enabled', true)
        .maybeSingle()
      // Persönliche Skills gelten nur für ihren Ersteller (team-weite für alle)
      if (skill && (skill.visibility === 'team' || skill.created_by === user.id)) {
        const { skillText } = await import('./tools/skills.js')
        extraSystem =
          (extraSystem ? extraSystem + '\n\n' : '') +
          `Der Nutzer hat den Skill /${skill.slug} explizit per Slash-Command aufgerufen. Vollständiger Skill:\n\n${skillText(skill)}\n\nBeginne deine Antwort mit einem kompakten Workflow-Overview (nummerierte Schritte, je eine Zeile — was du jetzt tun wirst), dann arbeite den Workflow ab. Fehlen dir dafür nötige Inputs, stelle GENAU EINE gebündelte Rückfrage nach allen fehlenden Angaben.`
      }
    }

    // Multi-Session-Lock: pro Konversation nur EIN laufender Turn. Atomar via
    // UPDATE … WHERE working=false — verlieren beide gleichzeitig, gewinnt genau einer.
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
      await db.from('conversations').update({ working: false }).eq('id', convId)
      throw err
    } finally {
      activeTurns.delete(convId)
    }
    const durationMs = Date.now() - turnStarted

    // Assistant-Message inkl. Gedankenkette + Tool-Calls persistieren
    const { data: msg } = await db
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: result.text || (result.aborted ? '_Gestoppt._' : ''),
        thinking: result.thinking || null,
        tool_calls: result.toolCalls.length ? result.toolCalls : null,
        duration_ms: durationMs,
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
    // unread=true → grüner Sidebar-Punkt; der Client löscht es sofort, wenn er live zuschaut
    await db
      .from('conversations')
      .update({ updated_at: new Date().toISOString(), working: false, unread: true })
      .eq('id', convId)

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
    emit({ type: 'error', message: err.message })
  }
  progress.close()
  res.end()
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

// Kollegen einladen (Admin): erzeugt einen Invite-/Login-Link zum Weitergeben.
// Bewusst Link-basiert statt E-Mail-Versand — Supabase-SMTP ist rate-limitiert und
// der Admin verschickt den Link ohnehin persönlich (Slack/Mail).
const SITE_URL = process.env.SITE_URL || 'https://enneo-os.netlify.app'
app.post('/api/invite', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const email = String(req.body?.email || '').trim().toLowerCase()
  const role = req.body?.role === 'admin' ? 'admin' : 'member'
  if (!/^[a-z0-9._%+-]+@enneo\.ai$/.test(email)) {
    return res.status(400).json({ error: 'Nur @enneo.ai-Adressen können eingeladen werden.' })
  }
  const opts = { redirectTo: SITE_URL }
  const { error: pendingError } = await db.from('pending_invites').upsert({
    email, requested_role: role, invited_by: user.id,
    expires_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  }, { onConflict: 'email' })
  if (pendingError) return res.status(400).json({ error: pendingError.message })
  let existing = false
  let { data, error } = await db.auth.admin.generateLink({
    type: 'invite', email,
    options: { ...opts, data: { full_name: String(req.body?.name || '').trim() } },
  })
  if (error && /already|registered|exists/i.test(error.message)) {
    // User existiert schon → Login-Link statt Invite
    existing = true
    ;({ data, error } = await db.auth.admin.generateLink({ type: 'magiclink', email, options: opts }))
  }
  if (error) {
    await db.from('pending_invites').delete().eq('email', email)
    return res.status(400).json({ error: error.message })
  }
  if (existing) {
    await db.from('pending_invites').delete().eq('email', email)
  }
  const link = data?.properties?.action_link || data?.action_link
  if (!link) return res.status(500).json({ error: 'Kein Link erzeugt' })
  await logAudit(user.id, existing ? 'member.reinvite' : 'member.invite', 'profile', email, { role })
  res.json({ link, existing, role })
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

app.post('/api/routines/:id/:action(approve|reject|demote)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const visibility = req.params.action === 'approve' ? 'team' : 'personal'
  const { data, error } = await db.from('routines').update({ visibility }).eq('id', req.params.id)
    .select('id, name, visibility').maybeSingle()
  if (error) return res.status(400).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Routine nicht gefunden' })
  await logAudit(user.id, `routine.${req.params.action}`, 'routine', data.id, { visibility })
  res.json({ ok: true, routine: data })
})

app.post('/api/wiki-pages/:id/:action(approve|reject|demote)', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const visibility = req.params.action === 'approve' ? 'team' : 'personal'
  const { data, error } = await db.from('wiki_pages').update({ visibility, updated_by: user.id }).eq('id', req.params.id)
    .select('id, slug, title, visibility').maybeSingle()
  if (error) return res.status(400).json({ error: error.message })
  if (!data) return res.status(404).json({ error: 'Seite nicht gefunden' })
  await logAudit(user.id, `wiki_page.${req.params.action}`, 'wiki_page', data.id, { visibility })
  res.json({ ok: true, page: data })
})

app.post('/api/connectors', async (req, res) => {
  // Jeder Account darf Tools verbinden: Non-Admins immer als persoenliches Tool
  // (owner = eigener Account); Admins legen standardmaessig team-weit an.
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  const { data: prof } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
  const isAdmin = !!prof?.is_admin
  const { name, url, token, category, kind } = req.body || {}
  const personal = !isAdmin || req.body?.scope === 'personal'
  const requestedOwner = isAdmin && req.body?.owner ? String(req.body.owner) : user.id
  if (personal && requestedOwner !== user.id) {
    const { data: target } = await db.from('profiles').select('id').eq('id', requestedOwner).eq('account_status', 'active').maybeSingle()
    if (!target) return res.status(400).json({ error: 'Ziel-Account nicht gefunden oder deaktiviert.' })
  }
  const owner = personal ? requestedOwner : null
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
    res.json(await addConnector({ name, url, token, category, owner, visibility }, user.id))
  } catch (err) {
    res.status(400).json({ error: `Verbindung fehlgeschlagen: ${err.message}` })
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

// Tool fuers Unternehmen beantragen (Owner) bzw. freigeben/ablehnen (Admin).
// approve macht die hinterlegten Credentials fuer ALLE Accounts nutzbar ('team');
// reject stuft zurueck auf 'personal' (bleibt beim Owner nutzbar).
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
  // Pro nativem Anbieter gibt es max. EINEN Team-Connector — alter wird ersetzt.
  if (target === 'team' && ['attio', 'slack', 'outlook', 'google_drive', 'notion'].includes(conn.kind)) {
    await db.from('connectors').delete().eq('kind', conn.kind).eq('visibility', 'team').neq('id', conn.id)
  }
  const { error } = await db.from('connectors').update({ visibility: target }).eq('id', conn.id)
  if (error) return res.status(400).json({ error: error.message })
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
    const folder = slugPart(String(req.body?.folder || '')) || 'import'
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
  if (r.created_by !== user.id) {
    const { data: prof } = await db.from('profiles').select('is_admin').eq('id', user.id).maybeSingle()
    if (!prof?.is_admin) return res.status(403).json({ error: 'Nur Ersteller oder Admin' })
  }
  const result = await runRoutine(r)
  if (!result.ok) return res.status(500).json(result)
  res.json(result)
})

const port = Number(process.env.PORT || 8080)
app.listen(port, () => {
  console.log(`enneo OS backend läuft auf :${port}`)
  startKnowledgeSyncTicker()
})
startRoutineTicker()
