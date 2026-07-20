// Pod-Kontext-Tools: In Pod-Konversationen (Enni wird per @enni gerufen) kann Enni
// auf den GESAMTEN Pod zugreifen — Aufgabenliste, geteilte Dateien, Notizen,
// Meeting-Transkripte und die anderen Konversationen. Alle Tools sind an ctx.podId gebunden (read-only,
// außer Task-Status-Updates gibt es hier bewusst nicht).

import * as XLSX from 'xlsx'
import { db } from '../db.js'

export const podToolDefinitions = [
  {
    name: 'pod_list_tasks',
    description: 'Listet die Aufgaben (To-dos) dieses Pods, gruppiert nach Abschnitt, mit Status, Fälligkeit und Ersteller.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pod_list_files',
    description: 'Listet die im Pod geteilten Dateien (Name, Typ, Größe).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pod_read_file',
    description:
      'Liest eine im Pod geteilte Datei. CSV/Text direkt, Excel als CSV konvertiert. Bilder/PDFs können hier nicht gelesen werden — bitte den Nutzer, sie im Chat anzuhängen.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Dateiname aus pod_list_files' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'pod_list_notes',
    description: 'Listet kurze Notizen und Meeting-Transkripte dieses Pods mit ID, Titel, Datum, Autor und Vorschau. Liest nicht automatisch den vollständigen Inhalt.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['note', 'meeting_transcript'], description: 'Optional nur kurze Notizen oder nur Meeting-Transkripte.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pod_read_note',
    description: 'Liest den vollständigen Inhalt einer Pod-Notiz oder eines Meeting-Transkripts per ID aus pod_list_notes.',
    input_schema: {
      type: 'object',
      properties: { note_id: { type: 'string' } },
      required: ['note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'pod_list_conversations',
    description: 'Listet die anderen Konversationen dieses Pods (Titel, zuletzt aktiv).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'pod_read_conversation',
    description: 'Liest den Verlauf einer anderen Pod-Konversation (per ID aus pod_list_conversations).',
    input_schema: {
      type: 'object',
      properties: { conversation_id: { type: 'string' } },
      required: ['conversation_id'],
      additionalProperties: false,
    },
  },
]

async function names() {
  const { data } = await db.from('profiles').select('id, display_name, email')
  return Object.fromEntries((data || []).map((p) => [p.id, p.display_name || p.email]))
}

export async function runPodTool(name, input, ctx) {
  const podId = ctx?.podId
  if (!podId) return 'Diese Konversation gehört zu keinem Pod — die pod_-Tools sind hier nicht verfügbar.'

  if (name === 'pod_list_tasks') {
    const [{ data }, byId] = await Promise.all([
      db.from('pod_tasks').select('title, status, section, due_date, assignee, created_by, created_at').eq('pod_id', podId).order('section').order('created_at'),
      names(),
    ])
    if (!data?.length) return 'Keine Aufgaben in diesem Pod.'
    const bySection = new Map()
    for (const t of data) {
      const s = t.section || 'Allgemein'
      if (!bySection.has(s)) bySection.set(s, [])
      bySection.get(s).push(t)
    }
    return [...bySection.entries()]
      .map(([section, ts]) =>
        `## ${section}\n` +
        ts.map((t) => `- [${t.status}] ${t.title}${t.due_date ? ` — fällig ${t.due_date}` : ''}${t.assignee ? ` — zugewiesen an ${byId[t.assignee] || '?'}` : ''} (von ${byId[t.created_by] || '?'})`).join('\n'))
      .join('\n\n')
  }

  if (name === 'pod_list_files') {
    const { data } = await db.from('pod_files').select('name, media_type, size').eq('pod_id', podId).order('created_at')
    if (!data?.length) return 'Keine Dateien in diesem Pod.'
    return data.map((f) => `- ${f.name} (${f.media_type || '?'}, ${(f.size / 1024).toFixed(0)} KB)`).join('\n')
  }

  if (name === 'pod_read_file') {
    const { data: f } = await db
      .from('pod_files').select('name, media_type, storage_path, size')
      .eq('pod_id', podId).eq('name', input.name).maybeSingle()
    if (!f) return `Datei "${input.name}" nicht gefunden — pod_list_files zeigt die verfügbaren Namen.`
    if (f.size > 10 * 1024 * 1024) return 'Datei ist größer als 10 MB — kann nicht gelesen werden.'
    const { data: blob, error } = await db.storage.from('pod-files').download(f.storage_path)
    if (error) throw new Error(error.message)
    const bytes = Buffer.from(await blob.arrayBuffer())
    const mt = f.media_type || ''
    if (mt.includes('spreadsheet') || mt.includes('ms-excel')) {
      const wb = XLSX.read(bytes, { type: 'buffer' })
      let out = ''
      for (const s of wb.SheetNames) {
        out += `\n--- Blatt: ${s} ---\n` + XLSX.utils.sheet_to_csv(wb.Sheets[s])
        if (out.length > 60000) break
      }
      return out.slice(0, 60000)
    }
    if (mt.startsWith('text/') || mt.includes('csv') || mt.includes('json') || /\.(md|txt|csv|json)$/i.test(f.name)) {
      return bytes.toString('utf8').slice(0, 60000)
    }
    return `"${f.name}" ist ${mt || 'ein Binärformat'} — kann hier nicht als Text gelesen werden. Bitte den Nutzer, die Datei im Chat anzuhängen.`
  }

  if (name === 'pod_list_notes') {
    let query = db
      .from('pod_notes')
      .select('id, kind, title, content, meeting_date, created_by, updated_at')
      .eq('pod_id', podId)
      .order('updated_at', { ascending: false })
      .limit(50)
    if (input?.kind) query = query.eq('kind', input.kind)
    const [{ data, error }, byId] = await Promise.all([query, names()])
    if (error) throw new Error(error.message)
    if (!data?.length) return 'Keine Notizen oder Meeting-Transkripte in diesem Pod.'
    return data.map((note) => {
      const type = note.kind === 'meeting_transcript' ? 'Meeting-Transkript' : 'Notiz'
      const title = note.title?.trim() || (note.content || '').replace(/\s+/g, ' ').slice(0, 80) || 'Ohne Titel'
      const preview = (note.content || '').replace(/\s+/g, ' ').slice(0, 220)
      return `- [${type}] ${title} (id: ${note.id}${note.meeting_date ? `, Meeting: ${note.meeting_date}` : ''}, von ${byId[note.created_by] || '?'}, aktualisiert ${note.updated_at})\n  ${preview}`
    }).join('\n')
  }

  if (name === 'pod_read_note') {
    const [{ data: note, error }, byId] = await Promise.all([
      db.from('pod_notes').select('id, pod_id, kind, title, content, meeting_date, created_by, updated_at').eq('id', input.note_id).maybeSingle(),
      names(),
    ])
    if (error) throw new Error(error.message)
    if (!note || note.pod_id !== podId) return 'Notiz nicht gefunden oder gehört nicht zu diesem Pod.'
    const type = note.kind === 'meeting_transcript' ? 'Meeting-Transkript' : 'Notiz'
    return `# ${note.title?.trim() || type}\n\nTyp: ${type}${note.meeting_date ? `\nMeeting-Datum: ${note.meeting_date}` : ''}\nAutor: ${byId[note.created_by] || 'Unbekannt'}\nAktualisiert: ${note.updated_at}\n\n${note.content}`.slice(0, 120000)
  }

  if (name === 'pod_list_conversations') {
    const { data } = await db
      .from('conversations').select('id, title, updated_at')
      .eq('pod_id', podId).neq('id', ctx.conversationId || '').order('updated_at', { ascending: false }).limit(25)
    if (!data?.length) return 'Keine weiteren Konversationen in diesem Pod.'
    return data.map((c) => `- ${c.title || 'Ohne Titel'} (id: ${c.id}, zuletzt ${c.updated_at})`).join('\n')
  }

  if (name === 'pod_read_conversation') {
    const { data: conv } = await db
      .from('conversations').select('id, title, pod_id').eq('id', input.conversation_id).maybeSingle()
    if (!conv || conv.pod_id !== podId) return 'Konversation nicht gefunden oder gehört nicht zu diesem Pod.'
    const [{ data: msgs }, byId] = await Promise.all([
      db.from('messages').select('role, content, author_id, created_at').eq('conversation_id', conv.id).order('created_at').limit(60),
      names(),
    ])
    const lines = (msgs || []).map((m) => {
      const who = m.role === 'assistant' ? 'Enni' : byId[m.author_id] || 'Nutzer'
      return `${who}: ${(m.content || '').slice(0, 1200)}`
    })
    return `# ${conv.title || 'Ohne Titel'}\n\n${lines.join('\n\n')}`.slice(0, 50000)
  }

  throw new Error(`Unbekanntes Pod-Tool: ${name}`)
}
