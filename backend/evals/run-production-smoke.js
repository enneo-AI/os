import { createClient } from '@supabase/supabase-js'

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']
for (const name of required) {
  if (!process.env[name]) throw new Error(`${name} fehlt`)
}

const apiUrl = (process.env.PRODUCTION_API_URL || 'https://enneo-os-backend-production.up.railway.app').replace(/\/$/, '')
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})
const email = `enni-production-smoke-${Date.now()}@example.invalid`
const password = `Smoke-${crypto.randomUUID()}-Aa1!`
let userId = null

try {
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: 'Enni Production Smoke Test' },
  })
  if (createError) throw createError
  userId = created.user.id

  const auth = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
  const { data: signedIn, error: signInError } = await auth.auth.signInWithPassword({ email, password })
  if (signInError) throw signInError

  const healthResponse = await fetch(`${apiUrl}/health`)
  const health = await healthResponse.json()
  if (!healthResponse.ok || health.ok !== true) throw new Error(`Health-Check fehlgeschlagen: ${JSON.stringify(health)}`)

  const response = await fetch(`${apiUrl}/api/chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${signedIn.session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: 'Was unterscheidet Copilot, Copilot+ und Autopilot bei enneo? Antworte direkt in genau drei kurzen Sätzen und nenne deine belastbare Grundlage.',
      model: process.env.EVAL_MODEL || 'claude-sonnet-5',
    }),
  })
  const body = await response.text()
  if (!response.ok) throw new Error(`Chat-Endpoint antwortet ${response.status}: ${body}`)

  const events = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => JSON.parse(line.slice(6)))
  const tools = events.filter((event) => event.type === 'tool_use').map((event) => event.name)
  const errors = events.filter((event) => event.type === 'error')
  const done = events.find((event) => event.type === 'done')
  const conversation = events.find((event) => event.type === 'conversation')

  let answer = events
    .filter((event) => event.type === 'text' || event.type === 'text_delta')
    .map((event) => event.text || event.delta || '')
    .join('')
    .trim()
  if (!answer && conversation?.conversation_id) {
    const { data: message } = await admin
      .from('messages')
      .select('content')
      .eq('conversation_id', conversation.conversation_id)
      .eq('role', 'assistant')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    answer = message?.content?.trim() || ''
  }

  const checks = {
    health: health.ok === true,
    chromium: String(health.pdf || '').includes('chromium'),
    completed: Boolean(done),
    noErrors: errors.length === 0,
    grounded: tools.some((name) => name.startsWith('wiki_')),
    direct: answer.length > 40 && !/^(gerne|natürlich|das ist eine gute frage|ich helfe)/i.test(answer),
  }
  const pass = Object.values(checks).every(Boolean)
  console.log(JSON.stringify({ pass, checks, deployment: apiUrl, tools, answer }))
  if (!pass) process.exitCode = 1
} finally {
  if (userId) {
    await admin.from('conversations').delete().eq('user_id', userId)
    await admin.storage.from('generated-files').remove((await admin.storage.from('generated-files').list(userId)).data?.map((file) => `${userId}/${file.name}`) || [])
    await admin.auth.admin.deleteUser(userId)
  }
}
