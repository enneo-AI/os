import { db } from './db.js'

// ============================================================ Live-Progress-Broadcast
// Spiegelt den Fortschritt eines laufenden Enni-Turns als Supabase-Realtime-Broadcast
// (Channel "progress-{conversationId}"). Wer die Konversation mittendrin öffnet
// (anderer Tab, anderes Gerät, Rückkehr nach Wegnavigieren), sieht Gedanken, Tools
// und den entstehenden Text live — nicht erst das fertige Ergebnis.
// Gedrosselt auf 1 Snapshot / 700ms, Payloads gekappt (Broadcast ist kein Datenspeicher).

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

  const state = { thinking: '', text: '', tools: [], phase: 'thinking' }
  let dirty = false

  const push = () => {
    if (!joined || !dirty) return
    dirty = false
    channel
      .send({
        type: 'broadcast',
        event: 'progress',
        payload: {
          thinking: state.thinking.slice(-4000),
          text: state.text.slice(-12000),
          tools: state.tools.slice(-20),
          phase: state.phase,
        },
      })
      .catch(() => {})
  }
  const timer = setInterval(push, 700)

  return {
    take(ev) {
      if (ev.type === 'thinking_delta') {
        state.thinking += ev.text
        state.phase = 'thinking'
      } else if (ev.type === 'text_delta') {
        state.text += ev.text
        state.phase = 'text'
      } else if (ev.type === 'tool_use') {
        // Text vor einem Tool-Call war Zwischen-Narrativ, kein finaler Antwort-Kandidat
        state.tools.push(ev.name)
        state.text = ''
        state.phase = 'tool'
      } else if (ev.type === 'done' || ev.type === 'error') {
        state.phase = 'done'
      } else {
        return
      }
      dirty = true
      if (state.phase === 'done') push()
    },
    close() {
      clearInterval(timer)
      // letzten Snapshot noch rausschicken lassen, dann Channel abbauen
      setTimeout(() => db.removeChannel(channel).catch(() => {}), 1500)
    },
  }
}
