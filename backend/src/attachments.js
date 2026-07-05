import * as XLSX from 'xlsx'

const MAX_FILE_BYTES = 10 * 1024 * 1024
const MAX_FILES = 4
const MAX_TABLE_CHARS = 60000

export const ALLOWED_TYPES = {
  'image/jpeg': 'image',
  'image/png': 'image',
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/vnd.ms-excel': 'excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'excel',
}

// Anhänge (Base64) -> Anthropic Content-Blocks. Excel/CSV werden als Text/CSV eingebettet,
// Bilder als image-Block, PDFs als document-Block. Inhalt geht nur im Upload-Turn ans Modell.
export function attachmentsToBlocks(attachments) {
  if (!Array.isArray(attachments)) return []
  if (attachments.length > MAX_FILES) throw new Error(`Maximal ${MAX_FILES} Dateien pro Nachricht`)
  const blocks = []
  for (const a of attachments) {
    const kind = ALLOWED_TYPES[a.media_type]
    if (!kind) throw new Error(`Dateityp nicht erlaubt: ${a.media_type} (${a.name})`)
    const bytes = Buffer.from(a.data, 'base64')
    if (bytes.length > MAX_FILE_BYTES) throw new Error(`${a.name} ist größer als 10 MB`)

    if (kind === 'image') {
      blocks.push({ type: 'image', source: { type: 'base64', media_type: a.media_type, data: a.data } })
    } else if (kind === 'pdf') {
      blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data } })
    } else if (kind === 'csv') {
      const text = bytes.toString('utf8').slice(0, MAX_TABLE_CHARS)
      blocks.push({ type: 'text', text: `<datei name="${a.name}" typ="csv">\n${text}\n</datei>` })
    } else if (kind === 'excel') {
      const wb = XLSX.read(bytes, { type: 'buffer' })
      let out = ''
      for (const sheetName of wb.SheetNames) {
        out += `\n--- Blatt: ${sheetName} ---\n`
        out += XLSX.utils.sheet_to_csv(wb.Sheets[sheetName])
        if (out.length > MAX_TABLE_CHARS) break
      }
      blocks.push({ type: 'text', text: `<datei name="${a.name}" typ="excel-als-csv">${out.slice(0, MAX_TABLE_CHARS)}\n</datei>` })
    }
  }
  return blocks
}

export function attachmentMeta(attachments) {
  return (attachments || []).map((a) => ({
    name: String(a.name || 'Datei').slice(0, 120),
    media_type: a.media_type,
    size: Math.round((a.data?.length || 0) * 0.75),
  }))
}
