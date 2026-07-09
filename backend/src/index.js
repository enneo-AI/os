import express from 'express'
import cors from 'cors'
import { db, getUserFromRequest } from './db.js'
import { runEnniTurn, ALLOWED_MODELS, generateTitle } from './agent.js'
import { attachmentsToBlocks, attachmentMeta } from './attachments.js'
import { logUsage } from './usage.js'

const app = express()
app.use(express.json({ limit: '30mb' })) // Anhänge kommen als Base64 im Body
app.use(
  cors({
    origin: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(','),
  })
)

app.get('/health', (_req, res) => res.json({ ok: true }))

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
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
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
    const enniMentioned = /@enni\b/i.test(message || '')
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
    const result = await runEnniTurn(history, emit, model, extraSystem, {
      userId: user.id,
      conversationId: convId,
      podId: pod?.id || null,
    })

    // Assistant-Message inkl. Gedankenkette + Tool-Calls persistieren
    const { data: msg } = await db
      .from('messages')
      .insert({
        conversation_id: convId,
        role: 'assistant',
        content: result.text,
        thinking: result.thinking || null,
        tool_calls: result.toolCalls.length ? result.toolCalls : null,
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
    await db.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', convId)

    emit({ type: 'done', message_id: msg?.id, cost_eur: cost, usage: result.usage })

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
  res.end()
})

// Kontext komprimieren (Dust-Muster): Zusammenfassung als compaction-Message einfügen
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

// Wissens-Update-Freigabe: Lern-Karte im Chat → hier wird das Wiki wirklich geändert + RAG re-indexiert
app.post('/api/knowledge-update/:id/approve', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { applyKnowledgeUpdate } = await import('./tools/wiki.js')
    res.json(await applyKnowledgeUpdate(req.params.id, user.id))
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

app.post('/api/knowledge-update/:id/reject', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })
  try {
    const { rejectKnowledgeUpdate } = await import('./tools/wiki.js')
    res.json(await rejectKnowledgeUpdate(req.params.id, user.id))
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
    res.status(403).json({ error: 'Nur Admins können Integrationen verwalten' })
    return null
  }
  return user
}

app.post('/api/connectors', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  const { name, url, token, category } = req.body || {}
  if (!name?.trim() || !url?.trim()) return res.status(400).json({ error: 'Name und URL sind Pflicht' })
  if (!/^https:\/\//.test(url.trim())) return res.status(400).json({ error: 'URL muss mit https:// beginnen' })
  try {
    const { addConnector } = await import('./tools/mcp.js')
    res.json(await addConnector({ name, url, token, category }, user.id))
  } catch (err) {
    res.status(400).json({ error: `Verbindung fehlgeschlagen: ${err.message}` })
  }
})

app.delete('/api/connectors/:id', async (req, res) => {
  const user = await requireAdmin(req, res)
  if (!user) return
  try {
    const { removeConnector } = await import('./tools/mcp.js')
    await removeConnector(req.params.id)
    res.json({ ok: true })
  } catch (err) {
    res.status(400).json({ error: err.message })
  }
})

const port = Number(process.env.PORT || 8080)
app.listen(port, () => console.log(`enneo OS backend läuft auf :${port}`))
