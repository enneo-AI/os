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
  renderFooterProfile()
  await Promise.all([loadConversations(), loadPods(), refreshCosts(), loadConnectorRows()])
  route()
}

async function renderFooterProfile() {
  const { data: p } = await sb
    .from('profiles').select('display_name, avatar_url, email').eq('id', session.user.id).maybeSingle()
  const name = p?.display_name || session.user.email
  $('f-name').textContent = name.split(' ')[0]
  const av = $('f-avatar')
  if (p?.avatar_url) av.innerHTML = `<img src="${esc(p.avatar_url)}" alt="">`
  else av.textContent = name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
}

// ============================================================ Profil bearbeiten
let pendingAvatar = null
async function openProfile() {
  const { data: p } = await sb
    .from('profiles').select('display_name, avatar_url, email').eq('id', session.user.id).maybeSingle()
  pendingAvatar = null
  $('pf-name').value = p?.display_name || ''
  $('pf-email').value = p?.email || session.user.email
  $('pf-pw').value = ''
  $('pf-pw2').value = ''
  $('pf-err').textContent = ''
  const prev = $('pf-avatar')
  if (p?.avatar_url) prev.innerHTML = `<img src="${esc(p.avatar_url)}" alt="">`
  else prev.textContent = (p?.display_name || p?.email || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
  $('profile-overlay').classList.add('open')
}
document.querySelector('.sb-foot > div').addEventListener('click', openProfile)
$('f-avatar').addEventListener('click', openProfile)
$('pf-cancel').addEventListener('click', () => $('profile-overlay').classList.remove('open'))
$('pf-file').addEventListener('change', () => {
  const f = $('pf-file').files[0]
  if (!f) return
  if (!/^image\/(png|jpeg|webp)$/.test(f.type)) { $('pf-err').textContent = 'Bitte PNG, JPEG oder WebP.'; return }
  if (f.size > 3 * 1024 * 1024) { $('pf-err').textContent = 'Max. 3 MB.'; return }
  pendingAvatar = f
  $('pf-err').textContent = ''
  $('pf-avatar').innerHTML = `<img src="${URL.createObjectURL(f)}" alt="">`
})
$('pf-avatar-btn').addEventListener('click', () => $('pf-file').click())
$('pf-save').addEventListener('click', async () => {
  const err = $('pf-err')
  err.textContent = ''
  const pw = $('pf-pw').value
  if (pw && pw.length < 8) { err.textContent = 'Passwort: mindestens 8 Zeichen.'; return }
  if (pw && pw !== $('pf-pw2').value) { err.textContent = 'Passwörter stimmen nicht überein.'; return }
  $('pf-save').disabled = true
  try {
    const patch = { display_name: $('pf-name').value.trim() || null }
    if (pendingAvatar) {
      // Alte eigenen Avatare aufräumen, dann neuen hochladen (public URL, Cache-Buster im Namen)
      const { data: old } = await sb.storage.from('avatars').list('', { search: session.user.id })
      if (old?.length) await sb.storage.from('avatars').remove(old.map((o) => o.name))
      const ext = pendingAvatar.type.split('/')[1].replace('jpeg', 'jpg')
      const path = `${session.user.id}-${Date.now()}.${ext}`
      const { error: upErr } = await sb.storage.from('avatars').upload(path, pendingAvatar)
      if (upErr) throw upErr
      patch.avatar_url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl
    }
    const { error: profErr } = await sb.from('profiles').update(patch).eq('id', session.user.id)
    if (profErr) throw profErr
    if (pw) {
      const { error: pwErr } = await sb.auth.updateUser({ password: pw })
      if (pwErr) throw pwErr
    }
    profilesCache = null
    $('profile-overlay').classList.remove('open')
    renderFooterProfile()
  } catch (e) {
    err.textContent = 'Fehler: ' + e.message
  }
  $('pf-save').disabled = false
})

// Rail-Navigation — Sidebar-Inhalt wechselt mit dem Bereich
const views = {
  chat: 'v-chat', wiki: 'v-wiki', conn: 'v-conn', admin: 'v-admin', skills: 'v-skills',
  connected: 'v-connected', pagelist: 'v-pagelist', 'admin-conn': 'v-admin-conn', pod: 'v-pod',
}
const sidebars = { chat: 'sb-chat', wiki: 'sb-spaces', admin: 'sb-admin' }

function activateArea(area, view = area) {
  document.querySelectorAll('.rail-btn').forEach((x) => x.classList.toggle('active', x.dataset.v === area))
  Object.entries(views).forEach(([k, id]) => $(id).classList.toggle('active', k === view))
  Object.entries(sidebars).forEach(([k, id]) => ($(id).hidden = k !== area))
  closePanel()
  window.scrollTo({ top: 0 })
  syncUrl(area, view)
}

// URL synchron halten (echte Subpages: /chat, /spaces, /admin, /pod/…, /chat/…)
function syncUrl(area, view) {
  let path = '/chat'
  if (view === 'pod' && activePod) path = `/pod/${activePod.id}`
  else if (area === 'chat') path = currentConv?.id ? `/chat/${currentConv.id}` : '/chat'
  else if (area === 'wiki') path = view === 'conn' ? '/spaces/tools' : view === 'admin-conn' ? '/spaces/connections' : view === 'skills' ? '/spaces/skills' : '/spaces'
  else if (area === 'admin') path = '/admin'
  if (location.pathname !== path) history.pushState({}, '', path)
}

// Beim Laden / Zurück-Button: URL → Ansicht
async function route() {
  const p = location.pathname
  if (p.startsWith('/pod/')) {
    const pod = podsList.find((x) => x.id === p.slice(5))
    if (pod) return openPod(pod)
  }
  if (p.startsWith('/chat/')) {
    const { data: c } = await sb.from('conversations').select('*').eq('id', p.slice(6)).maybeSingle()
    if (c) return openConversation(c)
  }
  if (p.startsWith('/spaces')) {
    activateArea('wiki', p === '/spaces/tools' ? 'conn' : p === '/spaces/connections' ? 'admin-conn' : p === '/spaces/skills' ? 'skills' : 'wiki')
    if (p === '/spaces/skills') loadSkills()
    return loadSpacesTree()
  }
  if (p.startsWith('/admin')) {
    activateArea('admin')
    refreshCosts()
    loadKnowledgeUpdates()
    return loadMembers()
  }
  newConversation()
}
window.addEventListener('popstate', () => route())

document.querySelectorAll('.rail-btn').forEach((b) =>
  b.addEventListener('click', () => {
    activateArea(b.dataset.v)
    if (b.dataset.v === 'wiki') loadSpacesTree()
    if (b.dataset.v === 'admin') { refreshCosts(); loadMembers(); loadKnowledgeUpdates() }
  })
)

function activateChatView() {
  activateArea('chat')
}

// Administration-Bereich (Spaces-Sidebar oben)
document.querySelectorAll('.admin-area').forEach((b) =>
  b.addEventListener('click', () => {
    activateArea('wiki', b.dataset.view)
    if (b.dataset.view === 'skills') loadSkills()
  })
)

// Admin-Sidebar: zu Panel scrollen
document.querySelectorAll('.admin-link').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.admin-link').forEach((x) => x.classList.toggle('on', x === b))
    document.getElementById(b.dataset.target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  })
)

