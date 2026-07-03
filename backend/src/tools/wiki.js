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

export async function runWikiTool(name, input) {
  if (name === 'wiki_semantic_search') {
    const embedding = await embedQuery(input.query)
    const { data, error } = await db.rpc('match_wiki_chunks', {
      query_embedding: JSON.stringify(embedding),
      match_count: 8,
    })
    if (error) throw new Error(error.message)
    if (!data?.length) return `Keine relevanten Abschnitte für "${input.query}" gefunden.`
    return data
      .map((c) => `[${c.slug} · Relevanz ${c.similarity.toFixed(2)}]\n${c.content}`)
      .join('\n\n---\n\n')
  }

  if (name === 'wiki_list_pages') {
    const { data, error } = await db
      .from('wiki_pages')
      .select('slug, title, updated_at')
      .order('title')
    if (error) throw new Error(error.message)
    return JSON.stringify(data)
  }

  if (name === 'wiki_read_page') {
    const { data, error } = await db
      .from('wiki_pages')
      .select('slug, title, content, updated_at')
      .eq('slug', input.slug)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return `Keine Wiki-Seite mit Slug "${input.slug}" gefunden. Nutze wiki_list_pages.`
    return `# ${data.title}\n\n${data.content}`
  }

  if (name === 'wiki_search') {
    const q = input.query.replaceAll('%', '').trim()
    const { data, error } = await db
      .from('wiki_pages')
      .select('slug, title, content')
      .or(`title.ilike.%${q}%,content.ilike.%${q}%`)
      .limit(8)
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
