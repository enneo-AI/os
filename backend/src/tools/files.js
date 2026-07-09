import { db } from '../db.js'
import { wrapDocument, wrapPresentation } from '../brand/enneo-brand.js'

// ============================================================ Datei-Erstellung (enneo Brand)
// Enni erstellt herunterladbare Dateien: Dokumente (A4, druckbar) und Präsentationen
// (16:9 Slide-Deck mit Tastatur-Navigation) im enneo Design System, plus rohe
// Textdateien (CSV/Markdown/Text). Ablage: Storage-Bucket "generated-files",
// Auslieferung über Signed-URL (7 Tage gültig).

const BUCKET = 'generated-files'
const LINK_TTL = 7 * 24 * 3600

export const fileToolDefinitions = [
  {
    name: 'create_file',
    description:
      'Erstellt eine herunterladbare Datei und gibt einen Download-Link zurück (7 Tage gültig). Drei Arten: ' +
      '"document" = Dokument im enneo-Brand (A4-artig, druckbar als PDF über den Browser) — du lieferst NUR den inneren HTML-Body (h1/h2/h3, p, ul/ol, table, blockquote; Klassen: .lead für Intro-Absatz, .kpi-row > .kpi mit .v/.l für Kennzahlen, .accent für Purple-Hervorhebung). ' +
      '"presentation" = Slide-Deck im enneo-Brand (16:9, dunkel, Grain-Gradient, Pfeiltasten-Navigation, druckbar) — du lieferst eine Folge von <section class="slide">…</section>-Blöcken; erste Folie class="slide title" (mit .kicker + h1), Akzent-Folien class="slide accent"; in Folien: h2/h3, p, ul, .cols > .card, .big für große Zahlen, table. Max. ~6 Zeilen Inhalt pro Folie — lieber mehr Folien als volle. ' +
      '"raw" = beliebige Textdatei (CSV, Markdown, JSON, TXT) ohne Branding — du lieferst den kompletten Inhalt in "text" und eine filename-Endung passend zum Format. ' +
      'Sprache in Brand-Dateien: Deutsch, Sie-Form, kein Hype, KEINE Emojis. Zeige dem Nutzer den Link danach als Markdown-Link.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['document', 'presentation', 'raw'], description: 'Art der Datei' },
        filename: { type: 'string', description: 'Dateiname mit Endung, z. B. "kickoff-brief-stadtwerke.html" oder "export.csv". Für document/presentation immer .html' },
        title: { type: 'string', description: 'Titel (erscheint im Browser-Tab und Dokumentkopf)' },
        html: { type: 'string', description: 'document: innerer HTML-Body. presentation: die <section class="slide">-Blöcke. Bei raw weglassen.' },
        text: { type: 'string', description: 'Nur bei kind=raw: der komplette Dateiinhalt.' },
      },
      required: ['kind', 'filename', 'title'],
      additionalProperties: false,
    },
  },
]

export const MIME = {
  html: 'text/html; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
}

// Öffentliche Basis-URL des Backends — für den /files-Auslieferungs-Endpoint
// (Supabase Storage serviert HTML als text/plain, Anti-XSS; wir liefern inline aus)
export const PUBLIC_URL =
  process.env.PUBLIC_URL ||
  (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : 'http://localhost:8080')

export async function runFileTool(name, input, ctx = {}) {
  if (name !== 'create_file') throw new Error(`Unbekanntes File-Tool: ${name}`)
  const kind = input.kind
  let filename = String(input.filename || 'datei.html')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .toLowerCase()

  let content
  if (kind === 'raw') {
    if (!input.text) throw new Error('kind=raw braucht "text"')
    content = input.text
  } else {
    if (!input.html) throw new Error(`kind=${kind} braucht "html"`)
    if (!filename.endsWith('.html')) filename += '.html'
    content =
      kind === 'presentation'
        ? wrapPresentation({ title: input.title, slides: input.html })
        : wrapDocument({ title: input.title, body: input.html })
  }

  const ext = filename.split('.').pop()
  const path = `${ctx.userId || 'system'}/${Date.now()}-${filename}`
  const { error: upErr } = await db.storage
    .from(BUCKET)
    .upload(path, Buffer.from(content, 'utf8'), { contentType: MIME[ext] || 'application/octet-stream' })
  if (upErr) throw new Error(`Upload fehlgeschlagen: ${upErr.message}`)

  const { data: signed, error: signErr } = await db.storage.from(BUCKET).createSignedUrl(path, LINK_TTL)
  if (signErr) throw new Error(`Signed-URL fehlgeschlagen: ${signErr.message}`)

  // Über den Backend-Endpoint ausliefern: rendert im Browser statt als Plaintext-Download
  const viewUrl = `${PUBLIC_URL}/files?u=${encodeURIComponent(signed.signedUrl)}`

  return JSON.stringify({
    url: viewUrl,
    filename,
    gueltig_tage: 7,
    hinweis:
      'Datei erstellt. Gib dem Nutzer den Link als Markdown-Link im Format [' +
      filename +
      '](URL). Bei document/presentation: erwähne dass die Datei im Browser geöffnet und dort als PDF gedruckt werden kann (Präsentation: Pfeiltasten zum Blättern).',
  })
}