// ============================================================ Conversations
function convGroup(dateStr) {
  const d = new Date(dateStr)
  const now = new Date()
  const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  if (d >= dayStart) return 'Heute'
  if (d >= new Date(dayStart.getTime() - 6 * 864e5)) return 'Diese Woche'
  return 'Älter'
}

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
  let lastGroup = null
  for (const c of data || []) {
    const g = convGroup(c.updated_at)
    if (g !== lastGroup) {
      lastGroup = g
      list.insertAdjacentHTML('beforeend', `<div class="sb-time">${g}</div>`)
    }
    list.appendChild(convItem(c))
  }
}

function convItem(c) {
  const btn = document.createElement('button')
  btn.className = 'sb-item conv' + (currentConv?.id === c.id ? ' on' : '')
  btn.dataset.conv = c.id
  btn.innerHTML = `<span class="txt">${esc(c.title || 'Ohne Titel')}</span>
    <span class="sb-acts">
      <span class="sb-act rename" title="Umbenennen"><svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></span>
      <span class="sb-act delete" title="Löschen"><svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></span>
    </span>`
  btn.addEventListener('click', (e) => {
    if (e.target.closest('.sb-act')) return
    openConversation(c)
  })
  btn.querySelector('.rename').addEventListener('click', () => renameConv(btn, c))
  btn.querySelector('.delete').addEventListener('click', async () => {
    if (!window.confirm(`Konversation "${c.title || 'Ohne Titel'}" löschen?`)) return
    await sb.from('conversations').delete().eq('id', c.id)
    if (currentConv?.id === c.id) newConversation()
    loadConversations()
  })
  return btn
}

function renameConv(btn, c) {
  const txt = btn.querySelector('.txt')
  const input = document.createElement('input')
  input.className = 'sb-rename'
  input.value = c.title || ''
  txt.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const save = async (commit) => {
    if (done) return
    done = true
    const title = input.value.trim()
    if (commit && title && title !== c.title) {
      await sb.from('conversations').update({ title }).eq('id', c.id)
      c.title = title
      if (currentConv?.id === c.id) $('chat-title').textContent = title
    }
    loadConversations()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save(true)
    if (e.key === 'Escape') save(false)
  })
  input.addEventListener('blur', () => save(true))
}

