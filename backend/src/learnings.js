import Anthropic from '@anthropic-ai/sdk'
import { db } from './db.js'
import { logUsage } from './usage.js'

// ============================================================ Learnings-Layer
// Persönliche Learnings (Feedback + "Lernen & Schließen") wirken sofort für den
// eigenen Account. Nur explizit vorgeschlagene Feedback-Learnings gehen ins Admin-Review.

const anthropic = new Anthropic()
const MAX_BLOCK_CHARS = 2500 // pro Sektion — neueste zuerst, Rest fällt raus

export const learningToolDefinitions = [{
  name: 'learning_save_personal',
  description: 'Speichert eine ausdrückliche Korrektur oder Verhaltenspräferenz des aktuellen Nutzers dauerhaft für dessen zukünftige Enni-Konversationen. Nur verwenden, wenn der Nutzer ausdrücklich sagt, dass Enni daraus lernen, sich etwas merken oder es künftig anders machen soll.',
  input_schema: {
    type: 'object',
    properties: {
      learning: { type: 'string', description: 'Ein dauerhafter, eigenständig verständlicher Satz als konkrete Anweisung für Enni.' },
    },
    required: ['learning'],
    additionalProperties: false,
  },
}]

export async function runLearningTool(name, input, ctx = {}) {
  if (name !== 'learning_save_personal') throw new Error(`Unbekanntes Learning-Tool: ${name}`)
  if (!ctx.userId) throw new Error('Persönliches Learning benötigt einen eingeloggten Nutzer')
  const content = String(input?.learning || '').trim()
  if (content.length < 10) throw new Error('Das Learning ist zu kurz')
  if (content.length > 1000) throw new Error('Das Learning ist zu lang')

  const { data: existing } = await db
    .from('learnings')
    .select('id, content')
    .eq('user_id', ctx.userId)
    .eq('enabled', true)
    .limit(100)
  const duplicate = (existing || []).find((row) => row.content.trim().toLowerCase() === content.toLowerCase())
  if (duplicate) return JSON.stringify({ status: 'already_saved', learning_id: duplicate.id, learning: duplicate.content })

  const { data, error } = await db.from('learnings').insert({
    user_id: ctx.userId,
    content,
    source: 'feedback',
    source_conversation_id: ctx.conversationId || null,
    share_status: 'none',
  }).select('id, content').single()
  if (error) throw new Error(error.message)
  return JSON.stringify({ status: 'saved', learning_id: data.id, learning: data.content })
}

// System-Block für einen Turn: Team-weite (approved) + persönliche Learnings des Nutzers
export async function learningsPromptBlock(userId) {
  if (!userId) return null
  const { data } = await db
    .from('learnings')
    .select('content, user_id, share_status, created_at')
    .eq('enabled', true)
    .or(`user_id.eq.${userId},share_status.eq.approved`)
    .order('created_at', { ascending: false })
    .limit(100)
  if (!data?.length) return null

  const seen = new Set()
  const global = []
  const personal = []
  for (const l of data) {
    const key = l.content.trim().toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    if (l.share_status === 'approved') global.push(l.content)
    else if (l.user_id === userId) personal.push(l.content)
  }
  const cap = (arr) => {
    const out = []
    let n = 0
    for (const c of arr) {
      if (n + c.length > MAX_BLOCK_CHARS) break
      out.push(`- ${c}`)
      n += c.length
    }
    return out
  }
  const g = cap(global)
  const p = cap(personal)
  if (!g.length && !p.length) return null
  return (
    `# Learnings (dauerhaft beachten — aus Nutzer-Feedback entstanden)\n` +
    (g.length ? `Team-weit (gelten für alle):\n${g.join('\n')}\n` : '') +
    (p.length ? `Von DIESEM Nutzer (gelten nur in seinen Konversationen):\n${p.join('\n')}` : '')
  ).trim()
}

// "Lernen & Schließen": Haiku destilliert 1-3 dauerhafte Learnings aus der Konversation.
// Diese bleiben bewusst rein persönlich auf Account-Ebene.
export async function learnFromConversation(conversationId, userId) {
  const { data: msgs } = await db
    .from('messages')
    .select('role, content')
    .eq('conversation_id', conversationId)
    .order('created_at')
  const usable = (msgs || []).filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content)
  if (usable.length < 2) return { learnings: [], hinweis: 'Zu wenig Verlauf zum Lernen.' }

  const transcript = usable
    .map((m) => `${m.role === 'user' ? 'Nutzer' : 'Enni'}: ${m.content}`)
    .join('\n\n')
    .slice(0, 150000)

  const model = 'claude-haiku-4-5'
  const response = await anthropic.messages.create({
    model,
    max_tokens: 800,
    system:
      'Du destillierst aus einer Assistenz-Konversation DAUERHAFTE Learnings über die Präferenzen und Korrekturen des Nutzers — Dinge, die der Assistent in ZUKÜNFTIGEN Konversationen anders/besser machen soll. ' +
      'Beispiele: Antwortstil-Wünsche, korrigierte Fakten, bevorzugte Formate, wiederkehrende Arbeitsweisen. ' +
      'KEINE einmaligen Aufgabeninhalte, kein Smalltalk, keine Selbstverständlichkeiten. ' +
      'Jedes Learning: EIN Satz, als Anweisung formuliert (z.B. "Antworten für diesen Nutzer kurz halten, max. 5 Sätze."). ' +
      'Antworte NUR mit einem JSON-Array aus 0 bis 3 Strings. Leeres Array [], wenn nichts Dauerhaftes dabei ist.',
    messages: [{ role: 'user', content: transcript }],
  })
  await logUsage({ userId, conversationId, messageId: null, model, usage: response.usage, source: 'chat' })

  let items = []
  try {
    const text = response.content.find((b) => b.type === 'text')?.text || '[]'
    items = JSON.parse(text.slice(text.indexOf('['), text.lastIndexOf(']') + 1))
  } catch {
    return { learnings: [], hinweis: 'Extraktion lieferte kein verwertbares Ergebnis.' }
  }
  items = items.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3)
  if (!items.length) return { learnings: [], hinweis: 'Nichts dauerhaft Lernbares in dieser Konversation.' }

  const rows = items.map((content) => ({
    user_id: userId,
    content: content.trim(),
    source: 'conversation',
    source_conversation_id: conversationId,
    share_status: 'none',
  }))
  const { error } = await db.from('learnings').insert(rows)
  if (error) throw new Error(error.message)
  return { learnings: items }
}

// Admin-Review: approve = gilt für alle Accounts; reject = bleibt persönlich beim Urheber
export async function reviewLearning(id, action, adminId) {
  const { data: l } = await db.from('learnings').select('id, share_status').eq('id', id).maybeSingle()
  if (!l) throw new Error('Learning nicht gefunden')
  if (l.share_status !== 'proposed') throw new Error(`Learning ist bereits ${l.share_status}`)
  const share_status = action === 'approve' ? 'approved' : 'rejected'
  const { error } = await db
    .from('learnings')
    .update({ share_status, reviewed_by: adminId, reviewed_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new Error(error.message)
  return { share_status }
}

// Admin: Team-weites Learning wieder deaktivieren (zurück auf persönlich)
export async function demoteLearning(id, adminId) {
  const { error } = await db
    .from('learnings')
    .update({ share_status: 'rejected', reviewed_by: adminId, reviewed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('share_status', 'approved')
  if (error) throw new Error(error.message)
  return { share_status: 'rejected' }
}
