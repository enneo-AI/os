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
  await Promise.all([loadConversations(), loadPods(), refreshCosts()])
  newConversation()
}

// Rail-Navigation — Sidebar-Inhalt wechselt mit dem Bereich
const views = {
  chat: 'v-chat', wiki: 'v-wiki', conn: 'v-conn', admin: 'v-admin',
  connected: 'v-connected', pagelist: 'v-pagelist', 'admin-conn': 'v-admin-conn', pod: 'v-pod',
}
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
    if (b.dataset.v === 'wiki') loadSpacesTree()
    if (b.dataset.v === 'admin') { refreshCosts(); loadMembers() }
  })
)

function activateChatView() {
  activateArea('chat')
}

// Administration-Bereich (Spaces-Sidebar oben)
document.querySelectorAll('.admin-area').forEach((b) =>
  b.addEventListener('click', () => activateArea('wiki', b.dataset.view))
)

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
    .is('pod_id', null)
    .eq('user_id', session.user.id)
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
  ctxTokens = 0
  renderCtx()
  activateChatView()
  $('composer-input').focus()
}
$('new-chat').addEventListener('click', () => {
  convPod = null
  newConversation()
})

async function openConversation(c) {
  currentConv = c
  convPod = c.pod_id ? podsList.find((p) => p.id === c.pod_id) || convPod : null
  $('chat-title').textContent = (convPod ? `⬡ ${convPod.name} · ` : '') + (c.title || 'Ohne Titel')
  activateChatView()
  document.querySelectorAll('#conv-list .sb-item').forEach((x) =>
    x.classList.toggle('on', x.querySelector('.txt')?.textContent === (c.title || 'Ohne Titel'))
  )
  const [{ data: msgs }, { data: usage }, profs] = await Promise.all([
    sb.from('messages').select('*').eq('conversation_id', c.id).order('created_at'),
    sb.from('llm_usage').select('message_id, cost_eur').eq('conversation_id', c.id),
    allProfiles(),
  ])
  costByMessage = Object.fromEntries((usage || []).map((u) => [u.message_id, Number(u.cost_eur)]))
  const box = $('msgs')
  box.innerHTML = ''
  for (const m of msgs || []) {
    if (m.role === 'user') {
      if (convPod && m.author_id && m.author_id !== session.user.id)
        box.appendChild(renderPeer(profName(profs, m.author_id), m.content, m.attachments))
      else box.appendChild(renderUser(m.content, m.attachments))
    } else if (m.role === 'assistant')
      box.appendChild(renderAgent(m.content, m.thinking, m.tool_calls || [], costByMessage[m.id]))
    else if (m.role === 'compaction') box.appendChild(renderCompactionMarker(m.content))
  }
  ctxTokens = computeCtxTokens(msgs || [])
  renderCtx()
  window.scrollTo({ top: document.body.scrollHeight })
}

// ============================================================ Rendering
function renderUser(text, attachments) {
  const el = document.createElement('div')
  el.className = 'm-user'
  el.textContent = text
  if (attachments?.length) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px'
    for (const a of attachments) {
      const chip = document.createElement('span')
      chip.style.cssText = 'font-size:11px;font-weight:600;background:rgba(255,255,255,.16);border-radius:999px;padding:3px 10px'
      chip.textContent = `📎 ${a.name}`
      row.appendChild(chip)
    }
    el.appendChild(row)
  }
  return el
}

function renderPeer(name, text, attachments) {
  const el = document.createElement('div')
  el.className = 'm-peer'
  const nameEl = document.createElement('div')
  nameEl.className = 'u-name'
  nameEl.textContent = name
  el.appendChild(nameEl)
  el.appendChild(document.createTextNode(text))
  if (attachments?.length) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px'
    for (const a of attachments) {
      const chip = document.createElement('span')
      chip.style.cssText = 'font-size:11px;font-weight:600;background:rgba(29,30,44,.06);border-radius:999px;padding:3px 10px'
      chip.textContent = `📎 ${a.name}`
      row.appendChild(chip)
    }
    el.appendChild(row)
  }
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

// ============================================================ Kontext-Kompaktierung (Dust-Muster)
const CTX_BUDGET = 60000 // Token-Budget pro Konversation, danach Pflicht-Kompaktierung
let ctxTokens = 0
let compacting = false

function computeCtxTokens(msgs) {
  let lastCompaction = -1
  msgs.forEach((m, i) => { if (m.role === 'compaction') lastCompaction = i })
  let chars = lastCompaction >= 0 ? msgs[lastCompaction].content.length : 0
  for (const m of msgs.slice(lastCompaction + 1)) {
    if ((m.role === 'user' || m.role === 'assistant') && m.content) chars += m.content.length
  }
  return Math.round(chars / 4)
}

function ctxPct() {
  return Math.min(100, Math.round((ctxTokens / CTX_BUDGET) * 100))
}

