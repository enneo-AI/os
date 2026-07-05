import express from 'express'
import cors from 'cors'
import { db, getUserFromRequest } from './db.js'
import { runEnniTurn, ALLOWED_MODELS } from './agent.js'
import { logUsage } from './usage.js'

const app = express()
app.use(express.json({ limit: '1mb' }))
app.use(
  cors({
    origin: (process.env.FRONTEND_ORIGIN || 'http://localhost:5173').split(','),
  })
)

app.get('/health', (_req, res) => res.json({ ok: true }))

// Verlauf ab dem letzten Compaction-Anker aufbauen (Dust-Muster)
async function buildHistory(convId) {
  const { data: all } = await db
    .from('messages')
    .select('role, content')
    .eq('conversation_id', convId)
    .order('created_at')
  const msgs = all || []
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
    if ((m.role === 'user' || m.role === 'assistant') && m.content) history.push({ role: m.role, content: m.content })
  }
  return history
}

// Konversations-Liste + Verlauf holt das Frontend direkt aus Supabase (RLS: owner-only).
// Das Backend braucht nur den Chat-Endpoint.

app.post('/api/chat', async (req, res) => {
  const user = await getUserFromRequest(req)
  if (!user) return res.status(401).json({ error: 'Nicht eingeloggt' })

  const { conversation_id, message, model } = req.body || {}
  if (!message?.trim()) return res.status(400).json({ error: 'message fehlt' })
  if (model && !ALLOWED_MODELS.includes(model)) return res.status(400).json({ error: 'Unbekanntes Modell' })

  // Conversation anlegen oder laden (Ownership prüfen)
  let convId = conversation_id
  if (convId) {
    const { data } = await db
      .from('conversations')
      .select('id, user_id')
      .eq('id', convId)
      .maybeSingle()
    if (!data || data.user_id !== user.id) return res.status(404).json({ error: 'Conversation nicht gefunden' })
  } else {
    const { data, error } = await db
      .from('conversations')
      .insert({ user_id: user.id, title: message.slice(0, 80) })
      .select('id')
      .single()
    if (error) return res.status(500).json({ error: error.message })
    convId = data.id
  }

  // Verlauf ab letztem Compaction-Anker laden und User-Message persistieren
  const prior = await buildHistory(convId)
  await db.from('messages').insert({ conversation_id: convId, role: 'user', content: message })
  const history = [...prior, { role: 'user', content: message }]

  // SSE-Stream öffnen
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  const emit = (event) => res.write(`data: ${JSON.stringify(event)}\n\n`)
  emit({ type: 'conversation', conversation_id: convId })

  try {
    const result = await runEnniTurn(history, emit, model)

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

const port = Number(process.env.PORT || 8080)
app.listen(port, () => console.log(`enneo OS backend läuft auf :${port}`))
