const MUTATION_TOKEN = /(?:^|[-_])(create|add|append|insert|update|edit|set|move|duplicate|delete|remove|archive|restore|publish|send|write|patch|upsert|comment|assign|unassign|invite|revoke|approve|reject)(?:$|[-_])/i
const READ_TOKEN = /(?:^|[-_])(fetch|get|read|retrieve)(?:$|[-_])/i

const COMPLETION_WORD = /(?:\berledigt\b|\bdone\b|\bausgef(?:ü|ue)hrt\b|\bgespeichert\b|\bge(?:ä|ae)ndert\b|\baktualisiert\b|\bverschoben\b|\bzur(?:ü|ue)ckgesetzt\b|\berstellt\b|\bgel(?:ö|oe)scht\b|\bhinzugef(?:ü|ue)gt\b|\bentfernt\b|\bver(?:ö|oe)ffentlicht\b|\bupdated\b|\bchanged\b|\bmoved\b|\breset\b|\bcreated\b|\bdeleted\b|\bsaved\b)/i

const completionClaim = (text) => {
  const withoutNegatedClaims = String(text || '').replace(
    /\b(?:nicht|nie|kein(?:e|en|er|es)?|not|never)\b[^.!?\n]{0,80}(?:erledigt|done|ausgef(?:ü|ue)hrt|gespeichert|ge(?:ä|ae)ndert|aktualisiert|verschoben|zur(?:ü|ue)ckgesetzt|erstellt|gel(?:ö|oe)scht|hinzugef(?:ü|ue)gt|entfernt|ver(?:ö|oe)ffentlicht|updated|changed|moved|reset|created|deleted|saved)\b/gi,
    ''
  )
  return COMPLETION_WORD.test(withoutNegatedClaims)
}

// Erste-Person-/Passiv-Behauptung über eine EIGENE ausgeführte Änderung ("ich habe … gespeichert",
// "wurde … eingereicht"). Unterscheidet Ennis Aktions-Claims von beschreibenden Zustandsberichten
// ("2 Mails sind erledigt, 3 sind offen") — letztere sind in reinen Lese-Turns legitim.
const SELF_COMPLETION = /\b(?:ich|wir)\b[^.!?\n]{0,80}\b(?:erledigt|ausgef(?:ü|ue)hrt|gespeichert|ge(?:ä|ae)ndert|aktualisiert|verschoben|zur(?:ü|ue)ckgesetzt|erstellt|gel(?:ö|oe)scht|hinzugef(?:ü|ue)gt|entfernt|ver(?:ö|oe)ffentlicht|eingereicht|gesendet|verschickt)\b|\bwurde(?:n)?\b[^.!?\n]{0,80}\b(?:gespeichert|eingereicht|angelegt|erstellt|aktualisiert|ver(?:ö|oe)ffentlicht|gel(?:ö|oe)scht|gesendet|verschickt)\b|\bI\b[^.!?\n]{0,60}\b(?:saved|created|updated|deleted|moved|sent|submitted)\b/i

const successful = (call) => !!call && !call.is_error && !call.suppressed

export function isMutationToolName(name = '') {
  if (name === 'create_file' || name === 'learning_save_personal') return true
  if (name === 'wiki_propose_update' || name === 'enneo_propose_write') return false
  return MUTATION_TOKEN.test(name)
}

export function isNotionMutation(call) {
  return successful(call) && /notion/i.test(call.name || '') && isMutationToolName(call.name)
}

export function isNotionRead(call) {
  return successful(call) && call.verification_matches !== false && /notion/i.test(call.name || '') && READ_TOKEN.test(call.name || '') && !isMutationToolName(call.name)
}

function primitiveValues(value, out = []) {
  if (value == null) return out
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
      try { return primitiveValues(JSON.parse(trimmed), out) } catch { /* normal string */ }
    }
    if (trimmed) out.push(trimmed)
  } else if (typeof value === 'number' || typeof value === 'boolean') out.push(String(value))
  else if (Array.isArray(value)) value.forEach((item) => primitiveValues(item, out))
  else if (typeof value === 'object') Object.values(value).forEach((item) => primitiveValues(item, out))
  return out
}