function newConversation() {
  currentConv = null
  $('model-select').value = 'claude-opus-4-8'
  $('composer-input').placeholder = convPod ? 'Nachricht ans Team — @enni ruft Enni …' : 'Frag Enni …'
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
  $('composer-input').placeholder = convPod ? 'Nachricht ans Team — @enni ruft Enni …' : 'Frag Enni …'
  $('chat-title').textContent = (convPod ? `${convPod.name} · ` : '') + (c.title || 'Ohne Titel')
  activateChatView()
  $('msgs').innerHTML =
    '<div class="skel" style="align-self:flex-end;width:45%;height:44px"></div>' +
    '<div class="skel" style="width:70%;height:76px"></div>' +
    '<div class="skel" style="align-self:flex-end;width:30%;height:44px"></div>' +
    '<div class="skel" style="width:55%;height:60px"></div>'
  document.querySelectorAll('#conv-list .sb-item').forEach((x) =>
    x.classList.toggle('on', x.dataset.conv === c.id)
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
// @Erwähnungen (Personen, @enni) hervorheben — Text wird vorher escaped
const mentionize = (t) => esc(t).replace(/@([A-Za-zÀ-ÿ][\w.\-]*)/g, '<span class="mention">@$1</span>')

function renderUser(text, attachments) {
  const el = document.createElement('div')
  el.className = 'm-user'
  el.innerHTML = mentionize(text)
  if (attachments?.length) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px'
    for (const a of attachments) {
      const chip = document.createElement('span')
      chip.style.cssText = 'font-size:11px;font-weight:600;background:rgba(255,255,255,.16);border-radius:999px;padding:3px 10px'
      chip.textContent = a.name
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
  const textEl = document.createElement('span')
  textEl.innerHTML = mentionize(text)
  el.appendChild(textEl)
  if (attachments?.length) {
    const row = document.createElement('div')
    row.style.cssText = 'display:flex;flex-wrap:wrap;gap:6px;margin-top:8px'
    for (const a of attachments) {
      const chip = document.createElement('span')
      chip.style.cssText = 'font-size:11px;font-weight:600;background:rgba(29,30,44,.06);border-radius:999px;padding:3px 10px'
      chip.textContent = a.name
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
  row.innerHTML = `<code>${esc(call.name)}</code><span class="t-q">${esc(short)}</span><span class="arr">›</span>`
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

// Text in die Zwischenablage — Clipboard-API mit execCommand-Fallback
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch { return false }
  }
}

const COPY_ICON = '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>'

// Meta-Zeile unter einer Enni-Antwort: Copy (nur die Antwort, nicht die Gedanken) + Kosten
function agentMeta(getText, cost) {
  const meta = document.createElement('div')
  meta.className = 'm-meta'
  const btn = document.createElement('button')
  btn.className = 'msg-copy'
  btn.title = 'Antwort kopieren'
  btn.innerHTML = COPY_ICON
  btn.addEventListener('click', async () => {
    if (!(await copyText(getText()))) return
    btn.classList.add('done')
    btn.innerHTML = CHECK_ICON
    setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = COPY_ICON }, 1600)
  })
  meta.appendChild(btn)
  if (cost != null) meta.insertAdjacentHTML('beforeend', `<span class="cost">${fmtEur(cost)}</span>`)
  return meta
}

// Copy-Button auf jedem Code-Block (erscheint bei Hover, ✓-Feedback nach Klick)
function enhanceCode(container) {
  container.querySelectorAll('pre').forEach((pre) => {
    if (pre.querySelector('.code-copy')) return
    const btn = document.createElement('button')
    btn.className = 'code-copy'
    btn.title = 'Code kopieren'
    btn.innerHTML = COPY_ICON
    btn.addEventListener('click', async () => {
      if (!(await copyText(pre.querySelector('code')?.innerText ?? pre.innerText))) return
      btn.classList.add('done')
      btn.innerHTML = CHECK_ICON
      setTimeout(() => { btn.classList.remove('done'); btn.innerHTML = COPY_ICON }, 1600)
    })
    pre.appendChild(btn)
  })
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
  enhanceCode(body)
  wrap.appendChild(body)

  if (text) wrap.appendChild(agentMeta(() => text, cost))
  renderWriteCards(wrap, toolCalls)
  return wrap
}

// ============================================================ Enneo-Write-Freigabe
// Enni schlägt Änderungen an Enneo-Instanzen nur vor — ausgeführt wird erst nach Klick auf der Karte.
async function renderWriteCards(wrap, toolCalls) {
  const calls = (toolCalls || []).filter((c) => c.name === 'enneo_propose_write' && !c.is_error)
  for (const call of calls) {
    let pid = null
    try { pid = JSON.parse(call.output).proposal_id } catch { /* Output noch nicht hydriert */ }
    if (!pid || wrap.querySelector(`[data-proposal="${pid}"]`)) continue
    const { data: p } = await sb.from('enneo_write_proposals').select('*').eq('id', pid).maybeSingle()
    if (p) wrap.appendChild(writeCard(p))
  }
}

function writeCard(p) {
  const el = document.createElement('div')
  el.className = 'wp-card'
  el.dataset.proposal = p.id
  const bodyJson = p.body != null ? JSON.stringify(p.body, null, 2) : null
  el.innerHTML = `
    <div class="wp-top"><span class="wp-title">Änderung an ${esc(p.instance.replace('.enneo.ai', ''))}</span><span class="wp-state"></span></div>
    <div class="wp-sum">${esc(p.summary)}</div>
    <div class="wp-req">${esc(p.method)} ${esc(p.path)} · ${esc(p.instance)}</div>
    ${bodyJson ? `<pre class="wp-body">${esc(bodyJson)}</pre>` : ''}
    <div class="wp-actions">
      <button class="btn quiet wp-reject">Ablehnen</button>
      <button class="btn dark wp-approve">Ausführen</button>
    </div>
    <div class="wp-result" hidden></div>`
  const state = el.querySelector('.wp-state')
  const actions = el.querySelector('.wp-actions')
  const resultBox = el.querySelector('.wp-result')
  const setState = (status, result) => {
    actions.hidden = status !== 'proposed'
    state.className = 'wp-state ' + status
    state.textContent =
      status === 'executed' ? '✓ Ausgeführt' :
      status === 'failed' ? 'Fehlgeschlagen' :
      status === 'rejected' ? 'Abgelehnt' :
      'Wartet auf Freigabe'
    if ((status === 'executed' || status === 'failed') && result) {
      resultBox.hidden = false
      resultBox.textContent = String(result).slice(0, 600)
    }
  }
  setState(p.status, p.result)
  const act = async (action) => {
    actions.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      const res = await fetch(`${BACKEND_URL}/api/enneo-write/${p.id}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setState(data.status, data.result)
    } catch (err) {
      setState('failed', err.message)
    }
    actions.querySelectorAll('button').forEach((b) => (b.disabled = false))
  }
  el.querySelector('.wp-approve').addEventListener('click', () => act('approve'))
  el.querySelector('.wp-reject').addEventListener('click', () => act('reject'))
  return el
}

// ============================================================ Wissens-Update-Loop (Admin-Review)
// Enni sammelt Wiki-Vorschläge aus allen Konversationen — NUR der Admin sieht sie
// (RLS-gated) und geht sie gesammelt durch. Kein User-Approve im Chat.
async function loadKnowledgeUpdates() {
  const { is_admin } = await ownProfile()
  const panel = $('panel-knowledge')
  const link = document.querySelector('.admin-link[data-target="panel-knowledge"]')
  panel.hidden = !is_admin
  if (link) link.hidden = !is_admin
  if (!is_admin) return

  const { data: updates } = await sb
    .from('knowledge_updates')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(50)
  const list = $('ku-list')
  list.innerHTML = ''
  const all = updates || []
  const open = all.filter((u) => u.status === 'proposed')
  const done = all.filter((u) => u.status !== 'proposed').slice(0, 10)
  $('ku-count').textContent = open.length
    ? `${open.length} offen`
    : 'nichts offen'

  // Namen der auslösenden Nutzer auflösen (profiles sind org-weit lesbar)
  const ids = [...new Set(all.map((u) => u.triggered_by).filter(Boolean))]
  let names = {}
  if (ids.length) {
    const { data: profs } = await sb.from('profiles').select('id, display_name, email').in('id', ids)
    names = Object.fromEntries((profs || []).map((p) => [p.id, p.display_name || p.email]))
  }

  if (!open.length) {
    list.insertAdjacentHTML('beforeend', '<div class="empty-plain">Keine offenen Vorschläge — Enni sammelt weiter aus den Konversationen.</div>')
  }
  for (const u of open) list.appendChild(learnCard(u, names))
  if (done.length) {
    list.insertAdjacentHTML('beforeend', '<div class="sb-time" style="margin-top:14px">Zuletzt entschieden</div>')
    for (const u of done) {
      const label = u.status === 'approved' ? '✓ Übernommen' : 'Abgelehnt'
      list.insertAdjacentHTML(
        'beforeend',
        `<div class="row"><div><div class="r-name">${esc(u.summary)}</div>
          <div class="r-sub">${esc(u.slug || '')} · von ${esc(names[u.triggered_by] || 'unbekannt')} · ${new Date(u.created_at).toLocaleDateString('de-DE')}</div></div>
          <div></div><span class="role${u.status === 'approved' ? ' admin' : ''}">${label}</span></div>`
      )
    }
  }
}

function diffHtml(diff) {
  return (diff || '')
    .split('\n')
    .map((l) => {
      const cls = l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''
      return `<span class="dl ${cls}">${esc(l)}</span>`
    })
    .join('\n')
}

function learnCard(u, names = {}) {
  const el = document.createElement('div')
  el.className = 'wp-card ku-card'
  el.dataset.kupdate = u.id
  const isNew = !u.wiki_page_id
  const who = names[u.triggered_by] || 'unbekannt'
  const when = new Date(u.created_at).toLocaleDateString('de-DE')
  el.innerHTML = `
    <div class="wp-top"><span class="wp-title">Wissens-Update · ${esc(u.slug || '')}</span><span class="wp-state"></span></div>
    <div class="wp-sum">${esc(u.summary)}</div>
    <div class="wp-req">${isNew ? 'Neue Wiki-Seite' : 'Wiki-Seite aktualisieren'}${u.new_title ? ` · ${esc(u.new_title)}` : ''} · aus Konversation von ${esc(who)} · ${when}</div>
    <pre class="wp-body ku-diff">${diffHtml(u.diff)}</pre>
    <div class="wp-actions">
      <button class="btn quiet wp-reject">Ablehnen</button>
      <button class="btn dark wp-approve">Übernehmen</button>
    </div>
    <div class="wp-result" hidden></div>`
  const state = el.querySelector('.wp-state')
  const actions = el.querySelector('.wp-actions')
  const resultBox = el.querySelector('.wp-result')
  const setState = (status, result) => {
    actions.hidden = status !== 'proposed'
    state.className = 'wp-state ' + (status === 'approved' ? 'executed' : status)
    state.textContent =
      status === 'approved' ? '✓ Übernommen' :
      status === 'failed' ? 'Fehlgeschlagen' :
      status === 'rejected' ? 'Abgelehnt' :
      'Wartet auf Freigabe'
    if (result && status !== 'proposed') {
      resultBox.hidden = false
      resultBox.textContent = String(result).slice(0, 600)
    }
  }
  setState(u.status, u.status === 'proposed' ? null : u.result)
  const act = async (action) => {
    actions.querySelectorAll('button').forEach((b) => (b.disabled = true))
    try {
      const res = await fetch(`${BACKEND_URL}/api/knowledge-update/${u.id}/${action}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}` },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      setState(data.status, data.result)
      // Entschiedene Vorschläge wandern in "Zuletzt entschieden" — Liste kurz danach neu laden
      if (data.status === 'approved' || data.status === 'rejected') setTimeout(loadKnowledgeUpdates, 1200)
    } catch (err) {
      setState('failed', err.message)
    }
    actions.querySelectorAll('button').forEach((b) => (b.disabled = false))
  }
  el.querySelector('.wp-approve').addEventListener('click', () => act('approve'))
  el.querySelector('.wp-reject').addEventListener('click', () => act('reject'))
  return el
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
  $('composer-input').placeholder = convPod ? 'Nachricht ans Team — @enni ruft Enni …' : 'Frag Enni …'
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
// Dezentes Lock als einziges Listen-Icon: Restricted ist echte Information, alles andere spricht über Text.
const LOCK_SVG = '<svg class="lock" viewBox="0 0 24 24" aria-label="Restricted"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
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
    btn.innerHTML = `<span class="txt">${esc(p.name)}</span>${p.open ? '' : LOCK_SVG}`
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

// --- Tab: Konversationen (Dust-Muster: Direkt-Input + Suche + Liste)
let podConvsCache = []
async function loadPodConvs() {
  const [{ data }, profs] = await Promise.all([
    sb.from('conversations').select('id, title, updated_at, user_id, pod_id').eq('pod_id', activePod.id).order('updated_at', { ascending: false }),
    allProfiles(),
  ])
  podConvsCache = (data || []).map((c) => ({ ...c, starter: profName(profs, c.user_id) }))
  $('pod-conv-search').value = ''
  $('pod-quick-input').placeholder = `Schreib dem Team in „${activePod.name}“ — @enni ruft Enni dazu …`
  renderPodConvs('')
}

function renderPodConvs(filter) {
  const list = $('pod-conv-list')
  list.innerHTML = ''
  const items = podConvsCache.filter((c) => !filter || (c.title || '').toLowerCase().includes(filter))
  for (const c of items) {
    const row = document.createElement('div')
    row.className = 'row'
    row.style.cursor = 'pointer'
    row.innerHTML = `<div><div class="r-name">${esc(c.title || 'Ohne Titel')}</div>
      <div class="r-sub">gestartet von ${esc(c.starter)}</div></div><div></div>
      <span class="r-val">${new Date(c.updated_at).toLocaleDateString('de-DE')}</span>`
    row.addEventListener('click', () => { convPod = activePod; openConversation(c) })
    list.appendChild(row)
  }
  if (!items.length)
    list.innerHTML = `<div class="empty-plain">${filter ? 'Keine Treffer.' : 'Noch keine Konversationen — schreib oben die erste Nachricht, alle im Pod können mitlesen und mitschreiben.'}</div>`
}
$('pod-conv-search').addEventListener('input', () => renderPodConvs($('pod-conv-search').value.trim().toLowerCase()))

function podQuickStart() {
  const text = $('pod-quick-input').value.trim()
  if (!text) return
  $('pod-quick-input').value = ''
  convPod = activePod
  newConversation()
  $('chat-title').textContent = `Neue Konversation · ${activePod.name}`
  $('composer-input').value = text
  autosize()
  send()
}
$('pod-quick-send').addEventListener('click', podQuickStart)
$('pod-quick-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') podQuickStart() })

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
    list.innerHTML = '<div class="empty-plain">Keine Aufgaben — jeder kann welche anlegen und Enni per ▶ daran arbeiten lassen.</div>'
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
  $('tm-task-title').textContent = task.title
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
    row.innerHTML = `<div><div class="r-name">${esc(f.name)}</div>
      <div class="r-sub">${f.media_type || ''} · ${(f.size / 1024 / 1024).toFixed(1)} MB · von ${esc(profName(profs, f.uploaded_by))}</div></div>
      <a href="#" class="src-link f-dl" style="color:var(--lila-deep);font-size:12.5px">Herunterladen</a>
      <button class="task-run f-del" title="Löschen">✕</button>`
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
    list.innerHTML = '<div class="empty-plain">Noch keine Dateien — die gemeinsame Bibliothek des Pods.</div>'
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
let myProfile = null
async function ownProfile() {
  if (!myProfile) {
    const { data } = await sb.from('profiles').select('is_admin').eq('id', session.user.id).maybeSingle()
    myProfile = data || { is_admin: false }
  }
  return myProfile
}

async function fillPodSettings() {
  $('pset-name').value = activePod.name
  $('pset-desc').value = activePod.description || ''
  $('pset-instructions').value = activePod.instructions || ''
  $('pset-open').checked = activePod.open
  // Löschen: nur Ersteller (oder Admin). Verlassen: Mitglieder, die nicht Ersteller sind.
  const isCreator = activePod.created_by === session.user.id
  const { is_admin } = await ownProfile()
  $('pod-delete').hidden = !(isCreator || is_admin)
  $('pod-leave').hidden = isCreator || !activePod.members.includes(session.user.id)
}

$('pod-leave').addEventListener('click', async () => {
  if (!window.confirm(`Pod "${activePod.name}" verlassen?`)) return
  const { error } = await sb.from('pod_members').delete().eq('pod_id', activePod.id).eq('user_id', session.user.id)
  if (error) { window.alert('Fehler: ' + error.message); return }
  activePod = null
  await loadPods()
  newConversation()
})

$('pod-delete').addEventListener('click', async () => {
  if (!window.confirm(`Pod "${activePod.name}" endgültig löschen? Alle Konversationen, Aufgaben und Dateien des Pods werden mitgelöscht.`)) return
  // Storage-Objekte zuerst — die DB-Rows cascaden, die Dateien im Bucket nicht
  const { data: files } = await sb.from('pod_files').select('storage_path').eq('pod_id', activePod.id)
  if (files?.length) await sb.storage.from('pod-files').remove(files.map((f) => f.storage_path))
  const { error } = await sb.from('pods').delete().eq('id', activePod.id)
  if (error) { window.alert('Fehler: ' + error.message); return }
  activePod = null
  await loadPods()
  newConversation()
})
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
  hint.innerHTML = `Aufnahme läuft (${sttLang() === 'de-DE' ? 'Deutsch' : 'English'}) — Klick aufs Mikro stoppt · <a href="#" id="stt-switch" style="color:var(--lila-deep)">auf ${other === 'de-DE' ? 'Deutsch' : 'English'} wechseln</a>`
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

  // Pod-Konversationen sind Team-Chat: Enni antwortet nur bei @enni-Erwähnung.
  // Ohne Erwähnung wird die Nachricht nur gespeichert — kein Agent-Container nötig.
  const isTeamMsg = !!convPod && !/@enni\b/i.test(text)

  // Live-Agent-Container (nur wenn Enni antworten wird)
  let wrap = null
  let thinkBody = null
  let runIndicator = null
  let body = null
  let think = null
  if (!isTeamMsg) {
    wrap = document.createElement('div')
    wrap.className = 'm-agent'
    wrap.innerHTML = `<div class="who"><span class="enni-dot">E</span><b>Enni</b></div>`
    think = document.createElement('div')
    think.className = 'think open'
    think.innerHTML = `<button class="think-head"><span class="chev">▶</span>Gedanken</button>`
    thinkBody = document.createElement('div')
    thinkBody.className = 'think-body'
    runIndicator = document.createElement('div')
    runIndicator.className = 'think-run'
    runIndicator.innerHTML = '<span class="pulse"></span>Enni arbeitet …'
    thinkBody.appendChild(runIndicator)
    think.appendChild(thinkBody)
    think.addEventListener('click', (e) => {
      if (e.target.closest('.tool-row')) return
      think.classList.toggle('open')
    })
    wrap.appendChild(think)
    body = document.createElement('div')
    body.className = 'body'
    wrap.appendChild(body)
    box.appendChild(wrap)
    wrap.scrollIntoView({ block: 'end' })
  }

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
          const call = { name: ev.name, input: ev.input, output: 'läuft …', is_error: false }
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
          if (!isTeamMsg) {
            runIndicator.remove()
            enhanceCode(body)
            thinkBody.insertAdjacentHTML('beforeend', '<div class="think-done">✓ Fertig</div>')
            think.classList.remove('open')
            wrap.appendChild(agentMeta(() => answerText, ev.cost_eur))
            // volle Tool-Outputs aus der DB nachladen (Stream enthält nur Status)
            hydrateToolOutputs(ev.message_id, thinkBody, wrap)
          }
        } else if (ev.type === 'title') {
          if (currentConv) currentConv.title = ev.title
          if (!convPod) $('chat-title').textContent = ev.title
          loadConversations()
        } else if (ev.type === 'error') {
          runIndicator?.remove()
          ;(body || box).insertAdjacentHTML('beforeend', `<p style="color:var(--high)">${esc(ev.message)}</p>`)
        }
      }
    }
  } catch (err) {
    runIndicator?.remove()
    ;(body || box).insertAdjacentHTML('beforeend', `<p style="color:var(--high)">Fehler: ${esc(err.message)}</p>`)
  }

  streaming = false
  $('send-btn').disabled = false
  ctxTokens += Math.round((text.length + answerText.length) / 4)
  renderCtx()
  loadConversations()
  refreshCosts()
  $('composer-input').focus()
}

async function hydrateToolOutputs(messageId, thinkBody, wrap) {
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
  if (wrap) renderWriteCards(wrap, data.tool_calls)
}

$('send-btn').addEventListener('click', send)
$('composer-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    send()
  }
})

// ============================================================ Mention-Autocomplete (@ in Pods)
// Beim Tippen von "@" in Pod-Kontext: Dropdown mit @enni + Pod-Mitgliedern.
// Ein globales Menü (fixed) für beide Eingaben: Composer + Pod-Startseite.
const mentionMenu = document.createElement('div')
mentionMenu.className = 'mention-menu'
mentionMenu.hidden = true
document.body.appendChild(mentionMenu)
let mentionState = null // { input, items, sel, start }

function mentionCandidatesFor(pod, profs) {
  // Restricted Pod: nur Mitglieder + Ersteller. Open Pod: das ganze Team.
  let people = profs
  if (pod && !pod.open) {
    const ids = new Set([...(pod.members || []), pod.created_by])
    people = profs.filter((p) => ids.has(p.id))
  }
  return [
    { tag: 'enni', name: 'Enni ruft den AI-Assistenten in die Konversation' },
    ...people
      .filter((p) => p.id !== session.user.id)
      .map((p) => ({
        tag: (p.display_name || p.email.split('@')[0]).split(' ')[0],
        name: p.display_name || p.email,
      })),
  ]
}

async function mentionCheck(input, pod) {
  const pos = input.selectionStart
  const before = input.value.slice(0, pos)
  const m = before.match(/(^|\s)@([\wÀ-ÿ.\-]*)$/)
  if (!m) return mentionClose()
  const query = m[2].toLowerCase()
  const profs = await allProfiles()
  const items = mentionCandidatesFor(pod, profs).filter(
    (c) => c.tag.toLowerCase().startsWith(query) || c.name.toLowerCase().includes(query)
  )
  if (!items.length) return mentionClose()
  mentionState = { input, items, sel: 0, start: pos - query.length - 1 }
  renderMentionMenu()
}

function renderMentionMenu() {
  const { input, items, sel } = mentionState
  mentionMenu.innerHTML = items
    .map(
      (c, i) =>
        `<button class="mm-row${i === sel ? ' on' : ''}" data-i="${i}"><span class="mm-name">@${esc(c.tag)}</span><span class="mm-sub">${esc(c.name)}</span></button>`
    )
    .join('')
  mentionMenu.querySelectorAll('.mm-row').forEach((b) =>
    // mousedown statt click — feuert vor dem blur des Inputs
    b.addEventListener('mousedown', (e) => {
      e.preventDefault()
      mentionPick(Number(b.dataset.i))
    })
  )
  const r = input.getBoundingClientRect()
  mentionMenu.hidden = false
  mentionMenu.style.left = `${r.left}px`
  mentionMenu.style.width = `${Math.min(360, r.width)}px`
  mentionMenu.style.bottom = `${window.innerHeight - r.top + 6}px`
}

function mentionClose() {
  mentionState = null
  mentionMenu.hidden = true
}

function mentionPick(i) {
  const { input, items, start } = mentionState
  const c = items[i]
  const after = input.value.slice(input.selectionStart)
  input.value = `${input.value.slice(0, start)}@${c.tag} ${after}`
  const caret = start + c.tag.length + 2
  mentionClose()
  input.focus()
  input.setSelectionRange(caret, caret)
  if (input.id === 'composer-input') autosize()
}

function attachMentions(input, getPod) {
  input.addEventListener('input', () => {
    const pod = getPod()
    if (!pod) return mentionClose()
    mentionCheck(input, pod)
  })
  input.addEventListener('blur', () => setTimeout(() => { if (mentionState?.input === input) mentionClose() }, 120))
}
attachMentions($('composer-input'), () => convPod)
attachMentions($('pod-quick-input'), () => activePod)

// Capture-Phase auf document: läuft VOR den Enter-Send-Handlern der Inputs
document.addEventListener(
  'keydown',
  (e) => {
    if (!mentionState) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      e.stopPropagation()
      const n = mentionState.items.length
      mentionState.sel = (mentionState.sel + (e.key === 'ArrowDown' ? 1 : n - 1)) % n
      renderMentionMenu()
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      e.stopPropagation()
      mentionPick(mentionState.sel)
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      mentionClose()
    }
  },
  { capture: true }
)

// ============================================================ Tool-Panel
const panel = $('tool-panel')
function openPanel(call) {
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
  wiki: { name: 'Wiki', sub: 'Internes Firmenwissen · eingebaut', logo: './icons/enni.png' },
  gitlab: { name: 'GitLab', sub: 'Code, Projekte, Merge Requests · read-only', logo: './icons/gitlab.svg' },
  enneo: { name: 'Enneo-Plattform', sub: 'Tickets, Kunden, AI-Agenten, Settings', logo: './icons/enneo-icon.svg' },
  google_drive: { name: 'Google Drive', sub: 'Phase 2', logo: './icons/google-drive.svg', disabled: true },
  notion: { name: 'Notion', sub: 'Phase 2', logo: './icons/notion.svg', disabled: true },
  slack: { name: 'Slack', sub: 'Phase 2', logo: './icons/slack.svg', disabled: true },
  attio: { name: 'Attio', sub: 'Phase 2', logo: './icons/attio.ico', disabled: true },
}
const FOLDER_GROUPS = [
  { label: 'Unternehmen', match: (s) => !s.includes('/') },
  { label: 'Produkt-Doku', match: (s) => s.startsWith('product-docs/') },
  { label: 'API-Doku', match: (s) => s.startsWith('api-docs/') },
  { label: 'Enneo-API-Rezepte', match: (s) => s.startsWith('enneo-api/') },
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

function treeItem({ chev, label, cls = '', lock = false }) {
  const btn = document.createElement('button')
  btn.className = 'sb-item tree-item ' + cls
  btn.innerHTML = `${chev != null ? `<span class="tree-chev">${chev ? '▶' : ''}</span>` : ''}<span class="txt">${esc(label)}</span>${lock ? LOCK_SVG : ''}`
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
    const row = treeItem({ chev: true, label: s.name, lock: s.restricted })
    if (isOpen) row.classList.add('open')
    row.addEventListener('click', () => {
      isOpen ? expanded.delete(s.id) : expanded.add(s.id)
      renderSpaceTree()
    })
    target.appendChild(row)
    if (!isOpen) continue

    const kids = document.createElement('div')
    kids.className = 'tree-kids'

    const cd = treeItem({ label: 'Connected Data' })
    cd.addEventListener('click', () => openConnectedData(s))
    kids.appendChild(cd)

    const spacePages = (wikiPages || []).filter((p) => p.space_id === s.id)
    const foldersKey = s.id + ':folders'
    const folders = treeItem({ chev: true, label: 'Folders' })
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
        const item = treeItem({ label: `${g.label} · ${pages.length}` })
        item.addEventListener('click', () => openPagelist(s, g.label, pages))
        sub.appendChild(item)
      }
      if (!spacePages.length) sub.insertAdjacentHTML('beforeend', '<div class="sb-item" style="cursor:default;color:var(--ink-3)"><span class="txt">Noch leer — Datei-Upload folgt</span></div>')
      kids.appendChild(sub)
    }

    const web = treeItem({ label: 'Websites' })
    web.addEventListener('click', () => openPagelist(s, 'Websites', spacePages.filter((p) => WEBSITE_MATCH(p.slug))))
    kids.appendChild(web)

    const tools = treeItem({ label: 'Tools' })
    tools.addEventListener('click', () => activateArea('wiki', 'conn'))
    kids.appendChild(tools)

    target.appendChild(kids)
  }
}

// ---------- Connected Data eines Space
function openConnectedData(space) {
  currentSpace = space
  $('cd-space-name').textContent = space.name
  const list = $('cd-list')
  list.innerHTML = ''
  if (!space.connections.length) {
    list.innerHTML = '<div class="empty-plain">Noch keine Daten verbunden — füge Quellen aus den Administration-Connections hinzu.</div>'
  }
  for (const key of space.connections) {
    const c = CONNECTIONS[key] || { name: key, sub: '' }
    list.insertAdjacentHTML('beforeend',
      `<div class="crow">${c.logo ? `<span class="c-logo"><img src="${c.logo}" alt=""></span>` : ''}<div><div class="c-name">${esc(c.name)}</div><div class="c-sub">${esc(c.sub)}</div></div><span class="c-right ok"><span class="dot-s"></span>Aktiv</span></div>`)
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
        ${c.logo ? `<img src="${c.logo}" alt="" style="width:18px;height:18px;object-fit:contain;flex:none">` : ''}
        <span>${esc(c.name)}</span><span class="cr-sub">${esc(c.sub)}</span>
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
  $('pl-crumb').textContent = space.name
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
    row.innerHTML = `<div><div class="r-name">${esc(pageLabel(p))}</div><div class="r-sub">${esc(p.slug)}</div></div><div></div><span class="r-val">${new Date(p.updated_at).toLocaleDateString('de-DE')}</span>`
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
  enhanceCode($('doc-body'))
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

// Modell-Wahl: Opus 4.8 ist Default bei jedem Chat-Start (Reset in newConversation);
// innerhalb einer Konversation bleibt die Auswahl bestehen.
$('model-select').value = 'claude-opus-4-8'

// ============================================================ Connectors (MCP-Server verknüpfen)
let cnCategory = 'tool'

async function loadConnectorRows() {
  const { data } = await sb
    .from('connectors')
    .select('id, name, url, category, tool_count')
    .order('created_at')
  const { is_admin } = await ownProfile()
  for (const target of ['tool', 'connection']) {
    const box = $(target === 'tool' ? 'dyn-tools' : 'dyn-connections')
    if (!box) continue
    box.innerHTML = ''
    for (const c of (data || []).filter((x) => x.category === target)) {
      const row = document.createElement('div')
      row.className = 'crow'
      row.innerHTML = `<span class="c-logo" style="background:none;border-style:dashed"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:var(--lila-deep);fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg></span>
        <div><div class="c-name">${esc(c.name)}</div><div class="c-sub">${esc(new URL(c.url).hostname)} · ${c.tool_count ?? '?'} Tools · MCP</div></div>
        <span class="c-right ok"><span class="dot-s"></span>Verbunden</span>` +
        (is_admin ? '<button class="c-del" title="Trennen"><svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>' : '')
      row.querySelector('.c-del')?.addEventListener('click', async () => {
        if (!window.confirm(`"${c.name}" trennen? Enni verliert sofort den Zugriff auf diese Tools.`)) return
        const res = await fetch(`${BACKEND_URL}/api/connectors/${c.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${await token()}` },
        })
        if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error || 'Fehler'); return }
        loadConnectorRows()
      })
      box.appendChild(row)
    }
  }
}

document.querySelectorAll('.crow-add[data-category]').forEach((b) =>
  b.addEventListener('click', () => {
    cnCategory = b.dataset.category
    $('cm-title').textContent = cnCategory === 'tool' ? 'Eigenes Tool verknüpfen' : 'Connection verknüpfen'
    $('cn-name').value = ''
    $('cn-url').value = ''
    $('cn-token').value = ''
    $('cn-err').textContent = ''
    $('conn-overlay').classList.add('open')
    setTimeout(() => $('cn-name').focus(), 50)
  })
)
$('cn-cancel').addEventListener('click', () => $('conn-overlay').classList.remove('open'))
$('cn-save').addEventListener('click', async () => {
  const err = $('cn-err')
  err.textContent = ''
  $('cn-save').disabled = true
  $('cn-save').textContent = 'Verbinde …'
  try {
    const res = await fetch(`${BACKEND_URL}/api/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        name: $('cn-name').value,
        url: $('cn-url').value,
        token: $('cn-token').value || undefined,
        category: cnCategory,
      }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    $('conn-overlay').classList.remove('open')
    loadConnectorRows()
  } catch (e) {
    err.textContent = e.message
  }
  $('cn-save').disabled = false
  $('cn-save').textContent = 'Verknüpfen'
})

// ============================================================ Skills (Best-Practice-Playbooks)
// Tools sagen WAS Enni kann, Skills sagen WIE man es bei enneo richtig macht.
// Lesen: alle. Anlegen/Ändern/Löschen: nur Admins (RLS-enforced, UI read-only für Member).
let editingSkill = null

async function loadSkills() {
  const [{ data: skills }, { is_admin }] = await Promise.all([
    sb.from('skills').select('*').order('name'),
    ownProfile(),
  ])
  $('skill-add').hidden = !is_admin
  const list = $('skill-list')
  list.innerHTML = ''
  if (!(skills || []).length) {
    list.innerHTML = '<div class="empty-plain">Noch keine Skills definiert.</div>'
  }
  for (const s of skills || []) {
    const row = document.createElement('button')
    row.className = 'crow'
    row.innerHTML = `<span class="c-logo" style="background:none;border-style:dashed"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:var(--lila-deep);fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>
      <div><div class="c-name">${esc(s.name)}</div><div class="c-sub">/${esc(s.slug)}${s.tools?.length ? ` · ${s.tools.length} Tools` : ''} · ${esc((s.context || '').split('\n')[0].slice(0, 90))}</div></div>
      <span class="c-right ${s.enabled ? 'ok' : 'off'}"><span class="dot-s"></span>${s.enabled ? 'Aktiv' : 'Aus'}</span>`
    row.addEventListener('click', () => openSkill(s, is_admin))
    list.appendChild(row)
  }
}

function openSkill(s, isAdmin) {
  editingSkill = s
  $('sk-title').textContent = s ? s.name : 'Neuer Skill'
  $('sk-name').value = s?.name || ''
  $('sk-slug').value = s?.slug || ''
  $('sk-context').value = s?.context || ''
  $('sk-workflow').value = s?.workflow || ''
  $('sk-tools').value = (s?.tools || []).join('\n')
  $('sk-triggers').value = s?.triggers || ''
  $('sk-dod').value = s?.definition_of_done || ''
  $('sk-corner').value = s?.corner_cases || ''
  $('sk-err').textContent = ''
  // Non-Admins sehen den Skill read-only — das ist die Skill-Übersicht für alle
  document.querySelectorAll('#skill-overlay input, #skill-overlay textarea').forEach((el) => (el.disabled = !isAdmin))
  $('sk-save').hidden = !isAdmin
  $('sk-delete').hidden = !isAdmin || !s
  $('skill-overlay').classList.add('open')
  if (isAdmin) setTimeout(() => $('sk-name').focus(), 50)
}

$('skill-add').addEventListener('click', () => openSkill(null, true))
$('sk-cancel').addEventListener('click', () => $('skill-overlay').classList.remove('open'))

$('sk-save').addEventListener('click', async () => {
  const err = $('sk-err')
  err.textContent = ''
  const name = $('sk-name').value.trim()
  const slug = $('sk-slug').value.trim().toLowerCase()
  if (!name) { err.textContent = 'Name fehlt.'; return }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) { err.textContent = 'Slug bitte in kebab-case (a-z, 0-9, Bindestrich) — er ist zugleich der Slash-Command.'; return }
  const row = {
    name,
    slug,
    context: $('sk-context').value.trim(),
    workflow: $('sk-workflow').value.trim(),
    tools: $('sk-tools').value.split('\n').map((t) => t.trim()).filter(Boolean),
    triggers: $('sk-triggers').value.trim(),
    definition_of_done: $('sk-dod').value.trim(),
    corner_cases: $('sk-corner').value.trim(),
    updated_by: session.user.id,
  }
  $('sk-save').disabled = true
  const q = editingSkill
    ? sb.from('skills').update(row).eq('id', editingSkill.id)
    : sb.from('skills').insert({ ...row, created_by: session.user.id })
  const { error } = await q
  $('sk-save').disabled = false
  if (error) {
    err.textContent = error.code === '23505' ? `Slug "/${slug}" ist schon vergeben.` : 'Fehler: ' + error.message
    return
  }
  $('skill-overlay').classList.remove('open')
  loadSkills()
})

$('sk-delete').addEventListener('click', async () => {
  if (!editingSkill) return
  if (!window.confirm(`Skill "${editingSkill.name}" löschen?`)) return
  const { error } = await sb.from('skills').delete().eq('id', editingSkill.id)
  if (error) { $('sk-err').textContent = 'Fehler: ' + error.message; return }
  $('skill-overlay').classList.remove('open')
  loadSkills()
})

// Hell/Dunkel-Umschalter (Init passiert inline im <head>, gegen Theme-Flash)
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem('enni-theme', next)
})

init()