function renderCtx() {
  const pct = ctxPct()
  const ring = $('ctx-ring')
  const hint = $('ctx-hint')
  ring.hidden = false
  const C = 81.7
  $('ctx-arc').style.strokeDashoffset = C - (C * pct) / 100
  $('ctx-pct').textContent = pct + '%'
  ring.classList.toggle('warn', pct >= 70 && pct < 80)
  ring.classList.toggle('high', pct >= 80)
  ring.title = `Kontext: ${pct}% (${ctxTokens.toLocaleString('de-DE')} von ${CTX_BUDGET.toLocaleString('de-DE')} Tokens)` +
    (pct >= 33 ? ' — klicken zum Komprimieren' : '')
  if (compacting) {
    hint.hidden = false
    hint.innerHTML = 'Kontext wird komprimiert …'
  } else if (pct >= 80) {
    hint.hidden = false
    hint.className = 'ctx-hint blocked'
    hint.innerHTML = '<b>Kontext voll (80%+)</b> — bitte erst komprimieren: Klick auf den Ring.'
  } else if (pct >= 70) {
    hint.hidden = false
    hint.className = 'ctx-hint'
    hint.innerHTML = '<b>Kontext zu ' + pct + '% voll</b> — Komprimieren empfohlen (Klick auf den Ring).'
  } else {
    hint.hidden = true
  }
}

async function compactNow() {
  if (!currentConv || compacting) return
  compacting = true
  $('composer-input').disabled = true
  $('composer-input').placeholder = 'Kontext wird komprimiert …'
  renderCtx()
  try {
    const res = await fetch(`${BACKEND_URL}/api/compact`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ conversation_id: currentConv.id }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    await openConversation(currentConv)
    refreshCosts()
  } catch (err) {
    $('ctx-hint').hidden = false
    $('ctx-hint').innerHTML = 'Komprimieren fehlgeschlagen: ' + esc(err.message) + ' — Verlauf bleibt vollständig.'
  }
  compacting = false
  $('composer-input').disabled = false
  $('composer-input').placeholder = 'Frag Enni …'
  renderCtx()
}

$('ctx-ring').addEventListener('click', () => {
  if (ctxPct() >= 33 && !compacting) compactNow()
})

function renderCompactionMarker(summary) {
  const el = document.createElement('div')
  el.className = 'compact-marker'
  el.innerHTML = `<button class="cm-pill">✓ Kontext komprimiert <span style="opacity:.6">· Zusammenfassung anzeigen</span></button><div class="cm-sum"></div>`
  el.querySelector('.cm-sum').textContent = summary
  el.querySelector('.cm-pill').addEventListener('click', () => el.classList.toggle('open'))
  return el
}

// ============================================================ Pods (Dust-Muster)
let podsList = []
let activePod = null      // Pod, dessen Seite gerade offen ist
let convPod = null        // Pod-Kontext der aktuellen/neuen Konversation
let pendingTaskId = null  // Task, der nach dem Senden mit der Konversation verlinkt wird
let profilesCache = null

async function allProfiles() {
  if (!profilesCache) {
    const { data } = await sb.from('profiles').select('id, display_name, email')
    profilesCache = data || []
  }
  return profilesCache
}
const profName = (list, id) => {
  const p = list.find((x) => x.id === id)
  return p ? p.display_name || p.email : '—'
}

async function loadPods() {
  const [{ data: pods }, { data: members }] = await Promise.all([
    sb.from('pods').select('*').order('created_at'),
    sb.from('pod_members').select('pod_id, user_id'),
  ])
  podsList = (pods || []).map((p) => ({
    ...p,
    members: (members || []).filter((m) => m.pod_id === p.id).map((m) => m.user_id),
  }))
  const list = $('pod-list')
  list.innerHTML = ''
  for (const p of podsList) {
    const btn = document.createElement('button')
    btn.className = 'sb-item' + (activePod?.id === p.id ? ' on' : '')
    btn.innerHTML = `<span class="ic">⬡</span><span class="txt">${esc(p.name)}</span><span style="margin-left:auto;font-size:10px;color:var(--ink-3)">${p.open ? '🌐' : '🔒'}</span>`
    btn.addEventListener('click', () => openPod(p))
    list.appendChild(btn)
  }
  if (!podsList.length)
    list.innerHTML = '<div class="sb-item" style="cursor:default;color:var(--ink-3)"><span class="txt">Noch keine Pods — leg einen an (＋)</span></div>'
}

async function openPod(pod, tab = 'convs') {
  activePod = pod
  convPod = null
  $('pod-title').textContent = pod.name
  $('pod-sub').textContent = pod.description || 'Pod · gemeinsamer Kontext für alle Mitglieder'
  $('pod-badge').textContent = pod.open ? '🌐 Open' : '🔒 Restricted'
  $('pod-badge').classList.toggle('restricted', !pod.open)
  const profs = await allProfiles()
  const row = $('pod-members-row')
  row.innerHTML = ''
  const ids = pod.open ? profs.map((p) => p.id) : [...new Set([pod.created_by, ...pod.members])].filter(Boolean)
  ids.slice(0, 5).forEach((id) => {
    const name = profName(profs, id)
    row.insertAdjacentHTML('beforeend', `<span class="avatar" title="${esc(name)}">${esc(name.split(' ').map(w=>w[0]).slice(0,2).join('').toUpperCase())}</span>`)
  })
  if (ids.length > 5) row.insertAdjacentHTML('beforeend', `<span class="avatar" style="background:rgba(29,30,44,.35)">+${ids.length - 5}</span>`)
  document.querySelectorAll('#pod-list .sb-item').forEach((x) => x.classList.toggle('on', x.querySelector('.txt')?.textContent === pod.name))
  document.querySelectorAll('#conv-list .sb-item').forEach((x) => x.classList.remove('on'))
  switchPodTab(tab)
  activateArea('chat', 'pod')
}

