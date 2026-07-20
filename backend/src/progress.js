import { db } from './db.js'

// ============================================================ Live-Progress-Broadcast
// Spiegelt den Fortschritt eines laufenden Enni-Turns als Supabase-Realtime-Broadcast
// (Channel "progress-{conversationId}"). Wer die Konversation mittendrin öffnet
// (anderer Tab, anderes Gerät, Rückkehr nach Wegnavigieren), sieht Gedanken, Tools
// und den entstehenden Text live — nicht erst das fertige Ergebnis.
// Gedrosselt auf 1 Snapshot / 700ms, Payloads gekappt. conversation_runs ist die
// dauerhafte Quelle; Broadcast liefert nur zusätzliche Live-Geschwindigkeit.

export function createProgressBroadcaster(conversationId) {
  const channel = db.channel('progress-' + conversationId)
  let joined = false
  try {
    channel.subscribe((status) => {
      joined = status === 'SUBSCRIBED'
    })
  } catch (err) {
    console.error('Progress-Channel subscribe fehlgeschlagen:', err.message)
  }

  const state = {
    thinking: '', text: '', tools: [], phase: 'thinking',
    status: 'Enni denkt nach …', podId: null, threadRootId: null,
    userMessageId: null, startedAt: null,
  }
  let active = false
  let dirty = false
  let persisting = false
  let persistPromise = Promise.resolve()

  const push = () => {
    if (!active || !dirty || persisting) return
    dirty = false
    const payload = {
      conversation_id: conversationId,
      pod_id: state.podId,
      thread_root_id: state.threadRootId,
      user_message_id: state.userMessageId,
      started_at: state.startedAt,
      updated_at: new Date().toISOString(),
      phase: state.phase,
      status: state.status,
      thinking: state.thinking.slice(-4000),
      response_text: state.text.slice(-12000),
      tools: state.tools.slice(-20),
    }
    // Persistenz ist die Quelle für Refresh/Wiedereinstieg. Broadcast reduziert
    // nur die sichtbare Latenz für bereits verbundene Clients.
    persisting = true
    persistPromise = db.from('conversation_runs').upsert(payload, { onConflict: 'conversation_id' }).then(({ error }) => {
      if (error) console.error('Progress-Snapshot konnte nicht gespeichert werden:', error.message)
      persisting = false
      if (dirty) queueMicrotask(push)
    })
    if (joined) channel
      .send({
        type: 'broadcast',
        event: 'progress',
        payload,
      })
      .catch(() => {})
  }
  const timer = setInterval(push, 700)

  return {
    start({ podId = null, threadRootId = null, userMessageId = null, startedAt = new Date().toISOString() } = {}) {
      state.podId = podId
      state.threadRootId = threadRootId
      state.userMessageId = userMessageId
      state.startedAt = startedAt
      active = true
      dirty = true
      push()
    },
    take(ev) {
      if (ev.type === 'thinking_delta') {
        state.thinking += ev.text
        state.phase = 'thinking'
        state.status = 'Enni denkt nach …'
      } else if (ev.type === 'text_delta') {
        state.text += ev.text
        state.phase = 'text'
        state.status = 'Enni schreibt …'
      } else if (ev.type === 'text_replace') {
        state.text = ev.text || ''
        state.phase = 'finalizing'
        state.status = 'Enni schließt die Antwort ab …'
      } else if (ev.type === 'tool_use') {
        // Text vor einem Tool-Call war Zwischen-Narrativ, kein finaler Antwort-Kandidat
        state.tools.push(ev.name)
        state.text = ''
        state.phase = 'tool'
        state.status = `Enni nutzt ${ev.name} …`
      } else if (ev.type === 'done' || ev.type === 'error') {
        return
      } else {
        return
      }
      dirty = true
    },
    async close() {
      clearInterval(timer)
      active = false
      dirty = false
      await persistPromise.catch(() => {})
      setTimeout(() => db.removeChannel(channel).catch(() => {}), 1500)
    },
  }
}
