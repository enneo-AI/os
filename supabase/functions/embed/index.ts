// enneo OS — Embedding-Function (gte-small, 384 Dim., eingebaut in Supabase Edge Runtime)
// POST { texts: string[] } -> { embeddings: number[][] }
// Auth: Supabase-Key (anon oder service_role) als Bearer — verify_jwt bleibt an.

const model = new Supabase.ai.Session('gte-small')

Deno.serve(async (req) => {
  try {
    const { texts } = await req.json()
    if (!Array.isArray(texts) || !texts.length || texts.length > 32) {
      return Response.json({ error: 'texts: Array mit 1-32 Strings erwartet' }, { status: 400 })
    }
    const embeddings = []
    for (const t of texts) {
      embeddings.push(await model.run(String(t).slice(0, 8000), { mean_pool: true, normalize: true }))
    }
    return Response.json({ embeddings })
  } catch (err) {
    return Response.json({ error: String(err?.message || err) }, { status: 500 })
  }
})
