import { db } from './db.js'
import { runEnniTurn, ALLOWED_MODELS } from './agent.js'
import { logUsage } from './usage.js'

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

export async function runRoutine(r) {
  if (running.has(r.id)) return { ok: false, error: 'Läuft bereits' }
  running.add(r.id)
  try {
    const model = ALLOWED_MODELS.includes(r.model) ? r.model : 'claude-haiku-4-5'
    const title = `${r.name} · ${new Date().toLocaleDateString('de-DE')}`
    const { data: conv, error: convErr } = await db
      .from('conversations')
      .insert({ user_id: r.created_by, pod_id: r.pod_id || null, title, working: true })
      .select('id')
      .single()
    if (convErr) throw new Error(convErr.message)

    await db.from('messages').insert({
      conversation_id: conv.id,
      role: 'user',
      content: `[Routine "${r.name}"] ${r.prompt}`,
      author_id: r.created_by,
    })

    let extraSystem =
      `Dieser Lauf wurde von der geplanten Routine "${r.name}" ausgelöst (${r.schedule_label || r.cron}) — es liest kein Mensch live mit. ` +
      `Stelle KEINE Rückfragen: arbeite mit dem, was da ist, und liefere ein vollständiges, in sich geschlossenes Ergebnis. ` +
      `Wenn Daten fehlen oder ein Tool fehlschlägt, dokumentiere das klar im Ergebnis statt zu fragen.`
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
        userId: r.created_by,
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
      userId: r.created_by,
      conversationId: conv.id,
      messageId: msg?.id,
      model: result.model,
      usage: result.usage,
      source: 'routine',
    })
    // Fertig → grüner Punkt in der Sidebar, bis der Nutzer das Ergebnis öffnet
    await db.from('conversations').update({ working: false, unread: true }).eq('id', conv.id)

    await db
      .from('routines')
      .update({ last_run_at: new Date().toISOString(), last_result: 'ok' })
      .eq('id', r.id)
    return { ok: true, conversation_id: conv.id }
  } catch (err) {
    console.error(`Routine "${r.name}" fehlgeschlagen:`, err.message)
    await db
      .from('routines')
      .update({ last_run_at: new Date().toISOString(), last_result: `Fehler: ${err.message}`.slice(0, 500) })
      .eq('id', r.id)
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
