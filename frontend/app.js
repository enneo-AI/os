import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { marked } from 'https://esm.sh/marked@12'
import DOMPurify from 'https://esm.sh/dompurify@3'
import { SUPABASE_URL, SUPABASE_ANON_KEY, BACKEND_URL } from './config.js'

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
const $ = (id) => document.getElementById(id)

const fmtEur = (n) =>
  (n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €'
const md = (text) => DOMPurify.sanitize(marked.parse(text || ''))
const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

let session = null
let currentConv = null // {id, title} oder null = neue Konversation
let streaming = false
let costByMessage = {}

// ============================================================ Auth
async function init() {
  const { data } = await sb.auth.getSession()
  session = data.session
  if (session) showApp()
  else showLogin()
}

function showLogin() {
  $('login-view').hidden = false
  $('app-view').hidden = true
}

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  $('li-err').textContent = ''
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('li-email').value.trim(),
    password: $('li-pw').value,
  })
  if (error) {
    $('li-err').textContent = 'Login fehlgeschlagen: ' + error.message
    return
  }
  session = data.session
  showApp()
})

$('logout').addEventListener('click', async () => {
  await sb.auth.signOut()
  location.reload()
})

async function token() {
  const { data } = await sb.auth.getSession()
  session = data.session
  return session?.access_token
}

// ============================================================ App shell
async function showApp() {
  $('login-view').hidden = true
  $('app-view').hidden = false
  const name = session.user.user_metadata?.full_name || session.user.email
  $('f-name').textContent = name.split(' ')[0]
  $('f-avatar').textContent = name.split(' ').map((p) => p[0]).slice(0, 2).join('').toUpperCase()
  await Promise.all([loadConversations(), refreshCosts()])
  newConversation()
}

// Rail-Navigation — Sidebar-Inhalt wechselt mit dem Bereich
const views = { chat: 'v-chat', wiki: 'v-wiki', conn: 'v-conn', admin: 'v-admin' }
const sidebars = { chat: 'sb-chat', wiki: 'sb-spaces', admin: 'sb-admin' }

function activateArea(area, view = area) {
  document.querySelectorAll('.rail-btn').forEach((x) => x.classList.toggle('active', x.dataset.v === area))
  Object.entries(views).forEach(([k, id]) => $(id).classList.toggle('active', k === view))
  Object.entries(sidebars).forEach(([k, id]) => ($(id).hidden = k !== area))
  closePanel()
  window.scrollTo({ top: 0 })
}

document.querySelectorAll('.rail-btn').forEach((b) =>
  b.addEventListener('click', () => {
    activateArea(b.dataset.v)
    if (b.dataset.v === 'wiki') loadWikiNav()
    if (b.dataset.v === 'admin') { refreshCosts(); loadMembers() }
  })
)

function activateChatView() {
  activateArea('chat')
}

// Tools & Connectors leben im Space
$('space-tools').addEventListener('click', () => {
  activateArea('wiki', 'conn')
  document.querySelectorAll('#wiki-nav .ws-item').forEach((x) => x.classList.remove('on'))
  $('space-tools').classList.add('on')
})

// Admin-Sidebar: zu Panel scrollen
document.querySelectorAll('.admin-link').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.admin-link').forEach((x) => x.classList.toggle('on', x === b))
    document.getElementById(b.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
)

// ============================================================ Conversations
async function loadConversations() {
  const { data } = await sb
    .from('conversations')
    .select('id, title, updated_at')
    .order('updated_at', { ascending: false })
    .limit(50)
  const list = $('conv-list')
  list.innerHTML = ''
  for (const c of data || []) {
    const btn = document.createElement('button')
    btn.className = 'sb-item' + (currentConv?.id === c.id ? ' on' : '')
    btn.innerHTML = `<span class="ic">💬</span><span class="txt">${esc(c.title || 'Ohne Titel')}</span>`
    btn.addEventListener('click', () => openConversation(c))
    list.appendChild(btn)
  }
}

function newConversation() {
  currentConv = null
  $('chat-title').textContent = 'Neue Konversation'
  $('msgs').innerHTML = `<div class="empty"><div><span class="enni-dot">E</span></div>
    Hallo! Ich bin Enni. Frag mich zu enneo-Prozessen, Kunden, Produkt oder Code — ich schaue in Wiki und GitLab nach.</div>`
  document.querySelectorAll('#conv-list .sb-item').forEach((x) => x.classList.remove('on'))
  activateChatView()
  $('composer-input').focus()
}
$('new-chat').addEventListener('click', newConversation)

