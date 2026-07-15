import { db } from './db.js'
import { runEnniTurn, ALLOWED_MODELS } from './agent.js'
import { logUsage } from './usage.js'
import { createNotification } from './notifications.js'

// ============================================================ Routinen-Ticker
// Läuft im Railway-Prozess: alle 30s prüfen, welche Routine in der aktuellen
// Berlin-Minute fällig ist. Jeder Lauf erzeugt eine normale Konversation
// (privat beim Ersteller oder im Ziel-Pod) mit dem Prompt als User-Message
// und Ennis Antwort — Kosten landen in llm_usage mit source='routine'.

const running = new Set() // Routine-IDs, die gerade laufen (kein Doppel-Start)
let lastMinute = null

function berlinNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Berlin',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short',
    })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value])
  )
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    minute: Number(parts.minute),
    hour: Number(parts.hour === '24' ? '0' : parts.hour),
    dom: Number(parts.day),
    mon: Number(parts.month),
    dow: dowMap[parts.weekday],
    stamp: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`,
  }
}

// Minimaler 5-Feld-Cron-Matcher: * , Zahlen und Komma-Listen (reicht für die UI-Presets).
function fieldMatches(field, value, isDow = false) {
  if (field === '*') return true
  return field.split(',').some((part) => {
    let n = Number(part)
    if (isDow && n === 7) n = 0
    return n === value
  })
}

export function cronMatches(cron, t) {
  const f = cron.trim().split(/\s+/)
  if (f.length !== 5) return false
  return (
    fieldMatches(f[0], t.minute) &&
    fieldMatches(f[1], t.hour) &&
    fieldMatches(f[2], t.dom) &&
    fieldMatches(f[3], t.mon) &&
    fieldMatches(f[4], t.dow, true)
  )
}

async function routineAccountIds(r) {
  // Ein Pod ist bereits ein eigener Berechtigungsraum und bekommt genau einen Lauf.
  if (r.pod_id || !r.audience || r.audience === 'personal') return [r.created_by]
  if (r.audience === 'all') {
    const { data, error } = await db.from('profiles').select('id').eq('account_status', 'active')
    if (error) throw new Error(error.message)
    return (data || []).map((profile) => profile.id)
  }
  const { data: assignments, error } = await db
    .from('routine_accounts')
    .select('user_id')
    .eq('routine_id', r.id)
  if (error) throw new Error(error.message)
  const ids = [...new Set((assignments || []).map((assignment) => assignment.user_id))]
  if (!ids.length) return []
  const { data: active, error: profileError } = await db
    .from('profiles')
    .select('id')
    .eq('account_status', 'active')
    .in('id', ids)
  if (profileError) throw new Error(profileError.message)
  return (active || []).map((profile) => profile.id)
}

async function runRoutineForAccount(r, userId) {
  const model = ALLOWED_MODELS.includes(r.model) ? r.model : 'claude-haiku-4-5'
  const title = `${r.name} · ${new Date().toLocaleDateString('de-DE')}`
  const { data: conv, error: convErr } = await db
    .from('conversations')
    .insert({ user_id: userId, pod_id: r.pod_id || null, title, working: true })
    .select('id')
    .single()
  if (convErr) throw new Error(convErr.message)

  await db.from('messages').insert({
    conversation_id: conv.id,
    role: 'user',
    content: `[Routine "${r.name}"] ${r.prompt}`,
    author_id: userId,
  })

  let extraSystem =
    `Dieser Lauf wurde von der geplanten Routine "${r.name}" ausgelöst (${r.schedule_label || r.cron}) — es liest kein Mensch live mit. ` +
    `Stelle KEINE Rückfragen: arbeite mit dem, was da ist, und liefere ein vollständiges, in sich geschlossenes Ergebnis. ` +
    `Wenn Daten fehlen oder ein Tool fehlschlägt, dokumentiere das klar im Ergebnis statt zu fragen.`
  if (r.audience === 'all') extraSystem += '\nDiese Routine gilt für alle Accounts; verwende die persönlichen Tools und Learnings des aktuellen Ziel-Accounts.'
  if (r.audience === 'restricted') extraSystem += '\nDiese Routine gilt für ausgewählte Accounts; verwende die persönlichen Tools und Learnings des aktuellen Ziel-Accounts.'
  if (r.pod_id) {
    const { data: pod } = await db.from('pods').select('name, instructions').eq('id', r.pod_id).maybeSingle()
    if (pod) {
      extraSystem += `\nDas Ergebnis erscheint als Konversation im Pod "${pod.name}" — das Team liest es dort.` +
        (pod.instructions ? `\n\nInstructions for Agents (gelten in diesem Pod):\n${pod.instructions}` : '')
    }
  }

  let result
  try {
    result = await runEnniTurn([{ role: 'user', content: r.prompt }], () => {}, model, extraSystem, {
      userId,
      conversationId: conv.id,
      podId: r.pod_id || null,
    })
  } catch (err) {
    await db.from('conversations').update({ working: false }).eq('id', conv.id)
    throw err
  }

  const { data: msg } = await db
    .from('messages')
    .insert({
      conversation_id: conv.id,
      role: 'assistant',
      content: result.text,
      thinking: result.thinking || null,
      tool_calls: result.toolCalls.length ? result.toolCalls : null,
    })
    .select('id')
    .single()
  await logUsage({
    userId,
    conversationId: conv.id,
    messageId: msg?.id,
    model: result.model,
    usage: result.usage,
    source: 'routine',
  })
  await db.from('conversations').update({ working: false, unread: true }).eq('id', conv.id)
  try {
    await createNotification({
      user_id: userId,
      type: 'routine_complete',
      pod_id: r.pod_id || null,
      conversation_id: conv.id,
      message_id: msg?.id || null,
      title: `Routine abgeschlossen: ${r.name}`,
      body: (result.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
      action_url: r.pod_id ? `/pod/${r.pod_id}?tab=convs&conversation=${conv.id}` : `/chat/${conv.id}`,
      metadata: { routine_id: r.id, routine_name: r.name },
    })
  } catch (error) {
    console.error('Routine-Benachrichtigung fehlgeschlagen:', error.message)
  }
  return conv.id
}

export async function runRoutine(r) {
  if (running.has(r.id)) return { ok: false, error: 'Läuft bereits' }
  running.add(r.id)
  const finishedAt = new Date().toISOString()
  try {
    const accountIds = await routineAccountIds(r)
    if (!accountIds.length) throw new Error('Keine aktiven Accounts für diese Routine ausgewählt')
    const conversationIds = []
    const errors = []
    // Bewusst sequenziell: globale Routinen sollen keine API-Rate-Limit-Spitze erzeugen.
    for (const userId of accountIds) {
      try { conversationIds.push(await runRoutineForAccount(r, userId)) }
      catch (err) { errors.push(err.message) }
    }
    if (!conversationIds.length) throw new Error(errors[0] || 'Routine konnte für keinen Account ausgeführt werden')
    const lastResult = errors.length ? `${conversationIds.length}/${accountIds.length} Accounts erfolgreich · ${errors[0]}` : 'ok'
    await db.from('routines').update({ last_run_at: finishedAt, last_result: lastResult.slice(0, 500) }).eq('id', r.id)
    return {
      ok: true,
      conversation_id: conversationIds.length === 1 ? conversationIds[0] : undefined,
      conversation_ids: conversationIds,
      account_count: accountIds.length,
      errors,
    }
  } catch (err) {
    console.error(`Routine "${r.name}" fehlgeschlagen:`, err.message)
    await db.from('routines').update({ last_run_at: finishedAt, last_result: `Fehler: ${err.message}`.slice(0, 500) }).eq('id', r.id)
    return { ok: false, error: err.message }
  } finally {
    running.delete(r.id)
  }
}

async function tick() {
  const t = berlinNow()
  if (t.stamp === lastMinute) return // pro Minute nur einmal prüfen
  lastMinute = t.stamp
  try {
    const { data: routines } = await db.from('routines').select('*').eq('enabled', true)
    for (const r of routines || []) {
      if (cronMatches(r.cron, t)) runRoutine(r) // bewusst nicht awaiten — parallel, non-blocking
    }
  } catch (err) {
    console.error('Routine-Tick fehlgeschlagen:', err.message)
  }
}

export function startRoutineTicker() {
  setInterval(tick, 30000)
  console.log('Routinen-Ticker gestartet (30s-Intervall, Europe/Berlin)')
}