export function notionReadBackMatches(writeInput, readOutput) {
  const payload = writeInput?.properties ?? writeInput?.property_updates ?? writeInput?.data
  const expected = [...new Set(primitiveValues(payload).map((value) => value.toLowerCase()))]
  if (!expected.length) return true
  const actual = String(readOutput || '').toLowerCase()
  return expected.every((value) => actual.includes(value))
}

function targetFromOutput(output) {
  const text = String(output || '')
  try {
    const parsed = JSON.parse(text)
    const queue = [parsed]
    while (queue.length) {
      const value = queue.shift()
      if (!value || typeof value !== 'object') continue
      if (typeof value.page_id === 'string') return value.page_id
      if (typeof value.id === 'string') return value.id
      queue.push(...Object.values(value))
    }
  } catch { /* MCP output may be prose rather than JSON */ }
  return text.match(/(?:page_id|\bid\b)["']?\s*[:=]\s*["']([0-9a-f-]{20,})["']/i)?.[1] || null
}

export function notionReadBackPlan(toolName, input, definitions, output = '') {
  if (!/notion/i.test(toolName || '') || !isMutationToolName(toolName)) return null
  const target = input?.page_id || input?.pageId || input?.id || targetFromOutput(output)
  if (!target) return null

  const separator = toolName.lastIndexOf('__')
  const namespace = separator >= 0 ? toolName.slice(0, separator + 2) : ''
  const candidates = (definitions || []).filter((definition) => {
    const name = definition?.name || ''
    return name !== toolName && (!namespace || name.startsWith(namespace)) && /notion/i.test(name) && READ_TOKEN.test(name) && !isMutationToolName(name)
  })
  const definition = candidates.find((item) => /(?:^|[-_])fetch(?:$|[-_])/i.test(item.name)) || candidates[0]
  if (!definition) return null

  const properties = definition.input_schema?.properties || {}
  const targetField = ['id', 'page_id', 'pageId'].find((field) => Object.hasOwn(properties, field)) || 'id'
  return { name: definition.name, input: { [targetField]: target } }
}

export function enforceWriteTruth(text, toolCalls) {
  if (!completionClaim(text)) return { text, changed: false, reason: null }

  const calls = toolCalls || []
  const successfulMutation = calls.some((call) => successful(call) && isMutationToolName(call.name))
  if (!successfulMutation) {
    // Reiner Lese-Turn (erfolgreiche Reads, kein Schreibversuch) ohne Ich-Aktions-Behauptung:
    // Erledigt-Wörter beschreiben hier fremden Zustand (z.B. Mail-Status) — kein falscher Write-Claim.
    const attemptedMutation = calls.some((call) => isMutationToolName(call?.name || ''))
    if (calls.some(successful) && !attemptedMutation && !SELF_COMPLETION.test(String(text || ''))) {
      return { text, changed: false, reason: null }
    }
    // Antwort erhalten, Korrektur sichtbar anhängen (Design 2026-07-17: anhängen, nicht ersetzen).
    return {
      text: `${String(text || '').trim()}\n\nKorrektur: In diesem Turn gab es keinen erfolgreichen Schreibzugriff. Eine oben als erledigt oder gespeichert beschriebene Änderung wurde nicht ausgeführt.`,
      changed: true,
      reason: 'missing_successful_write',
    }
  }
  const unverifiedNotionWrite = calls.some((call, index) => (
    isNotionMutation(call) && !calls.slice(index + 1).some(isNotionRead)
  ))
  if (unverifiedNotionWrite) {
    return {
      text: 'Die Notion-Änderung wurde vom Schreib-Tool angenommen, aber nicht durch erneutes Laden bestätigt. Ich kann sie deshalb noch nicht als verifiziert abgeschlossen melden.',
      changed: true,
      reason: 'missing_notion_readback',
    }
  }

  return { text, changed: false, reason: null }
}