async function openConversation(c) {
  currentConv = c
  $('chat-title').textContent = c.title || 'Ohne Titel'
  activateChatView()
  document.querySelectorAll('#conv-list .sb-item').forEach((x) =>
    x.classList.toggle('on', x.querySelector('.txt')?.textContent === (c.title || 'Ohne Titel'))
  )
  const [{ data: msgs }, { data: usage }] = await Promise.all([
    sb.from('messages').select('*').eq('conversation_id', c.id).order('created_at'),
    sb.from('llm_usage').select('message_id, cost_eur').eq('conversation_id', c.id),
  ])
  costByMessage = Object.fromEntries((usage || []).map((u) => [u.message_id, Number(u.cost_eur)]))
  const box = $('msgs')
  box.innerHTML = ''
  for (const m of msgs || []) {
    if (m.role === 'user') box.appendChild(renderUser(m.content))
    else if (m.role === 'assistant')
      box.appendChild(renderAgent(m.content, m.thinking, m.tool_calls || [], costByMessage[m.id]))
  }
  window.scrollTo({ top: document.body.scrollHeight })
}

// ============================================================ Rendering
function renderUser(text) {
  const el = document.createElement('div')
  el.className = 'm-user'
  el.textContent = text
  return el
}

function toolRow(call, idx) {
  const short = summarizeInput(call.input)
  const row = document.createElement('button')
  row.className = 'tool-row' + (call.is_error ? ' err' : '')
  row.innerHTML = `<span class="t-ic">${call.name.startsWith('gitlab') ? '🦊' : '📖'}</span>
    <code>${esc(call.name)}</code><span class="t-q">${esc(short)}</span><span class="arr">›</span>`
  row.addEventListener('click', (e) => {
    e.stopPropagation()
    row.closest('.think')?.classList.add('open')
    openPanel(call)
  })
  return row
}

function summarizeInput(input) {
  if (!input || !Object.keys(input).length) return ''
  const v = input.query || input.slug || input.file_path || Object.values(input)[0]
  return typeof v === 'string' ? `„${v}“` : JSON.stringify(v)
}

function renderAgent(text, thinking, toolCalls, cost) {
  const wrap = document.createElement('div')
  wrap.className = 'm-agent'
  wrap.innerHTML = `<div class="who"><span class="enni-dot">E</span><b>Enni</b></div>`

  if (thinking || toolCalls.length) {
    const think = document.createElement('div')
    think.className = 'think'
    const label = toolCalls.length
      ? `Gedanken · ${toolCalls.length} Tool-Aufruf${toolCalls.length > 1 ? 'e' : ''}`
      : 'Gedanken'
    think.innerHTML = `<button class="think-head"><span class="chev">▶</span>${label}</button>`
    const body = document.createElement('div')
    body.className = 'think-body'
    if (thinking) {
      const p = document.createElement('div')
      p.className = 'tp'
      p.textContent = thinking
      body.appendChild(p)
    }
    toolCalls.forEach((c, i) => body.appendChild(toolRow(c, i)))
    body.insertAdjacentHTML('beforeend', '<div class="think-done">✓ Fertig</div>')
    think.appendChild(body)
    think.addEventListener('click', (e) => {
      if (e.target.closest('.tool-row')) return
      think.classList.toggle('open')
    })
    wrap.appendChild(think)
  }

  const body = document.createElement('div')
  body.className = 'body'
  body.innerHTML = md(text)
  wrap.appendChild(body)

  if (cost != null) {
    const meta = document.createElement('div')
    meta.className = 'm-meta'
    meta.innerHTML = `<span class="cost">${fmtEur(cost)}</span>`
    wrap.appendChild(meta)
  }
  return wrap
}

