import { db } from '../db.js'

// Query-Embedding über die embed Edge Function (gte-small, kostenlos)
async function embedQuery(text) {
  const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/embed`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ texts: [text] }),
  })
  if (!res.ok) throw new Error(`embed ${res.status}`)
  return (await res.json()).embeddings[0]
}

// Embeddings für mehrere Texte (Batch 2 — CPU-Limit der Edge Function)
async function embedTexts(texts) {
  const out = []
  for (let i = 0; i < texts.length; i += 2) {
    const batch = texts.slice(i, i + 2)
    const res = await fetch(`${process.env.SUPABASE_URL}/functions/v1/embed`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ texts: batch }),
    })
    if (!res.ok) throw new Error(`embed ${res.status}`)
    out.push(...(await res.json()).embeddings)
  }
  return out
}

// Markdown in RAG-Chunks schneiden: an ##-Überschriften, überlange Abschnitte an Absätzen splitten
function chunkMarkdown(title, content) {
  const MAX = 1500
  const sections = content.split(/\n(?=## )/)
  const chunks = []
  for (const sec of sections) {
    if (sec.length <= MAX) {
      if (sec.trim()) chunks.push(sec.trim())
      continue
    }
    let buf = ''
    for (const para of sec.split(/\n\n+/)) {
      if (para.length > MAX) {
        if (buf.trim()) { chunks.push(buf.trim()); buf = '' }
        let rest = para
        while (rest.length > MAX) {
          let cut = rest.lastIndexOf(' ', MAX)
          if (cut < Math.floor(MAX * 0.6)) cut = MAX
          chunks.push(rest.slice(0, cut).trim())
          rest = rest.slice(cut).trim()
        }
        buf = rest
        continue
      }
      if (buf && buf.length + para.length + 2 > MAX) {
        chunks.push(buf.trim())
        buf = ''
      }
      buf += (buf ? '\n\n' : '') + para
    }
    if (buf.trim()) chunks.push(buf.trim())
  }
  // Titel-Kontext in jeden Chunk, damit die Semantik-Suche die Seite zuordnen kann
  return chunks.map((c) => (c.startsWith('#') ? c : `[${title}]\n${c}`))
}

// Chunks einer Seite komplett neu embedden (nach jedem Apply)
export async function reindexPage(page) {
  const chunks = chunkMarkdown(page.title, page.content)
  const embeddings = await embedTexts(chunks)
  await db.from('wiki_chunks').delete().eq('page_id', page.id)
  if (!chunks.length) return 0
  const rows = chunks.map((content, i) => ({
    page_id: page.id,
    slug: page.slug,
    title: page.title,
    chunk_index: i,
    content,
    embedding: JSON.stringify(embeddings[i]),
  }))
  const { error } = await db.from('wiki_chunks').insert(rows)
  if (error) throw new Error(error.message)
  return rows.length
}

// Kompakter Zeilen-Diff für die Learn-Karte (gemeinsamer Prefix/Suffix raus, Mitte als -/+)
function lineDiff(oldText, newText) {
  const a = (oldText || '').split('\n')
  const b = (newText || '').split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length, endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB-- }
  const removed = a.slice(start, endA)
  const added = b.slice(start, endB)
  const lines = []
  if (start > 0) lines.push(`@@ Zeile ${start + 1} @@`)
  removed.forEach((l) => lines.push(`- ${l}`))
  added.forEach((l) => lines.push(`+ ${l}`))
  return lines.join('\n') || '(keine Änderung)'
}

export const wikiToolDefinitions = [
  {
    name: 'wiki_semantic_search',
    description:
      'Semantische Suche über das gesamte Firmenwissen (RAG). Liefert die relevantesten Abschnitte, nicht ganze Seiten. IMMER dein erstes Werkzeug bei Wissens- und Verständnisfragen. Nicht geeignet zum Zählen oder für "alle X auflisten" — dafür wiki_search/wiki_list_pages.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Die Frage oder das Thema in natürlicher Sprache' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'wiki_list_pages',
    description:
      'Listet alle Wiki-Seiten (slug + title). Nutze das zuerst, wenn du nicht weißt, welche Seiten existieren.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'wiki_read_page',
    description: 'Liest den vollständigen Markdown-Inhalt einer Wiki-Seite anhand ihres Slugs.',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Der Slug der Seite, z.B. "enneo-company"' },
      },
      required: ['slug'],
      additionalProperties: false,
    },
  },
  {
    name: 'wiki_propose_update',
    description:
      'Schlägt eine Änderung an einer Wiki-Seite vor (oder eine neue Seite). Führt NICHTS aus — der Vorschlag landet in der Review-Liste im Admin-Bereich; NUR der Admin sieht ihn dort und entscheidet gesammelt (typisch wöchentlich). Nutze das PROAKTIV, wenn du in der Konversation dauerhaft gültiges Firmenwissen lernst: neue Fakten, Korrekturen an bestehendem Wiki-Inhalt, Entscheidungen, Prozessänderungen. Lies die Seite VORHER mit wiki_read_page und gib den KOMPLETTEN neuen Markdown-Inhalt an (nicht nur die Änderung). Kein Vorschlag für flüchtige Infos (einmalige Termine, Smalltalk, Debugging-Zwischenstände).',
    input_schema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Slug der Zielseite. Existiert er nicht, wird eine neue Seite vorgeschlagen (kebab-case).' },
        title: { type: 'string', description: 'Titel — Pflicht bei neuer Seite, sonst nur bei Titel-Änderung.' },
        new_content: { type: 'string', description: 'Der VOLLSTÄNDIGE neue Markdown-Inhalt der Seite.' },
        summary: { type: 'string', description: 'Ein Satz für den Menschen: was ändert sich und warum (Quelle: diese Konversation).' },
      },
      required: ['slug', 'new_content', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'wiki_search',
    description:
      'Volltextsuche über Titel und Inhalt aller Wiki-Seiten. Rufe dies bei jeder Frage zu enneo-internem Wissen auf, bevor du aus dem Gedächtnis antwortest.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Suchbegriff oder Phrase' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
]

// Space-Rechte im Tool-Layer: Enni sieht beim Antworten NUR Spaces, die der fragende
// Nutzer sehen darf (open + eigene Restricted-Mitgliedschaften; Admins alles).
// Rückgabe null = kein Filter nötig (Admin), sonst Array erlaubter space_ids.
async function allowedSpaceIds(userId) {
  if (!userId) {
    const { data } = await db.from('spaces').select('id').eq('restricted', false)
    return (data || []).map((s) => s.id)
  }
  const [{ data: prof }, { data: spaces }, { data: members }] = await Promise.all([
    db.from('profiles').select('is_admin').eq('id', userId).maybeSingle(),
    db.from('spaces').select('id, restricted, created_by'),
    db.from('space_members').select('space_id').eq('user_id', userId),
  ])
  if (prof?.is_admin) return null
  const memberOf = new Set((members || []).map((m) => m.space_id))
  return (spaces || [])
    .filter((s) => !s.restricted || s.created_by === userId || memberOf.has(s.id))
    .map((s) => s.id)
}

export async function runWikiTool(name, input, ctx = {}) {
  const spaceIds = await allowedSpaceIds(ctx.userId)
  if (name === 'wiki_propose_update') {
    const slug = input.slug.trim().toLowerCase()
    let { data: page } = await db
      .from('wiki_pages')
      .select('id, title, content, space_id')
      .eq('slug', slug)
      .maybeSingle()
    // Restricted-Seite, die der Nutzer nicht sehen darf → wie "existiert nicht" behandeln
    if (page && spaceIds !== null && !spaceIds.includes(page.space_id)) page = null
    if (!page && !input.title) {
      return `Es gibt keine Seite "${slug}" — für eine neue Seite ist title Pflicht.`
    }
    const diff = page
      ? lineDiff(page.content, input.new_content)
      : input.new_content.split('\n').map((l) => `+ ${l}`).join('\n')
    const { data, error } = await db
      .from('knowledge_updates')
      .insert({
        wiki_page_id: page?.id || null,
        slug,
        new_title: input.title || null,
        new_content: input.new_content,
        summary: input.summary,
        diff,
        triggered_by: ctx.userId || null,
        source_conversation_id: ctx.conversationId || null,
      })
      .select('id')
      .single()
    if (error) throw new Error(error.message)
    return JSON.stringify({
      update_id: data.id,
      status: 'proposed',
      action: page ? 'update' : 'create',
      hinweis:
        'Vorschlag gespeichert — er landet in der Review-Liste des Admins (nicht beim Nutzer). Sag dem Nutzer in EINEM Satz, dass du dir das als Wissens-Vorschlag notiert hast und der Admin es prüft. Behaupte nie, das Wiki sei schon aktualisiert.',
    })
  }

  if (name === 'wiki_semantic_search') {
    const embedding = await embedQuery(input.query)
    // Mehr Kandidaten holen, dann auf sichtbare Spaces filtern und auf 8 kürzen
    const { data, error } = await db.rpc('match_wiki_chunks', {
      query_embedding: JSON.stringify(embedding),
      match_count: spaceIds === null ? 8 : 24,
    })
    if (error) throw new Error(error.message)
    let hits = data || []
    if (spaceIds !== null && hits.length) {
      const { data: pages } = await db
        .from('wiki_pages').select('slug, space_id').in('slug', [...new Set(hits.map((c) => c.slug))])
      const okSlugs = new Set((pages || []).filter((p) => spaceIds.includes(p.space_id)).map((p) => p.slug))
      hits = hits.filter((c) => okSlugs.has(c.slug)).slice(0, 8)
    }
    if (!hits.length) return `Keine relevanten Abschnitte für "${input.query}" gefunden.`
    return hits
      .map((c) => `[${c.slug} · Relevanz ${c.similarity.toFixed(2)}]\n${c.content}`)
      .join('\n\n---\n\n')
  }

  if (name === 'wiki_list_pages') {
    let q = db.from('wiki_pages').select('slug, title, updated_at').order('title')
    if (spaceIds !== null) q = q.in('space_id', spaceIds)
    const { data, error } = await q
    if (error) throw new Error(error.message)
    return JSON.stringify(data)
  }

  if (name === 'wiki_read_page') {
    let q = db
      .from('wiki_pages')
      .select('slug, title, content, updated_at, space_id')
      .eq('slug', input.slug)
    if (spaceIds !== null) q = q.in('space_id', spaceIds)
    const { data, error } = await q.maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return `Keine Wiki-Seite mit Slug "${input.slug}" gefunden. Nutze wiki_list_pages.`
    return `# ${data.title}\n\n${data.content}`
  }

  if (name === 'wiki_search') {
    const q = input.query.replaceAll('%', '').trim()
    let query = db
      .from('wiki_pages')
      .select('slug, title, content')
      .or(`title.ilike.%${q}%,content.ilike.%${q}%`)
      .limit(8)
    if (spaceIds !== null) query = query.in('space_id', spaceIds)
    const { data, error } = await query
    if (error) throw new Error(error.message)
    if (!data.length) return `Keine Treffer für "${input.query}".`
    // Pro Treffer ein Snippet um die Fundstelle, nicht die ganze Seite.
    return JSON.stringify(
      data.map((p) => {
        const idx = p.content.toLowerCase().indexOf(q.toLowerCase())
        const snippet =
          idx >= 0 ? p.content.slice(Math.max(0, idx - 200), idx + 400) : p.content.slice(0, 400)
        return { slug: p.slug, title: p.title, snippet }
      })
    )
  }

  throw new Error(`Unbekanntes Wiki-Tool: ${name}`)
}