function switchPodTab(tab) {
  document.querySelectorAll('.pt-btn').forEach((b) => b.classList.toggle('on', b.dataset.tab === tab))
  for (const t of ['convs', 'tasks', 'files', 'settings']) $('ptab-' + t).hidden = t !== tab
  if (tab === 'convs') loadPodConvs()
  if (tab === 'tasks') loadPodTasks()
  if (tab === 'files') loadPodFiles()
  if (tab === 'settings') fillPodSettings()
}
document.querySelectorAll('.pt-btn').forEach((b) => b.addEventListener('click', () => switchPodTab(b.dataset.tab)))

// --- Tab: Konversationen
async function loadPodConvs() {
  const [{ data }, profs] = await Promise.all([
    sb.from('conversations').select('id, title, updated_at, user_id, pod_id').eq('pod_id', activePod.id).order('updated_at', { ascending: false }),
    allProfiles(),
  ])
  const list = $('pod-conv-list')
  list.innerHTML = ''
  for (const c of data || []) {
    const row = document.createElement('div')
    row.className = 'row'
    row.style.cursor = 'pointer'
    row.innerHTML = `<div><div class="r-name">💬 ${esc(c.title || 'Ohne Titel')}</div>
      <div class="r-sub">gestartet von ${esc(profName(profs, c.user_id))}</div></div><div></div>
      <span class="r-val">${new Date(c.updated_at).toLocaleDateString('de-DE')}</span>`
    row.addEventListener('click', () => { convPod = activePod; openConversation(c) })
    list.appendChild(row)
  }
  if (!(data || []).length)
    list.innerHTML = '<div class="row"><div><div class="r-name">Noch keine Konversationen</div><div class="r-sub">Starte die erste — alle im Pod können mitlesen und mitschreiben.</div></div><div></div><div></div></div>'
}
$('pod-new-conv').addEventListener('click', () => {
  convPod = activePod
  newConversation()
  $('chat-title').textContent = `Neue Konversation · ⬡ ${activePod.name}`
})

// --- Tab: Aufgaben
async function loadPodTasks() {
  const [{ data }, profs] = await Promise.all([
    sb.from('pod_tasks').select('*').eq('pod_id', activePod.id).order('created_at', { ascending: false }),
    allProfiles(),
  ])
  const list = $('pod-task-list')
  list.innerHTML = ''
  for (const t of data || []) {
    const row = document.createElement('div')
    row.className = 'row'
    const statusPill = t.status === 'in_progress' ? '<span class="role admin">Enni arbeitet</span>' : t.status === 'done' ? '<span class="role" style="background:rgba(46,158,107,.12);color:var(--good)">Erledigt</span>' : '<span class="role">Offen</span>'
    row.innerHTML = `
      <div style="display:flex;align-items:center;gap:11px">
        <input type="checkbox" class="task-check" ${t.status === 'done' ? 'checked' : ''}>
        <div><div class="r-name task-title${t.status === 'done' ? ' done' : ''}">${esc(t.title)}</div>
        <div class="r-sub">von ${esc(profName(profs, t.created_by))}${t.conversation_id ? ' · <a href="#" class="task-conv" style="color:var(--lila-deep)">zur Konversation</a>' : ''}</div></div>
      </div>
      <div>${statusPill}</div>
      <button class="task-run" title="Enni an dieser Aufgabe arbeiten lassen">▶</button>`
    row.querySelector('.task-check').addEventListener('change', async (e) => {
      await sb.from('pod_tasks').update({ status: e.target.checked ? 'done' : 'open' }).eq('id', t.id)
      loadPodTasks()
    })
    row.querySelector('.task-run').addEventListener('click', () => openTaskModal(t))
    row.querySelector('.task-conv')?.addEventListener('click', async (e) => {
      e.preventDefault()
      const { data: c } = await sb.from('conversations').select('*').eq('id', t.conversation_id).maybeSingle()
      if (c) { convPod = activePod; openConversation(c) }
    })
    list.appendChild(row)
  }
  if (!(data || []).length)
    list.innerHTML = '<div class="row"><div><div class="r-name">Keine Aufgaben</div><div class="r-sub">Aufgaben kann jeder anlegen — und Enni per ▶ daran arbeiten lassen.</div></div><div></div><div></div></div>'
}
$('task-add-btn').addEventListener('click', addTask)
$('task-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') addTask() })
async function addTask() {
  const title = $('task-input').value.trim()
  if (!title) return
  await sb.from('pod_tasks').insert({ pod_id: activePod.id, title, created_by: session.user.id })
  $('task-input').value = ''
  loadPodTasks()
}