// ============================================================ Senden + Streaming
async function send() {
  const input = $('composer-input')
  const text = input.value.trim()
  if (!text || streaming) return
  input.value = ''
  streaming = true
  $('send-btn').disabled = true

  const box = $('msgs')
  box.querySelector('.empty')?.remove()
  box.appendChild(renderUser(text))
  if (!currentConv) $('chat-title').textContent = text.slice(0, 80)

  // Live-Agent-Container
  const wrap = document.createElement('div')
  wrap.className = 'm-agent'
  wrap.innerHTML = `<div class="who"><span class="enni-dot">E</span><b>Enni</b></div>`
  const think = document.createElement('div')
  think.className = 'think open'
  think.innerHTML = `<button class="think-head"><span class="chev">▶</span>Gedanken</button>`
  const thinkBody = document.createElement('div')
  thinkBody.className = 'think-body'
  const runIndicator = document.createElement('div')
  runIndicator.className = 'think-run'
  runIndicator.innerHTML = '<span class="pulse"></span>Enni arbeitet …'
  thinkBody.appendChild(runIndicator)
  think.appendChild(thinkBody)
  think.addEventListener('click', (e) => {
    if (e.target.closest('.tool-row')) return
    think.classList.toggle('open')
  })
  wrap.appendChild(think)
  const body = document.createElement('div')
  body.className = 'body'
  wrap.appendChild(body)
  box.appendChild(wrap)
  wrap.scrollIntoView({ block: 'end' })

  let thinkingText = ''
  let answerText = ''
  let thinkPara = null
  let toolCount = 0
  const pendingTools = {}

  const follow = () => window.scrollTo({ top: document.body.scrollHeight })

  try {
    const res = await fetch(`${BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ conversation_id: currentConv?.id, message: text }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const parts = buf.split('\n\n')
      buf = parts.pop()
      for (const part of parts) {
        if (!part.startsWith('data: ')) continue
        const ev = JSON.parse(part.slice(6))

        if (ev.type === 'conversation' && !currentConv) {
          currentConv = { id: ev.conversation_id, title: text.slice(0, 80) }
        } else if (ev.type === 'thinking_delta') {
          thinkingText += ev.text
          if (!thinkPara) {
            thinkPara = document.createElement('div')
            thinkPara.className = 'tp'
            thinkBody.insertBefore(thinkPara, runIndicator)
          }
          thinkPara.textContent = thinkingText
          follow()
        } else if (ev.type === 'tool_use') {
          toolCount++
          thinkPara = null // nächster Thinking-Block wird neuer Absatz
          const call = { name: ev.name, input: ev.input, output: '⏳ läuft …', is_error: false }
          const row = toolRow(call)
          pendingTools[ev.name + ':' + toolCount] = { call, row }
          pendingTools['last:' + ev.name] = { call, row }
          thinkBody.insertBefore(row, runIndicator)
          think.querySelector('.think-head').innerHTML =
            `<span class="chev">▶</span>Gedanken · ${toolCount} Tool-Aufruf${toolCount > 1 ? 'e' : ''}`
          follow()
        } else if (ev.type === 'tool_result') {
          const p = pendingTools['last:' + ev.name]
          if (p) {
            p.call.is_error = ev.is_error
            p.call.duration_ms = ev.duration_ms
            p.call.output = ev.is_error ? 'Fehler — Details nach Abschluss' : `OK · ${ev.duration_ms} ms`
            if (ev.is_error) p.row.classList.add('err')
          }
        } else if (ev.type === 'text_delta') {
          answerText += ev.text
          body.innerHTML = md(answerText)
          follow()
        } else if (ev.type === 'done') {
          runIndicator.remove()
          thinkBody.insertAdjacentHTML('beforeend', '<div class="think-done">✓ Fertig</div>')
          think.classList.remove('open')
          const meta = document.createElement('div')
          meta.className = 'm-meta'
          meta.innerHTML = `<span class="cost">${fmtEur(ev.cost_eur)}</span>`
          wrap.appendChild(meta)
          // volle Tool-Outputs aus der DB nachladen (Stream enthält nur Status)
          hydrateToolOutputs(ev.message_id, thinkBody)
        } else if (ev.type === 'error') {
          runIndicator.remove()
          body.insertAdjacentHTML('beforeend', `<p style="color:var(--high)">${esc(ev.message)}</p>`)
        }
      }
    }
  } catch (err) {
    runIndicator.remove()
    body.insertAdjacentHTML('beforeend', `<p style="color:var(--high)">Fehler: ${esc(err.message)}</p>`)
  }

  streaming = false
  $('send-btn').disabled = false
  loadConversations()
  refreshCosts()
  $('composer-input').focus()
}

async function hydrateToolOutputs(messageId, thinkBody) {
  if (!messageId) return
  const { data } = await sb.from('messages').select('tool_calls').eq('id', messageId).maybeSingle()
  if (!data?.tool_calls) return
  const rows = thinkBody.querySelectorAll('.tool-row')
  data.tool_calls.forEach((call, i) => {
    const row = rows[i]
    if (!row) return
    const fresh = toolRow(call)
    row.replaceWith(fresh)
  })
}

$('send-btn').addEventListener('click', send)
$('composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})

// ============================================================ Tool-Panel
const panel = $('tool-panel')
function openPanel(call) {
  $('tp-ic').textContent = call.name?.startsWith('gitlab') ? '🦊' : '📖'
  $('tp-name').textContent = call.name
  $('tp-time').textContent = call.duration_ms != null ? (call.duration_ms / 1000).toLocaleString('de-DE') + ' s' : ''
  $('tp-inputs').textContent = JSON.stringify(call.input, null, 2)
  $('tp-output').textContent = typeof call.output === 'string' ? call.output : JSON.stringify(call.output, null, 2)
  panel.classList.add('open')
}
function closePanel() {
  panel.classList.remove('open')
}
$('tp-close').addEventListener('click', closePanel)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closePanel()
})

// ============================================================ Wiki
let wikiPages = null
async function loadWikiNav() {
  if (!wikiPages) {
    const { data } = await sb.from('wiki_pages').select('slug, title, updated_at').order('slug')
    wikiPages = data || []
  }
  renderWikiNav($('wiki-filter').value.trim().toLowerCase())
}

// Gecrawlte Seiten haben teils URLs als Titel — dann lesbaren Namen aus dem Slug bauen
function pageLabel(p) {
  if (!p.title.startsWith('http')) return p.title
  const last = p.slug.split('/').pop()
  return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function renderWikiNav(filter) {
  const nav = $('wiki-nav')
  nav.innerHTML = ''
  const groups = {}
  for (const p of wikiPages) {
    if (filter && !(p.title + ' ' + p.slug).toLowerCase().includes(filter)) continue
    const g = p.slug.includes('/') ? p.slug.split('/')[0] : 'Unternehmen'
    ;(groups[g] = groups[g] || []).push(p)
  }
  const order = ['Unternehmen', 'product-docs', 'api-docs', 'marketing-site']
  const labels = { 'product-docs': 'Produkt-Doku', 'api-docs': 'API-Doku', 'marketing-site': 'Website' }
  for (const g of [...order.filter((o) => groups[o]), ...Object.keys(groups).filter((k) => !order.includes(k))]) {
    nav.insertAdjacentHTML('beforeend', `<div class="ws-sec">${esc(labels[g] || g)} · ${groups[g].length}</div>`)
    for (const p of groups[g]) {
      const btn = document.createElement('button')
      btn.className = 'ws-item'
      btn.dataset.slug = p.slug
      btn.innerHTML = `<span class="txt">${esc(pageLabel(p))}</span>`
      btn.addEventListener('click', () => openWikiPage(p.slug))
      nav.appendChild(btn)
    }
  }
}

$('wiki-filter').addEventListener('input', () => renderWikiNav($('wiki-filter').value.trim().toLowerCase()))

async function openWikiPage(slug) {
  activateArea('wiki')
  $('space-tools').classList.remove('on')
  document.querySelectorAll('#wiki-nav .ws-item').forEach((x) => x.classList.toggle('on', x.dataset.slug === slug))
  const { data } = await sb.from('wiki_pages').select('*').eq('slug', slug).maybeSingle()
  if (!data) return
  $('doc-crumb').textContent = 'Company Data / ' + data.slug
  $('doc-title').textContent = pageLabel(data)
  $('doc-meta').innerHTML = `<span>zuletzt aktualisiert ${new Date(data.updated_at).toLocaleDateString('de-DE')}</span>`
  let content = data.content
  // erste H1 entfernen (steht schon im Titel)
  content = content.replace(/^#\s+.+\n/, '')
  $('doc-body').innerHTML = md(content)
  window.scrollTo({ top: 0 })
}

// ============================================================ Mitglieder (Admin)
async function loadMembers() {
  const { data } = await sb.from('profiles').select('email, display_name, is_admin').order('created_at')
  const list = $('member-list')
  list.innerHTML = ''
  for (const m of data || []) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<div><div class="r-name">${esc(m.display_name || m.email)}</div><div class="r-sub">${esc(m.email)}</div></div>
      <div></div><span class="role${m.is_admin ? ' admin' : ''}">${m.is_admin ? 'Admin' : 'Member'}</span>`
    list.appendChild(row)
  }
}

// ============================================================ Kosten
async function refreshCosts() {
  const { data } = await sb.from('llm_usage').select('cost_eur, created_at')
  const rows = data || []
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const sum = (from) =>
    rows.filter((r) => new Date(r.created_at) >= from).reduce((a, r) => a + Number(r.cost_eur), 0)
  const today = sum(dayStart)
  $('f-cost').textContent = 'Heute ' + fmtEur(today)
  $('k-today').innerHTML = `${today.toLocaleString('de-DE', { maximumFractionDigits: 2 })} <small>€</small>`
  $('k-month').innerHTML = `${sum(monthStart).toLocaleString('de-DE', { maximumFractionDigits: 2 })} <small>€</small>`
  $('k-count').textContent = rows.length
}

init()