// ============================================================ Wissens-Update-Loop
// Wird vom Freigabe-Endpoint in index.js aufgerufen — erst hier wird das Wiki wirklich geändert.
export async function applyKnowledgeUpdate(updateId, userId) {
  const { data: u } = await db.from('knowledge_updates').select('*').eq('id', updateId).maybeSingle()
  if (!u) throw new Error('Vorschlag nicht gefunden')
  if (u.status !== 'proposed') throw new Error(`Vorschlag ist bereits ${u.status}`)

  let result = null
  try {
    let page
    if (u.wiki_page_id) {
      const { data, error } = await db
        .from('wiki_pages')
        .update({
          content: u.new_content,
          ...(u.new_title ? { title: u.new_title } : {}),
          updated_by: userId,
        })
        .eq('id', u.wiki_page_id)
        .select('id, slug, title, content')
        .single()
      if (error) throw new Error(error.message)
      page = data
    } else {
      const { data, error } = await db
        .from('wiki_pages')
        .insert({
          slug: u.slug,
          title: u.new_title || u.slug,
          content: u.new_content,
          created_by: userId,
          updated_by: userId,
        })
        .select('id, slug, title, content')
        .single()
      if (error) throw new Error(error.message)
      page = data
    }
    // RAG sofort aktuell halten — sonst antwortet die Semantik-Suche mit altem Stand
    const n = await reindexPage(page)
    result = `Seite "${page.slug}" aktualisiert, ${n} RAG-Chunks neu indexiert.`
  } catch (err) {
    // Enum kennt nur proposed/approved/rejected → bei Apply-Fehler bleibt der Vorschlag proposed,
    // die Fehlermeldung landet in result und der Nutzer kann es erneut versuchen.
    await db.from('knowledge_updates').update({ result: err.message }).eq('id', updateId)
    return { status: 'failed', result: err.message }
  }

  await db
    .from('knowledge_updates')
    .update({
      status: 'approved',
      result,
      reviewed_by: userId,
      reviewed_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
    })
    .eq('id', updateId)
  return { status: 'approved', result }
}

export async function rejectKnowledgeUpdate(updateId, userId) {
  const { data: u } = await db.from('knowledge_updates').select('status').eq('id', updateId).maybeSingle()
  if (!u) throw new Error('Vorschlag nicht gefunden')
  if (u.status !== 'proposed') throw new Error(`Vorschlag ist bereits ${u.status}`)
  await db
    .from('knowledge_updates')
    .update({ status: 'rejected', reviewed_by: userId, reviewed_at: new Date().toISOString() })
    .eq('id', updateId)
  return { status: 'rejected' }
}