let taskForModal = null
function openTaskModal(task) {
  taskForModal = task
  $('tm-task-title').textContent = '⬡ ' + task.title
  $('tm-message').value = ''
  $('task-overlay').classList.add('open')
}
$('tm-cancel').addEventListener('click', () => $('task-overlay').classList.remove('open'))
$('tm-start').addEventListener('click', async () => {
  const custom = $('tm-message').value.trim()
  $('task-overlay').classList.remove('open')
  await sb.from('pod_tasks').update({ status: 'in_progress', assignee: session.user.id }).eq('id', taskForModal.id)
  convPod = activePod
  pendingTaskId = taskForModal.id
  newConversation()
  $('chat-title').textContent = `Aufgabe: ${taskForModal.title}`
  $('composer-input').value = `Bitte arbeite an dieser Aufgabe aus dem Pod "${activePod.name}": ${taskForModal.title}` + (custom ? `\n\nZusätzlicher Kontext: ${custom}` : '')
  autosize()
  send()
})

// --- Tab: Dateien
async function loadPodFiles() {
  const [{ data }, profs] = await Promise.all([
    sb.from('pod_files').select('*').eq('pod_id', activePod.id).order('created_at', { ascending: false }),
    allProfiles(),
  ])
  const list = $('pod-file-list')
  list.innerHTML = ''
  for (const f of data || []) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<div><div class="r-name">📄 ${esc(f.name)}</div>
      <div class="r-sub">${f.media_type || ''} · ${(f.size / 1024 / 1024).toFixed(1)} MB · von ${esc(profName(profs, f.uploaded_by))}</div></div>
      <a href="#" class="src-link f-dl" style="color:var(--lila-deep);font-size:12.5px">Herunterladen</a>
      <button class="task-run f-del" title="Löschen">🗑</button>`
    row.querySelector('.f-dl').addEventListener('click', async (e) => {
      e.preventDefault()
      const { data: signed } = await sb.storage.from('pod-files').createSignedUrl(f.storage_path, 300)
      if (signed?.signedUrl) window.open(signed.signedUrl, '_blank')
    })
    row.querySelector('.f-del').addEventListener('click', async () => {
      await sb.storage.from('pod-files').remove([f.storage_path])
      await sb.from('pod_files').delete().eq('id', f.id)
      loadPodFiles()
    })
    list.appendChild(row)
  }
  if (!(data || []).length)
    list.innerHTML = '<div class="row"><div><div class="r-name">Noch keine Dateien</div><div class="r-sub">Die gemeinsame Bibliothek des Pods.</div></div><div></div><div></div></div>'
}
$('pod-file-btn').addEventListener('click', () => $('pod-file-input').click())
$('pod-file-input').addEventListener('change', async () => {
  for (const f of $('pod-file-input').files) {
    if (f.size > 20 * 1024 * 1024) { alert(`${f.name} ist größer als 20 MB`); continue }
    const path = `${activePod.id}/${Date.now()}-${f.name.replace(/[^\w.\-]+/g, '_')}`
    const { error } = await sb.storage.from('pod-files').upload(path, f)
    if (error) { alert('Upload-Fehler: ' + error.message); continue }
    await sb.from('pod_files').insert({
      pod_id: activePod.id, name: f.name, media_type: f.type, size: f.size,
      storage_path: path, uploaded_by: session.user.id,
    })
  }
  $('pod-file-input').value = ''
  loadPodFiles()
})

// --- Tab: Einstellungen
function fillPodSettings() {
  $('pset-name').value = activePod.name
  $('pset-desc').value = activePod.description || ''
  $('pset-instructions').value = activePod.instructions || ''
  $('pset-open').checked = activePod.open
}
$('pset-save').addEventListener('click', async () => {
  const patch = {
    name: $('pset-name').value.trim() || activePod.name,
    description: $('pset-desc').value.trim(),
    instructions: $('pset-instructions').value.trim(),
    open: $('pset-open').checked,
  }
  const { error } = await sb.from('pods').update(patch).eq('id', activePod.id)
  if (error) { alert('Fehler: ' + error.message); return }
  Object.assign(activePod, patch)
  await loadPods()
  openPod(activePod, 'settings')
})

// --- Pod erstellen
let pmOpen = true
$('new-pod').addEventListener('click', async () => {
  pmOpen = true
  document.querySelectorAll('#pm-seg button').forEach((b) => b.classList.toggle('on', b.dataset.acc === 'open'))
  $('pm-hint').textContent = 'Alle in der Organisation können den Pod sehen und beitreten.'
  $('pm-members-wrap').style.display = 'none'
  const profs = await allProfiles()
  $('pm-members').innerHTML = profs
    .map((m) => `<label class="check-row"><input type="checkbox" value="${m.id}" ${m.id === session.user.id ? 'checked disabled' : ''}><span>${esc(m.display_name || m.email)}</span><span class="cr-sub">${esc(m.email)}</span></label>`)
    .join('')
  $('pm-name').value = ''
  $('pod-overlay').classList.add('open')
  setTimeout(() => $('pm-name').focus(), 50)
})
document.querySelectorAll('#pm-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    pmOpen = b.dataset.acc === 'open'
    document.querySelectorAll('#pm-seg button').forEach((x) => x.classList.toggle('on', x === b))
    $('pm-hint').textContent = pmOpen
      ? 'Alle in der Organisation können den Pod sehen und beitreten.'
      : 'Nur eingeladene Mitglieder haben Zugriff auf den Pod.'
    $('pm-members-wrap').style.display = pmOpen ? 'none' : ''
  })
)
$('pm-cancel').addEventListener('click', () => $('pod-overlay').classList.remove('open'))
$('pm-create').addEventListener('click', async () => {
  const name = $('pm-name').value.trim()
  if (!name) return
  const { data, error } = await sb
    .from('pods').insert({ name, open: pmOpen, created_by: session.user.id }).select().single()
  if (error) { alert('Fehler: ' + error.message); return }
  if (!pmOpen) {
    const ids = [...document.querySelectorAll('#pm-members input')].filter((i) => i.checked || i.disabled).map((i) => i.value)
    if (ids.length) await sb.from('pod_members').insert(ids.map((uid) => ({ pod_id: data.id, user_id: uid })))
  }
  $('pod-overlay').classList.remove('open')
  await loadPods()
  openPod({ ...data, members: [] })
})

// ============================================================ Anhänge
const ALLOWED_FILES = {
  'image/jpeg': 'JPG', 'image/png': 'PNG', 'application/pdf': 'PDF', 'text/csv': 'CSV',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
}
const extType = (name) => ({ csv: 'text/csv', xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }[name.split('.').pop().toLowerCase()])
let pendingFiles = []

$('attach-btn').addEventListener('click', () => $('file-input').click())
$('file-input').addEventListener('change', () => {
  for (const f of $('file-input').files) {
    const type = ALLOWED_FILES[f.type] ? f.type : extType(f.name)
    if (!type || !ALLOWED_FILES[type]) { showHint(`Dateityp nicht erlaubt: ${f.name}`); continue }
    if (f.size > 10 * 1024 * 1024) { showHint(`${f.name} ist größer als 10 MB`); continue }
    if (pendingFiles.length >= 4) { showHint('Maximal 4 Dateien pro Nachricht'); break }
    pendingFiles.push({ file: f, type })
  }
  $('file-input').value = ''
  renderChips()
})

function renderChips() {
  const box = $('attach-chips')
  box.hidden = !pendingFiles.length
  box.innerHTML = ''
  pendingFiles.forEach((p, i) => {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.innerHTML = `<span class="ftype">${ALLOWED_FILES[p.type]}</span>${esc(p.file.name)}<button class="x" title="Entfernen">✕</button>`
    chip.querySelector('.x').addEventListener('click', () => { pendingFiles.splice(i, 1); renderChips() })
    box.appendChild(chip)
  })
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result).split(',')[1])
    r.onerror = reject
    r.readAsDataURL(file)
  })
}

function showHint(text) {
  const hint = $('ctx-hint')
  hint.hidden = false
  hint.className = 'ctx-hint'
  hint.textContent = text
  setTimeout(() => renderCtx(), 4000)
}

// ============================================================ Diktat (Web Speech API, DE/EN)
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition
let recognition = null
let dictating = false
let dictBase = ''

function sttLang() { return localStorage.getItem('enni-stt-lang') || 'de-DE' }

$('mic-btn').addEventListener('click', () => {
  if (!SpeechRec) { showHint('Diktat wird von diesem Browser nicht unterstützt (Chrome/Edge/Safari nutzen).'); return }
  if (dictating) { recognition?.stop(); return }
  recognition = new SpeechRec()
  recognition.lang = sttLang()
  recognition.continuous = true
  recognition.interimResults = true
  dictBase = $('composer-input').value ? $('composer-input').value.trim() + ' ' : ''
  recognition.onresult = (e) => {
    let text = ''
    for (const res of e.results) text += res[0].transcript
    $('composer-input').value = dictBase + text
    autosize()
  }
  recognition.onend = () => {
    dictating = false
    $('mic-btn').classList.remove('recording')
    renderCtx()
  }
  recognition.onerror = (e) => { if (e.error !== 'aborted') showHint('Diktat-Fehler: ' + e.error) }
  recognition.start()
  dictating = true
  $('mic-btn').classList.add('recording')
  const other = sttLang() === 'de-DE' ? 'en-US' : 'de-DE'
  const hint = $('ctx-hint')
  hint.hidden = false
  hint.className = 'ctx-hint'
  hint.innerHTML = `🎙️ Aufnahme läuft (${sttLang() === 'de-DE' ? 'Deutsch' : 'English'}) — Klick aufs Mikro stoppt · <a href="#" id="stt-switch" style="color:var(--lila-deep)">auf ${other === 'de-DE' ? 'Deutsch' : 'English'} wechseln</a>`
  document.getElementById('stt-switch').addEventListener('click', (ev) => {
    ev.preventDefault()
    localStorage.setItem('enni-stt-lang', other)
    recognition.stop()
    setTimeout(() => $('mic-btn').click(), 300)
  })
})

// ============================================================ Composer-Autosize
function autosize() {
  const t = $('composer-input')
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 180) + 'px'
}
$('composer-input').addEventListener('input', autosize)

// ============================================================ Senden + Streaming
async function send() {
  const input = $('composer-input')
  const text = input.value.trim()
  if ((!text && !pendingFiles.length) || streaming || compacting) return
  if (ctxPct() >= 80) { renderCtx(); return } // Pflicht-Kompaktierung (Dust: 80%)
  if (dictating) recognition?.stop()
  input.value = ''
  autosize()
  streaming = true
  $('send-btn').disabled = true

  // Anhänge einsammeln (Base64)
  const files = pendingFiles
  pendingFiles = []
  renderChips()
  const attachments = []
  for (const p of files) {
    attachments.push({ name: p.file.name, media_type: p.type, data: await fileToBase64(p.file) })
  }
  const attachMeta = files.map((p) => ({ name: p.file.name, media_type: p.type }))

  const box = $('msgs')
  box.querySelector('.empty')?.remove()
  box.appendChild(renderUser(text || 'Bitte analysiere die angehängten Dateien.', attachMeta))
  if (!currentConv) $('chat-title').textContent = (text || attachMeta[0]?.name || '').slice(0, 80)

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
      body: JSON.stringify({
        conversation_id: currentConv?.id,
        message: text,
        model: $('model-select').value,
        attachments: attachments.length ? attachments : undefined,
        pod_id: !currentConv && convPod ? convPod.id : undefined,
      }),
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
          currentConv = { id: ev.conversation_id, title: text.slice(0, 80), pod_id: convPod?.id || null }
          if (pendingTaskId) {
            sb.from('pod_tasks').update({ conversation_id: ev.conversation_id }).eq('id', pendingTaskId).then(() => {})
            pendingTaskId = null
          }
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
  ctxTokens += Math.round((text.length + answerText.length) / 4)
  renderCtx()
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

// ============================================================ Spaces (Dust-Pattern)
// Connections = Wissensquellen (lesen/indexieren). Aktionen laufen separat als Tools.
const CONNECTIONS = {
  wiki: { ic: '📖', name: 'Wiki', sub: 'Internes Firmenwissen · eingebaut' },
  gitlab: { ic: '🦊', name: 'GitLab', sub: 'Code, Projekte, MRs · read-only' },
  google_drive: { ic: '📁', name: 'Google Drive', sub: 'folgt in Phase 2', disabled: true },
  notion: { ic: '📄', name: 'Notion', sub: 'folgt in Phase 2', disabled: true },
  slack: { ic: '💬', name: 'Slack-Channels', sub: 'read-only Sync · folgt in Phase 2', disabled: true },
  attio: { ic: '📊', name: 'Attio (Reads)', sub: 'folgt in Phase 2', disabled: true },
}
const FOLDER_GROUPS = [
  { label: 'Unternehmen', match: (s) => !s.includes('/') },
  { label: 'Produkt-Doku', match: (s) => s.startsWith('product-docs/') },
  { label: 'API-Doku', match: (s) => s.startsWith('api-docs/') },
]
const WEBSITE_MATCH = (s) => s.startsWith('marketing-site/')

let spacesList = []
let wikiPages = null
let currentSpace = null
const expanded = new Set()

// Gecrawlte Seiten haben teils URLs als Titel — dann lesbaren Namen aus dem Slug bauen
function pageLabel(p) {
  if (!p.title.startsWith('http')) return p.title
  const last = p.slug.split('/').pop()
  return last.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

async function loadSpacesTree() {
  const [{ data: spaces }, { data: conns }, { data: pages }] = await Promise.all([
    sb.from('spaces').select('*').order('created_at'),
    sb.from('space_connections').select('*'),
    wikiPages ? Promise.resolve({ data: null }) : sb.from('wiki_pages').select('slug, title, updated_at, space_id').order('slug'),
  ])
  if (pages) wikiPages = pages
  spacesList = (spaces || []).map((s) => ({
    ...s,
    connections: (conns || []).filter((c) => c.space_id === s.id).map((c) => c.connection_key),
  }))
  if (!expanded.size && spacesList.length) expanded.add(spacesList[0].id)
  renderSpaceTree()
}

function treeItem({ chev, ic, label, cls = '', indent = false }) {
  const btn = document.createElement('button')
  btn.className = 'sb-item tree-item ' + cls
  btn.innerHTML = `${chev != null ? `<span class="tree-chev">${chev ? '▶' : ''}</span>` : ''}<span class="ic">${ic}</span><span class="txt">${esc(label)}</span>`
  return btn
}

function renderSpaceTree() {
  const openTree = $('space-tree-open')
  const restrTree = $('space-tree-restricted')
  openTree.innerHTML = ''
  restrTree.innerHTML = ''

  for (const s of spacesList) {
    const target = s.restricted ? restrTree : openTree
    const isOpen = expanded.has(s.id)
    const row = treeItem({ chev: true, ic: s.restricted ? '🔒' : '📚', label: s.name })
    if (isOpen) row.classList.add('open')
    row.addEventListener('click', () => {
      isOpen ? expanded.delete(s.id) : expanded.add(s.id)
      renderSpaceTree()
    })
    target.appendChild(row)
    if (!isOpen) continue

    const kids = document.createElement('div')
    kids.className = 'tree-kids'

    const cd = treeItem({ ic: '🔌', label: 'Connected Data' })
    cd.addEventListener('click', () => openConnectedData(s))
    kids.appendChild(cd)

    const spacePages = (wikiPages || []).filter((p) => p.space_id === s.id)
    const foldersKey = s.id + ':folders'
    const folders = treeItem({ chev: true, ic: '📂', label: 'Folders' })
    if (expanded.has(foldersKey)) folders.classList.add('open')
    folders.addEventListener('click', () => {
      expanded.has(foldersKey) ? expanded.delete(foldersKey) : expanded.add(foldersKey)
      renderSpaceTree()
    })
    kids.appendChild(folders)
    if (expanded.has(foldersKey)) {
      const sub = document.createElement('div')
      sub.className = 'tree-kids'
      for (const g of FOLDER_GROUPS) {
        const pages = spacePages.filter((p) => g.match(p.slug) && !WEBSITE_MATCH(p.slug))
        const item = treeItem({ ic: '📄', label: `${g.label} · ${pages.length}` })
        item.addEventListener('click', () => openPagelist(s, g.label, pages))
        sub.appendChild(item)
      }
      if (!spacePages.length) sub.insertAdjacentHTML('beforeend', '<div class="sb-item" style="cursor:default;color:var(--ink-3)"><span class="txt">Noch leer — Datei-Upload folgt</span></div>')
      kids.appendChild(sub)
    }

    const web = treeItem({ ic: '🌐', label: 'Websites' })
    web.addEventListener('click', () => openPagelist(s, 'Websites', spacePages.filter((p) => WEBSITE_MATCH(p.slug))))
    kids.appendChild(web)

    const tools = treeItem({ ic: '🛠️', label: 'Tools' })
    tools.addEventListener('click', () => activateArea('wiki', 'conn'))
    kids.appendChild(tools)

    target.appendChild(kids)
  }
}

// ---------- Connected Data eines Space
function openConnectedData(space) {
  currentSpace = space
  $('cd-space-name').textContent = (space.restricted ? '🔒 ' : '📚 ') + space.name
  const list = $('cd-list')
  list.innerHTML = ''
  if (!space.connections.length) {
    list.innerHTML = '<div class="row"><div><div class="r-name">Noch keine Daten verbunden</div><div class="r-sub">Füge Quellen aus den Administration-Connections hinzu.</div></div><div></div><div></div></div>'
  }
  for (const key of space.connections) {
    const c = CONNECTIONS[key] || { ic: '🔗', name: key, sub: '' }
    list.insertAdjacentHTML('beforeend',
      `<div class="row"><div><div class="r-name">${c.ic} ${esc(c.name)}</div><div class="r-sub">${esc(c.sub)}</div></div><div></div><span class="role admin">Aktiv</span></div>`)
  }
  activateArea('wiki', 'connected')
}

$('cd-add').addEventListener('click', () => {
  if (!currentSpace) return
  $('cdm-space').textContent = `„${currentSpace.name}“`
  const list = $('cdm-list')
  list.innerHTML = ''
  for (const [key, c] of Object.entries(CONNECTIONS)) {
    list.insertAdjacentHTML('beforeend',
      `<label class="check-row${c.disabled ? ' disabled' : ''}">
        <input type="checkbox" value="${key}" ${currentSpace.connections.includes(key) ? 'checked' : ''} ${c.disabled ? 'disabled' : ''}>
        <span>${c.ic} ${esc(c.name)}</span><span class="cr-sub">${esc(c.sub)}</span>
      </label>`)
  }
  $('cd-overlay').classList.add('open')
})
$('cdm-cancel').addEventListener('click', () => $('cd-overlay').classList.remove('open'))
$('cdm-save').addEventListener('click', async () => {
  const chosen = [...document.querySelectorAll('#cdm-list input:not(:disabled)')].filter((i) => i.checked).map((i) => i.value)
  const before = currentSpace.connections.filter((k) => !CONNECTIONS[k]?.disabled)
  const toAdd = chosen.filter((k) => !before.includes(k))
  const toRemove = before.filter((k) => !chosen.includes(k))
  if (toAdd.length)
    await sb.from('space_connections').insert(toAdd.map((k) => ({ space_id: currentSpace.id, connection_key: k, added_by: session.user.id })))
  for (const k of toRemove)
    await sb.from('space_connections').delete().eq('space_id', currentSpace.id).eq('connection_key', k)
  $('cd-overlay').classList.remove('open')
  await loadSpacesTree()
  openConnectedData(spacesList.find((s) => s.id === currentSpace.id))
})

// ---------- Seiten-Liste (Folders / Websites)
let plPages = []
function openPagelist(space, label, pages) {
  currentSpace = space
  plPages = pages
  $('pl-crumb').textContent = (space.restricted ? '🔒 ' : '📚 ') + space.name
  $('pl-title').textContent = label
  $('pl-sub').textContent = pages.length ? `${pages.length} Seiten` : 'Noch keine Inhalte — Datei-Upload folgt in Phase 2.'
  $('pl-filter').value = ''
  renderPagelist('')
  activateArea('wiki', 'pagelist')
}

function renderPagelist(filter) {
  const list = $('pl-list')
  list.innerHTML = ''
  for (const p of plPages) {
    if (filter && !(pageLabel(p) + ' ' + p.slug).toLowerCase().includes(filter)) continue
    const row = document.createElement('div')
    row.className = 'row'
    row.style.cursor = 'pointer'
    row.innerHTML = `<div><div class="r-name">📄 ${esc(pageLabel(p))}</div><div class="r-sub">${esc(p.slug)}</div></div><div></div><span class="r-val">${new Date(p.updated_at).toLocaleDateString('de-DE')}</span>`
    row.addEventListener('click', () => openWikiPage(p.slug))
    list.appendChild(row)
  }
}
$('pl-filter').addEventListener('input', () => renderPagelist($('pl-filter').value.trim().toLowerCase()))

// ---------- Space erstellen
let smRestricted = true
function openSpaceModal(restricted) {
  smRestricted = restricted
  $('sm-title').textContent = restricted ? 'Neuen Restricted Space erstellen' : 'Neuen Open Space erstellen'
  document.querySelectorAll('#sm-seg button').forEach((b) => b.classList.toggle('on', (b.dataset.acc === 'restricted') === restricted))
  updateSmHint()
  sb.from('profiles').select('id, email, display_name').then(({ data }) => {
    $('sm-members').innerHTML = (data || [])
      .map((m) => `<label class="check-row"><input type="checkbox" value="${m.id}" ${m.id === session.user.id ? 'checked disabled' : ''}><span>${esc(m.display_name || m.email)}</span><span class="cr-sub">${esc(m.email)}</span></label>`)
      .join('')
  })
  $('sm-name').value = ''
  $('space-overlay').classList.add('open')
  setTimeout(() => $('sm-name').focus(), 50)
}
function updateSmHint() {
  $('sm-hint').textContent = smRestricted
    ? 'Nur ausgewählte Mitglieder haben Zugriff — zusätzlich zum Wissen aus den Open Spaces.'
    : 'Alle in der Organisation können auf diesen Space zugreifen.'
  $('sm-members-wrap').style.display = smRestricted ? '' : 'none'
}
document.querySelectorAll('#sm-seg button').forEach((b) =>
  b.addEventListener('click', () => {
    smRestricted = b.dataset.acc === 'restricted'
    document.querySelectorAll('#sm-seg button').forEach((x) => x.classList.toggle('on', x === b))
    updateSmHint()
  })
)
$('new-open-space').addEventListener('click', () => openSpaceModal(false))
$('new-restricted-space').addEventListener('click', () => openSpaceModal(true))
$('sm-cancel').addEventListener('click', () => $('space-overlay').classList.remove('open'))
$('sm-create').addEventListener('click', async () => {
  const name = $('sm-name').value.trim()
  if (!name) return
  const { data, error } = await sb
    .from('spaces')
    .insert({ name, restricted: smRestricted, created_by: session.user.id })
    .select()
    .single()
  if (error) { alert('Fehler: ' + error.message); return }
  const memberIds = smRestricted
    ? [...document.querySelectorAll('#sm-members input')].filter((i) => i.checked || i.disabled).map((i) => i.value)
    : []
  if (memberIds.length)
    await sb.from('space_members').insert(memberIds.map((uid) => ({ space_id: data.id, user_id: uid })))
  $('space-overlay').classList.remove('open')
  expanded.add(data.id)
  await loadSpacesTree()
})

// ---------- Einzelseite lesen
async function openWikiPage(slug) {
  const { data } = await sb.from('wiki_pages').select('*').eq('slug', slug).maybeSingle()
  if (!data) return
  $('doc-crumb').textContent = (currentSpace?.name || 'Company Data') + ' / ' + data.slug
  $('doc-title').textContent = pageLabel(data)
  $('doc-meta').innerHTML = `<span>zuletzt aktualisiert ${new Date(data.updated_at).toLocaleDateString('de-DE')}</span>`
  $('doc-body').innerHTML = md(data.content.replace(/^#\s+.+\n/, ''))
  activateArea('wiki')
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

// Modell-Wahl merken
$('model-select').value = localStorage.getItem('enni-model') || 'claude-opus-4-8'
$('model-select').addEventListener('change', () => localStorage.setItem('enni-model', $('model-select').value))

init()
