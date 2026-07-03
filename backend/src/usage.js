import { db } from './db.js'

// USD pro 1M Tokens. Cache-Write = 1.25x Input, Cache-Read = 0.1x Input.
const PRICING = {
  'claude-opus-4-8':  { input: 5.0, output: 25.0 },
  'claude-sonnet-5':  { input: 3.0, output: 15.0 },
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
}

const EUR_PER_USD = Number(process.env.EUR_PER_USD || 0.92)

export function costEur(model, usage) {
  const key = Object.keys(PRICING).find((k) => model.startsWith(k))
  const p = PRICING[key] || PRICING['claude-opus-4-8']
  const usd =
    (usage.input_tokens / 1e6) * p.input +
    (usage.output_tokens / 1e6) * p.output +
    ((usage.cache_creation_input_tokens || 0) / 1e6) * p.input * 1.25 +
    ((usage.cache_read_input_tokens || 0) / 1e6) * p.input * 0.1
  return Number((usd * EUR_PER_USD).toFixed(6))
}

// Ein llm_usage-Eintrag pro Enni-Antwort (über alle Tool-Loop-Iterationen summiert).
export async function logUsage({ userId, conversationId, messageId, model, usage, source = 'chat' }) {
  const { error } = await db.from('llm_usage').insert({
    user_id: userId,
    conversation_id: conversationId,
    message_id: messageId,
    source,
    model,
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_input_tokens || 0,
    cache_write_tokens: usage.cache_creation_input_tokens || 0,
    cost_eur: costEur(model, usage),
  })
  if (error) console.error('llm_usage insert failed:', error.message)
  return costEur(model, usage)
}
