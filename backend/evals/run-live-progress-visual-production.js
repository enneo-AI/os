import puppeteer from 'puppeteer-core'
import { db } from '../src/db.js'

const email = `live-progress-visual-${Date.now()}@example.invalid`
const password = `Live-Progress-${crypto.randomUUID()}-Aa1!`
let browser = null
let userId = null
let podId = null
let podConversationId = null
let privateConversationId = null

async function cleanup() {
  if (podId) await db.from('pods').delete().eq('id', podId)
  if (privateConversationId) await db.from('conversations').delete().eq('id', privateConversationId)
  if (userId) await db.auth.admin.deleteUser(userId)
}

try {
  const { data: created, error: userError } = await db.auth.admin.createUser({ email, password, email_confirm: true })
  if (userError) throw userError
  userId = created.user.id
  const now = new Date().toISOString()
  const { error: profileError } = await db.from('profiles').update({
    display_name: 'Live Progress QA',
    role_title: 'QA',
    about: 'Production visual verification',
    department: 'operations',
    departments: ['operations'],
    onboarding_completed_at: now,
    tour_completed_at: now,
  }).eq('id', userId)
  if (profileError) throw profileError

  const { data: pod, error: podError } = await db.from('pods').insert({
    name: 'Live Progress QA Pod',
    description: 'Temporary production verification',
    open: false,
    created_by: userId,
  }).select('id').single()
  if (podError) throw podError
  podId = pod.id

  const { data: podConversation, error: podConversationError } = await db.from('conversations').insert({
    user_id: userId,
    pod_id: podId,
    title: 'Aktiver Enni-Thread',
    working: true,
  }).select('id').single()
  if (podConversationError) throw podConversationError
  podConversationId = podConversation.id
  const { data: privateConversation, error: privateConversationError } = await db.from('conversations').insert({
    user_id: userId,
    title: 'Anderer Chat',
  }).select('id').single()
  if (privateConversationError) throw privateConversationError
  privateConversationId = privateConversation.id

  const { data: root, error: rootError } = await db.from('messages').insert({
    conversation_id: podConversationId,
    role: 'user',
    content: '@enni Analysiere bitte den Projektstand.',
    author_id: userId,
  }).select('id').single()
  if (rootError) throw rootError
  const { error: runError } = await db.from('conversation_runs').insert({
    conversation_id: podConversationId,
    pod_id: podId,
    thread_root_id: root.id,
    user_message_id: root.id,
    started_at: now,
    updated_at: now,
    phase: 'tool',
    status: 'Enni nutzt pod_list_tasks …',
    thinking: 'Ich prüfe Aufgaben, Dateien und den aktuellen Pod-Kontext.',
    tools: ['pod_list_tasks'],
  })
  if (runError) throw runError

  browser = await puppeteer.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: ['--no-sandbox'],
  })
  const page = await browser.newPage()
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 })
  const consoleErrors = []
  page.on('pageerror', (error) => consoleErrors.push(error.message))
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  await page.goto('https://os.enneo.ai/login', { waitUntil: 'networkidle2' })
  await page.type('#li-email', email)
  await page.type('#li-pw', password)
  await Promise.all([
    page.click('#login-form button[type="submit"]'),
    page.waitForFunction(() => !document.getElementById('app-view')?.hidden, { timeout: 15000 }),
  ])

  const activePodUrl = `https://os.enneo.ai/pod/${podId}?tab=convs&conversation=${podConversationId}`
  await page.goto(activePodUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#thread-panel.open .live-run-status', { timeout: 15000 })
  const firstVisit = await page.evaluate(() => ({
    status: document.querySelector('#thread-panel .live-run .t-status')?.textContent,
    threadOpen: document.querySelector('#thread-panel')?.classList.contains('open'),
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
  }))

  await page.goto(`https://os.enneo.ai/chat/${privateConversationId}`, { waitUntil: 'networkidle2' })
  await page.reload({ waitUntil: 'networkidle2' })
  await page.goto(activePodUrl, { waitUntil: 'networkidle2' })
  await page.waitForSelector('#thread-panel.open .live-run-status', { timeout: 15000 })
  await page.reload({ waitUntil: 'networkidle2' })
  await page.waitForSelector('#thread-panel.open .live-run-status', { timeout: 15000 })
  const afterReturnAndRefresh = await page.evaluate(() => ({
    status: document.querySelector('#thread-panel .live-run .t-status')?.textContent,
    threadOpen: document.querySelector('#thread-panel')?.classList.contains('open'),
    podMarkedWorking: !!document.querySelector(`[data-pod] .pod-work-label`),
    noOverflow: document.documentElement.scrollWidth <= window.innerWidth,
  }))
  const screenshot = '/tmp/enneo-live-progress-production.png'
  await page.screenshot({ path: screenshot, fullPage: true })

  const result = { firstVisit, afterReturnAndRefresh, consoleErrors, screenshot }
  if (!firstVisit.threadOpen || !firstVisit.status?.includes('pod_list_tasks') || !firstVisit.noOverflow) throw new Error(`First visit failed: ${JSON.stringify(result)}`)
  if (!afterReturnAndRefresh.threadOpen || !afterReturnAndRefresh.status?.includes('pod_list_tasks') || !afterReturnAndRefresh.podMarkedWorking || !afterReturnAndRefresh.noOverflow) throw new Error(`Return/refresh failed: ${JSON.stringify(result)}`)
  if (consoleErrors.length) throw new Error(`Browser errors: ${JSON.stringify(consoleErrors)}`)
  console.log(JSON.stringify(result))
} finally {
  if (browser) await browser.close()
  await cleanup()
}
