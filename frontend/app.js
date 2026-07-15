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
let closeTargetConv = null // Chat, der im Schließen-Modal bestätigt wird
let costByMessage = {}

// Multi-Sessions: Streams laufen pro Konversation weiter, auch wenn man wegnavigiert.
// viewSeq erhöht sich bei jedem Ansichts-Wechsel — Hintergrund-Streams prüfen damit,
// ob sie die Ansicht noch anfassen dürfen (DOM-Refs selbst sind detached = harmlos).
let viewSeq = 0
const activeStreams = new Set() // conversation_ids mit laufendem Enni-Turn (dieser Tab)
const sendingViews = new Set() // viewSeq-Werte mit laufendem Send (blockt Doppel-Send pro Ansicht)

const SEND_SVG = '<svg viewBox="0 0 24 24"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>'
const STOP_SVG = '<svg viewBox="0 0 24 24"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none"/></svg>'

function updateComposerState() {
  // Läuft in der offenen Konversation ein Turn (eigener Stream ODER extern/working),
  // wird der Send-Button zum Stop-Button (Codex-Muster). Ohne Konversations-ID
  // (Turn startet gerade erst) bleibt er kurz deaktiviert.
  const streamingHere = !!(currentConv && (activeStreams.has(currentConv.id) || currentConv.working))
  const btn = $('send-btn')
  btn.classList.toggle('stop', streamingHere)
  btn.innerHTML = streamingHere ? STOP_SVG : SEND_SVG
  btn.title = streamingHere ? 'Enni stoppen' : 'Senden'
  btn.setAttribute('aria-label', streamingHere ? 'Enni stoppen' : 'Senden')
  btn.disabled = !streamingHere && sendingViews.has(viewSeq)
}

function fmtDur(ms) {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

async function stopTurn() {
  const id = currentConv?.id
  if (!id) return
  const btn = $('send-btn')
  btn.disabled = true
  try {
    await fetch(`${BACKEND_URL}/api/conversations/${id}/stop`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    })
  } catch { /* Stream-Ende räumt den Zustand ohnehin auf */ }
  btn.disabled = false
}

// Auto-Scroll nur, wenn der Nutzer ohnehin unten ist — Hochscrollen während des
// Streamens unterbricht das Mitführen, statt dagegen anzukämpfen.
function followIfNearBottom() {
  const dist = document.body.scrollHeight - (window.scrollY + window.innerHeight)
  if (dist < 160) window.scrollTo({ top: document.body.scrollHeight })
}

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
  subscribeRealtime()
  await Promise.all([loadConversations(), loadPods(), refreshCosts(), loadConnectorRows()])
  await route()
  handleOAuthReturn()
  onboardingNudge()
}

// Onboarding: beim ersten Login (Rolle + Über-mich noch leer) einmalig das Profil öffnen,
// damit Enni von Anfang an personalisiert. Einmal pro Account, danach nie wieder.
async function onboardingNudge() {
  const key = 'onboarded-' + session.user.id
  if (localStorage.getItem(key)) return
  const { data: p } = await sb
    .from('profiles').select('role_title, about').eq('id', session.user.id).maybeSingle()
  if (p && !p.role_title && !p.about) {
    await openProfile()
    $('pf-welcome').hidden = false
  }
  localStorage.setItem(key, '1')
}

let currentFirstName = ''

function greetingForCurrentTime() {
  const hour = new Date().getHours()
  if (hour < 11) return 'Guten Morgen'
  if (hour < 18) return 'Guten Tag'
  return 'Guten Abend'
}

function renderNewConversationEmpty() {
  const name = currentFirstName ? ` ${esc(currentFirstName)}` : ''
  $('msgs').innerHTML = `
    <div class="empty empty-chat">
      <div><span class="enni-dot">E</span></div>
      <div class="empty-greeting">${greetingForCurrentTime()}${name}, wie kann ich dir heute weiterhelfen?</div>
    </div>`
}

async function renderFooterProfile() {
  const { data: p } = await sb
    .from('profiles').select('display_name, avatar_url, email').eq('id', session.user.id).maybeSingle()
  const name = p?.display_name || session.user.email
  currentFirstName = p?.display_name?.trim().split(/\s+/)[0] || ''
  $('f-name').textContent = currentFirstName || name.split(' ')[0]
  const av = $('f-avatar')
  if (p?.avatar_url) av.innerHTML = `<img src="${esc(p.avatar_url)}" alt="">`
  else av.textContent = name.split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
  if (!currentConv && $('msgs').querySelector('.empty-chat')) renderNewConversationEmpty()
}

// ============================================================ Profil bearbeiten
let pendingAvatar = null

function switchProfileTab(tab) {
  document.querySelectorAll('#pf-tabs .mt-btn').forEach((b) => b.classList.toggle('on', b.dataset.pftab === tab))
  for (const t of ['profil', 'learnings', 'pw']) $('pftab-' + t).hidden = t !== tab
}
document.querySelectorAll('#pf-tabs .mt-btn').forEach((b) =>
  b.addEventListener('click', () => switchProfileTab(b.dataset.pftab))
)

async function openProfile() {
  $('pf-welcome').hidden = true // nur der Onboarding-Nudge blendet den Willkommens-Hinweis ein
  switchProfileTab('profil')
  const { data: p } = await sb
    .from('profiles').select('display_name, avatar_url, email, role_title, about').eq('id', session.user.id).maybeSingle()
  pendingAvatar = null
  $('pf-name').value = p?.display_name || ''
  $('pf-email').value = p?.email || session.user.email
  $('pf-role').value = p?.role_title || ''
  $('pf-about').value = p?.about || ''
  $('pf-pw').value = ''
  $('pf-pw2').value = ''
  $('pf-err').textContent = ''
  const prev = $('pf-avatar')
  if (p?.avatar_url) prev.innerHTML = `<img src="${esc(p.avatar_url)}" alt="">`
  else prev.textContent = (p?.display_name || p?.email || '?').split(' ').map((x) => x[0]).slice(0, 2).join('').toUpperCase()
  $('profile-overlay').classList.add('open')
  loadMyLearnings()
}

// Meine Learnings: eigene Einträge mit Status (persönlich / team-weit vorgeschlagen / team-weit aktiv)
async function loadMyLearnings() {
  const box = $('pf-learnings')
  box.innerHTML = ''
  const { data } = await sb
    .from('learnings').select('id, content, share_status, enabled, created_at')
    .eq('user_id', session.user.id).order('created_at', { ascending: false })
  if (!data?.length) {
    box.innerHTML = '<div class="pl-empty">Noch keine Learnings — nutze den Feedback-Button unter Enni-Antworten oder „Lernen &amp; Schließen".</div>'
    return
  }
  const badge = (l) =>
    l.share_status === 'approved' ? '<span class="pl-badge team">Team-weit aktiv</span>'
    : l.share_status === 'proposed' ? '<span class="pl-badge prop">Team-weit vorgeschlagen</span>'
    : '<span class="pl-badge">Persönlich</span>'
  for (const l of data) {
    const row = document.createElement('div')
    row.className = 'pl-item'
    row.innerHTML = `<span class="pl-txt">${esc(l.content)}</span>${badge(l)}
      <span class="sb-act pl-del" title="Learning löschen">${X_SVG}</span>`
    row.querySelector('.pl-del').addEventListener('click', async () => {
      if (!window.confirm('Dieses Learning löschen? Es wirkt danach nicht mehr in deinen Konversationen.')) return
      await sb.from('learnings').delete().eq('id', l.id)
      loadMyLearnings()
    })
    box.appendChild(row)
  }
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
    const patch = {
      display_name: $('pf-name').value.trim() || null,
      role_title: $('pf-role').value.trim(),
      about: $('pf-about').value.trim(),
    }
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
  chat: 'v-chat', wiki: 'v-wiki',  admin: 'v-admin', skills: 'v-skills', routines: 'v-routines',
  connected: 'v-connected', pagelist: 'v-pagelist', marketplace: 'v-marketplace', pod: 'v-pod',
  'space-home': 'v-space-home', 'page-edit': 'v-page-edit',
}
const sidebars = { chat: 'sb-chat', wiki: 'sb-spaces', admin: 'sb-admin' }
const SPACE_NAV_VIEWS = new Set(['wiki', 'space-home', 'page-edit', 'connected', 'pagelist'])
let activeArea = 'chat'
let activeView = 'chat'

function paintSidebarSelection(area, view) {
  document.querySelectorAll('.admin-area').forEach((item) =>
    item.classList.toggle('on', area === 'wiki' && item.dataset.view === view)
  )
  const spaceSelected = area === 'wiki' && SPACE_NAV_VIEWS.has(view)
  document.querySelectorAll('#space-tree [data-space]').forEach((item) =>
    item.classList.toggle('on', spaceSelected && item.dataset.space === currentSpace?.id)
  )
}

function activateArea(area, view = area) {
  activeArea = area
  activeView = view
  document.querySelectorAll('.rail-btn').forEach((x) => x.classList.toggle('active', x.dataset.v === area))
  Object.entries(views).forEach(([k, id]) => $(id).classList.toggle('active', k === view))
  Object.entries(sidebars).forEach(([k, id]) => ($(id).hidden = k !== area))
  paintSidebarSelection(area, view)
  closePanel()
  window.scrollTo({ top: 0 })
  syncUrl(area, view)
}

// URL synchron halten (echte Subpages: /chat, /spaces, /admin, /pod/…, /chat/…)
function syncUrl(area, view) {
  let path = '/chat'
  if (view === 'pod' && activePod) path = `/pod/${activePod.id}`
  else if (area === 'chat') path = currentConv?.id ? `/chat/${currentConv.id}` : '/chat'
  else if (area === 'wiki') path = view === 'marketplace' ? '/spaces/marketplace' : view === 'skills' ? '/spaces/skills' : view === 'routines' ? '/spaces/routinen' : '/spaces'
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
    const spview = p === '/spaces/skills' ? 'skills' : p === '/spaces/routinen' ? 'routines' : 'marketplace'
    activateArea('wiki', spview)
    if (spview === 'marketplace') loadConnectorRows()
    if (p === '/spaces/skills') loadSkills()
    if (p === '/spaces/routinen') loadRoutines()
    await loadSpacesTree()
    return
  }
  if (p.startsWith('/admin')) {
    activateArea('admin')
    return loadAdmin()
  }
  newConversation()
}
window.addEventListener('popstate', () => route())

document.querySelectorAll('.rail-btn').forEach((b) =>
  b.addEventListener('click', () => {
    activateArea(b.dataset.v)
    if (b.dataset.v === 'wiki') {
      activateArea('wiki', 'marketplace') // Einstieg = Marketplace, keine gemischte Startseite
      loadConnectorRows()
      loadSpacesTree()
    }
    if (b.dataset.v === 'admin') loadAdmin()
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
    if (b.dataset.view === 'routines') loadRoutines()
    if (b.dataset.view === 'marketplace') loadConnectorRows()
  })
)

// Admin-Sidebar: genau einen Arbeitsbereich zeigen
const ADMIN_TABS = new Set(['reviews', 'usage', 'members'])

function setAdminTab(tab, sync = true) {
  if (!ADMIN_TABS.has(tab)) tab = 'usage'
  document.querySelectorAll('.admin-link').forEach((x) => x.classList.toggle('on', x.dataset.adminTab === tab))
  document.querySelectorAll('[data-admin-pane]').forEach((x) => (x.hidden = x.dataset.adminPane !== tab))
  window.scrollTo({ top: 0 })
  if (sync && location.pathname === '/admin') {
    const url = new URL(location.href)
    url.searchParams.set('tab', tab)
    history.pushState({}, '', url)
  }
}

document.querySelectorAll('.admin-link').forEach((b) =>
  b.addEventListener('click', () => setAdminTab(b.dataset.adminTab))
)

async function loadAdmin() {
  const { is_admin } = await ownProfile()
  const requested = new URLSearchParams(location.search).get('tab')
  const initial = ADMIN_TABS.has(requested) ? requested : is_admin ? 'reviews' : 'usage'
  setAdminTab(!is_admin && initial === 'reviews' ? 'usage' : initial, false)
  await Promise.all([
    refreshCosts(), loadMembers(), loadKnowledgeUpdates(), loadLearnings(), loadSkillProposals(), loadToolProposals(),
  ])
}

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
    .select('id, title, updated_at, working, unread')
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
  // Status-Indikator: pulsierender Punkt = Enni arbeitet, grün = fertig & ungelesen
  const ind = c.working || activeStreams.has(c.id)
    ? '<span class="c-ind work" title="Enni arbeitet …"></span>'
    : c.unread
      ? '<span class="c-ind done" title="Fertig — noch nicht angesehen"></span>'
      : ''
  btn.innerHTML = `${ind}<span class="txt">${esc(c.title || 'Ohne Titel')}</span>
    <span class="sb-acts">
      <span class="sb-act rename" title="Umbenennen"><svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></span>
      <span class="sb-act delete" title="Löschen"><svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></span>
    </span>`
  btn.addEventListener('click', (e) => {
    if (e.target.closest('.sb-act')) return
    openConversation(c)
  })
  btn.querySelector('.rename').addEventListener('click', () => renameConv(btn, c))
  btn.querySelector('.delete').addEventListener('click', () => openCloseConversation(c))
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
  viewSeq++
  updateComposerState()
  subscribeConvMessages(null) // alten Message-Kanal schließen
  closeProgressChannel()
  $('chat-close').hidden = true
  setModel('claude-sonnet-5')
  $('composer-input').placeholder = convPod ? 'Nachricht ans Team — @enni ruft Enni …' : 'Frag Enni …'
  $('chat-title').textContent = 'Neue Konversation'
  renderNewConversationEmpty()
  document.querySelectorAll('#conv-list .sb-item').forEach((x) => x.classList.remove('on'))
  sidebarPodId = convPod?.id || null
  paintPodHighlight()
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
  viewSeq++
  updateComposerState()
  // Grüner "fertig"-Punkt erlischt beim Öffnen
  if (c.unread) {
    c.unread = false
    sb.from('conversations').update({ unread: false }).eq('id', c.id).then(() => {
      loadConversations()
      if (c.pod_id) loadPods() // grüner Punkt am Pod erlischt mit
    })
  }
  $('chat-close').hidden = false
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
  // Pod-Markierung folgt der Konversation: Pod-Konv → ihr Pod, private Konv → keiner
  sidebarPodId = c.pod_id || null
  paintPodHighlight()
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
      box.appendChild(renderAgent(m.content, m.thinking, m.tool_calls || [], costByMessage[m.id], m.duration_ms))
    else if (m.role === 'compaction') box.appendChild(renderCompactionMarker(m.content))
  }
  ctxTokens = computeCtxTokens(msgs || [])
  renderCtx()
  subscribeConvMessages(c.id) // Live-Nachrichten (Pod-Team-Chat, fremde Geräte)
  renderLiveProgressIfWorking(c) // läuft hier gerade ein Turn? → Gedanken live zeigen
  // Wartende Prompts bewusst NACH dem aktiven Live-Container anzeigen.
  if (promptQueues.get(c.id)?.length) {
    mountPromptQueue(c.id)
    setTimeout(() => drainPromptQueue(c.id), 400)
  }
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
  // Subtiler Feedback-Button (erscheint bei Hover, wie der Copy-Button)
  const fb = document.createElement('button')
  fb.className = 'msg-copy msg-fb'
  fb.title = 'Feedback — Enni etwas beibringen'
  fb.innerHTML = '<svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
  fb.addEventListener('click', openFeedback)
  meta.appendChild(fb)
  if (cost != null) meta.insertAdjacentHTML('beforeend', `<span class="cost">${fmtEur(cost)}</span>`)
  return meta
}

// ============================================================ Feedback → Learnings
// Persönlich = wirkt sofort (Prompt-Injection). "Für alle vorschlagen" = zusätzlich
// Learning-Card beim Admin, der über die Team-weite Übernahme entscheidet.
function openFeedback() {
  $('fb-text').value = ''
  $('fb-err').textContent = ''
  document.querySelector('input[name="fb-scope"][value="none"]').checked = true
  $('fb-overlay').classList.add('open')
  setTimeout(() => $('fb-text').focus(), 50)
}
$('fb-cancel').addEventListener('click', () => $('fb-overlay').classList.remove('open'))
$('fb-save').addEventListener('click', async () => {
  const content = $('fb-text').value.trim()
  if (!content) { $('fb-err').textContent = 'Feedback-Text fehlt.'; return }
  $('fb-save').disabled = true
  const { error } = await sb.from('learnings').insert({
    user_id: session.user.id,
    content,
    source: 'feedback',
    source_conversation_id: currentConv?.id || null,
    share_status: document.querySelector('input[name="fb-scope"]:checked').value,
  })
  $('fb-save').disabled = false
  if (error) { $('fb-err').textContent = 'Fehler: ' + error.message; return }
  $('fb-overlay').classList.remove('open')
})

// ============================================================ Chat schließen (mit persönlicher Lern-Option)
function openCloseConversation(conv) {
  if (!conv) return
  closeTargetConv = { ...conv }
  $('cl-err').textContent = ''
  $('cl-chat-name').textContent = conv.title || 'Ohne Titel'
  $('cl-learn').disabled = false
  $('cl-close').disabled = false
  $('cl-cancel').disabled = false
  $('cl-learn').textContent = 'Lernen & Schließen'
  $('cl-close').textContent = 'Chat schließen'
  $('cl-title').textContent = 'Chat schließen'
  $('cl-choose').hidden = false
  $('cl-result').hidden = true
  $('close-overlay').classList.add('open')
}

async function deleteConversation(conv) {
  if (!conv?.id) throw new Error('Konversation nicht gefunden')
  const { data, error } = await sb
    .from('conversations')
    .delete()
    .eq('id', conv.id)
    .eq('user_id', session.user.id)
    .select('id')
    .maybeSingle()
  if (error) throw error
  if (!data) throw new Error('Der Chat konnte nicht geschlossen werden.')

  activeStreams.delete(conv.id)
  promptQueues.delete(conv.id)
  if (currentConv?.id === conv.id) newConversation()
  await loadConversations()
}

function setCloseBusy(busy, action = '') {
  $('cl-learn').disabled = busy
  $('cl-close').disabled = busy
  $('cl-cancel').disabled = busy
  if (action === 'learn') $('cl-learn').textContent = busy ? 'Enni lernt …' : 'Lernen & Schließen'
  if (action === 'close') $('cl-close').textContent = busy ? 'Chat wird geschlossen …' : 'Chat schließen'
}

$('chat-close').addEventListener('click', () => openCloseConversation(currentConv))
$('cl-done').addEventListener('click', () => {
  $('close-overlay').classList.remove('open')
  closeTargetConv = null
})
$('cl-cancel').addEventListener('click', () => {
  $('close-overlay').classList.remove('open')
  closeTargetConv = null
})
$('cl-close').addEventListener('click', async () => {
  const target = closeTargetConv
  if (!target) return
  $('cl-err').textContent = ''
  setCloseBusy(true, 'close')
  try {
    await deleteConversation(target)
    $('close-overlay').classList.remove('open')
    closeTargetConv = null
  } catch (err) {
    $('cl-err').textContent = 'Fehler: ' + err.message
    setCloseBusy(false, 'close')
  }
})
$('cl-learn').addEventListener('click', async () => {
  const target = closeTargetConv
  if (!target) return
  $('cl-err').textContent = ''
  setCloseBusy(true, 'learn')
  try {
    const res = await fetch(`${BACKEND_URL}/api/conversations/${target.id}/learn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    // Erst nach erfolgreicher Extraktion löschen. Der FK setzt die Learning-Quelle
    // dabei auf null; das persönliche Learning selbst bleibt dauerhaft erhalten.
    await deleteConversation(target)
    // Ergebnis im Modal zeigen (keine Browser-Alerts)
    $('cl-choose').hidden = true
    $('cl-result').hidden = false
    if (data.learnings?.length) {
      $('cl-title').textContent = 'Enni hat gelernt'
      $('cl-learned').innerHTML = data.learnings
        .map((l) => `<div class="cl-li">${CHECK_SVG}<span>${esc(l)}</span></div>`)
        .join('')
      $('cl-result-hint').textContent =
        'Gespeichert unter Profil → Meine Learnings. Wirkt ab sofort ausschließlich in deinen Konversationen.'
    } else {
      $('cl-title').textContent = 'Nichts zu lernen'
      $('cl-learned').innerHTML = ''
      $('cl-result-hint').textContent = data.hinweis || 'Nichts dauerhaft Lernbares in dieser Konversation — der Chat wird geschlossen.'
    }
    closeTargetConv = null
  } catch (err) {
    $('cl-err').textContent = 'Fehler: ' + err.message
    setCloseBusy(false, 'learn')
  }
})

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

function renderAgent(text, thinking, toolCalls, cost, durationMs) {
  const wrap = document.createElement('div')
  wrap.className = 'm-agent'
  wrap.innerHTML = `<div class="who"><span class="enni-dot">E</span><b>Enni</b></div>`

  if (thinking || toolCalls.length) {
    const think = document.createElement('div')
    think.className = 'think'
    const label =
      (toolCalls.length
        ? `Gedanken · ${toolCalls.length} Tool-Aufruf${toolCalls.length > 1 ? 'e' : ''}`
        : 'Gedanken') + (durationMs ? ` · ${fmtDur(durationMs)}` : '')
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
  renderFileCards(body)
  wrap.appendChild(body)

  if (text) wrap.appendChild(agentMeta(() => text, cost))
  renderWriteCards(wrap, toolCalls)
  renderConnectCards(wrap, toolCalls)
  return wrap
}

// Von Enni erstellte Dateien (create_file → GET /files?u=…) als Karte statt nacktem Link
// rendern (Codex-Muster: Icon, Name, Typ, Öffnen).
const FILE_SVG = '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>'
function renderFileCards(scope) {
  scope.querySelectorAll('a[href*="/files?u="]').forEach((a) => {
    if (a.closest('.file-card')) return
    const name = a.textContent.trim() || 'Datei'
    const ext = (name.match(/\.(\w+)$/)?.[1] || '').toUpperCase()
    const card = document.createElement('a')
    card.className = 'file-card'
    card.href = a.href
    card.target = '_blank'
    card.rel = 'noopener'
    card.innerHTML = `<span class="fc-icon">${FILE_SVG}</span>
      <span class="fc-main"><span class="fc-name">${esc(name)}</span><span class="fc-sub">${ext ? esc(ext) + ' · ' : ''}von Enni erstellt</span></span>
      <span class="fc-open">Öffnen</span>`
    // Steht der Link allein in einem Absatz, ersetzt die Karte den ganzen Absatz
    const p = a.parentElement
    if (p?.tagName === 'P' && p.textContent.trim() === a.textContent.trim()) p.replaceWith(card)
    else a.replaceWith(card)
  })
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

// Tool-Verbindungs-Karte (request_tool_connection): OAuth bei Slack, sichere
// Credentials-Eingabe nur noch für Anbieter, die keinen Login-Flow anbieten.
function renderConnectCards(wrap, toolCalls) {
  const calls = (toolCalls || []).filter((c) => c.name === 'request_tool_connection' && !c.is_error)
  calls.forEach((call, i) => {
    const inp = call.input || {}
    const key = ('tc-' + (inp.kind || '') + '-' + (inp.name || '') + '-' + i).replace(/[^a-zA-Z0-9-]/g, '_')
    if (wrap.querySelector(`[data-connect-card="${key}"]`)) return
    const isMcp = inp.kind === 'mcp'
    const isSlack = inp.kind === 'slack'
    const el = document.createElement('div')
    el.className = 'wp-card'
    el.dataset.connectCard = key
    el.innerHTML = `
      <div class="wp-top"><span class="wp-title">Tool verbinden · ${esc(inp.name || inp.kind)}</span><span class="wp-state"></span></div>
      <div class="wp-sum">${esc(inp.reason || '')}</div>
      <div class="tc-form">
        ${isMcp ? `<input type="text" class="tc-name" placeholder="Name" value="${esc(inp.name || '')}">
        <input type="text" class="tc-url" placeholder="https://… (MCP-Server-URL)" value="${esc(inp.url || '')}">` : ''}
        ${isSlack ? '<div class="wp-req">Du wirst zu Slack weitergeleitet und wählst dort deinen Workspace aus.</div>' : `<input type="password" class="tc-token" placeholder="${isMcp ? 'Bearer-Token (optional)' : 'API-Key'}" autocomplete="off">`}
      </div>
      <div class="wp-req">${isSlack ? 'Slack zeigt dir vorab alle angefragten Leserechte.' : 'Wird sicher gespeichert — Enni sieht deine Zugangsdaten nie. Erscheint danach als dein persönliches Tool unter Spaces → Tools.'}</div>
      <div class="wp-actions"><button class="btn dark tc-save">${isSlack ? 'Mit Slack verbinden' : 'Verbinden'}</button></div>
      <div class="wp-result" hidden></div>`
    const saveBtn = el.querySelector('.tc-save')
    const result = el.querySelector('.wp-result')
    saveBtn.addEventListener('click', async () => {
      if (isSlack) {
        saveBtn.disabled = true
        saveBtn.textContent = 'Öffne Slack …'
        try {
          const res = await fetch(`${BACKEND_URL}/api/oauth/slack/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
            body: JSON.stringify({ scope: 'personal' }),
          })
          const data = await res.json()
          if (!res.ok || !data.url) throw new Error(data.error || 'OAuth-Start fehlgeschlagen')
          location.assign(data.url)
        } catch (err) {
          result.hidden = false
          result.textContent = 'Fehler: ' + err.message
          saveBtn.disabled = false
          saveBtn.textContent = 'Mit Slack verbinden'
        }
        return
      }
      const tokenVal = el.querySelector('.tc-token').value.trim()
      const nameVal = isMcp ? el.querySelector('.tc-name').value.trim() : inp.name
      const urlVal = isMcp ? el.querySelector('.tc-url').value.trim() : undefined
      if (!isMcp && !tokenVal) { result.hidden = false; result.textContent = 'Bitte den Key eintragen.'; return }
      if (isMcp && (!nameVal || !/^https:\/\//.test(urlVal || ''))) { result.hidden = false; result.textContent = 'Name und https-URL sind Pflicht.'; return }
      saveBtn.disabled = true
      saveBtn.textContent = 'Verbinde …'
      try {
        const res = await fetch(`${BACKEND_URL}/api/connectors`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
          body: JSON.stringify({ kind: inp.kind, name: nameVal, url: urlVal, token: tokenVal || undefined, scope: 'personal', category: 'tool' }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
        el.querySelector('.tc-form').remove()
        el.querySelector('.wp-actions').remove()
        el.querySelector('.wp-state').textContent = '✓ Verbunden'
        el.querySelector('.wp-state').className = 'wp-state ok'
        result.hidden = false
        result.textContent = 'Als dein persönliches Tool angelegt — teilen kannst du es unter Spaces → Tools. Enni kann es ab der nächsten Nachricht nutzen.'
        loadConnectorRows()
      } catch (err) {
        result.hidden = false
        result.textContent = 'Fehler: ' + err.message
        saveBtn.disabled = false
        saveBtn.textContent = 'Verbinden'
      }
    })
    wrap.appendChild(el)
  })
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
  const link = document.querySelector('.admin-link[data-admin-tab="reviews"]')
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

// Admin-Panel: Learning-Vorschläge (persönlich schon aktiv — Review entscheidet über Team-weit)
async function loadLearnings() {
  const { is_admin } = await ownProfile()
  const panel = $('panel-learnings')
  const link = document.querySelector('.admin-link[data-admin-tab="reviews"]')
  panel.hidden = !is_admin
  if (link) link.hidden = !is_admin
  if (!is_admin) return

  const [{ data: rows }, profs] = await Promise.all([
    sb.from('learnings').select('*').in('share_status', ['proposed', 'approved']).order('created_at', { ascending: false }).limit(100),
    allProfiles(),
  ])
  const proposed = (rows || []).filter((l) => l.share_status === 'proposed')
  const approved = (rows || []).filter((l) => l.share_status === 'approved')
  $('lr-count').textContent = proposed.length ? `${proposed.length} offen` : 'nichts offen'
  const list = $('lr-list')
  list.innerHTML = ''
  const act = async (id, action) => {
    const res = await fetch(`${BACKEND_URL}/api/learnings/${id}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    })
    if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error || 'Fehler'); return }
    loadLearnings()
  }
  if (!proposed.length) {
    list.insertAdjacentHTML('beforeend', '<div class="empty-plain">Keine offenen Vorschläge.</div>')
  }
  for (const l of proposed) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<div><div class="r-name">${esc(l.content)}</div>
      <div class="r-sub">von ${esc(profName(profs, l.user_id))} · ${l.source === 'feedback' ? 'Feedback' : 'Konversations-Learning'} · ${new Date(l.created_at).toLocaleDateString('de-DE')} · bei ihm/ihr schon aktiv</div></div>
      <button class="btn quiet" style="padding:5px 13px;font-size:12px">Ablehnen</button>
      <button class="btn dark" style="padding:5px 13px;font-size:12px">Für alle übernehmen</button>`
    const [rejectBtn, approveBtn] = row.querySelectorAll('button')
    approveBtn.addEventListener('click', () => act(l.id, 'approve'))
    rejectBtn.addEventListener('click', () => act(l.id, 'reject'))
    list.appendChild(row)
  }
  if (approved.length) {
    list.insertAdjacentHTML('beforeend', '<div class="sb-time" style="margin-top:14px">Team-weit aktiv</div>')
    for (const l of approved) {
      const row = document.createElement('div')
      row.className = 'row'
      row.innerHTML = `<div><div class="r-name">${esc(l.content)}</div>
        <div class="r-sub">von ${esc(profName(profs, l.user_id))} · seit ${new Date(l.reviewed_at || l.created_at).toLocaleDateString('de-DE')}</div></div>
        <div></div>
        <button class="btn quiet" style="padding:5px 13px;font-size:12px" title="Gilt danach nur noch persönlich beim Urheber">Deaktivieren</button>`
      row.querySelector('button').addEventListener('click', () => {
        if (window.confirm('Team-weit deaktivieren? Bleibt persönlich beim Urheber aktiv.')) act(l.id, 'demote')
      })
      list.appendChild(row)
    }
  }
}

async function loadSkillProposals() {
  const { is_admin } = await ownProfile()
  const panel = $('panel-skills')
  const link = document.querySelector('.admin-link[data-admin-tab="reviews"]')
  panel.hidden = !is_admin
  if (link) link.hidden = !is_admin
  if (!is_admin) return

  const [{ data: rows }, profs] = await Promise.all([
    sb.from('skills').select('*').eq('visibility', 'proposed').order('updated_at', { ascending: false }),
    allProfiles(),
  ])
  const proposed = rows || []
  $('sp-count').textContent = proposed.length ? `${proposed.length} offen` : 'nichts offen'
  const list = $('sp-list')
  list.innerHTML = ''
  const act = async (id, action) => {
    const res = await fetch(`${BACKEND_URL}/api/skills/${id}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    })
    if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error || 'Fehler'); return }
    skillsCache = null
    loadSkillProposals()
  }
  if (!proposed.length) {
    list.innerHTML = '<div class="empty-plain">Keine offenen Skill-Vorschläge.</div>'
    return
  }
  for (const s of proposed) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<div><div class="r-name">${esc(s.name)} <span class="c-sub" style="font-weight:400">/${esc(s.slug)}</span></div>
      <div class="r-sub">${esc(s.category || 'Allgemein')} · von ${esc(profName(profs, s.created_by))} · ${esc((s.context || '').split('\n')[0].slice(0, 80))}</div></div>
      <button class="btn quiet" style="padding:5px 13px;font-size:12px">Ansehen</button>
      <button class="btn quiet" style="padding:5px 13px;font-size:12px">Ablehnen</button>
      <button class="btn dark" style="padding:5px 13px;font-size:12px">Für alle freischalten</button>`
    const [viewBtn, rejectBtn, approveBtn] = row.querySelectorAll('button')
    viewBtn.addEventListener('click', () => openSkill(s, is_admin))
    approveBtn.addEventListener('click', () => act(s.id, 'approve'))
    rejectBtn.addEventListener('click', () => {
      if (window.confirm(`"${s.name}" ablehnen? Bleibt persönlich beim Ersteller aktiv, wird aber nicht Team-weit.`)) act(s.id, 'reject')
    })
    list.appendChild(row)
  }
}

async function loadToolProposals() {
  const { is_admin } = await ownProfile()
  const panel = $('panel-tools')
  const link = document.querySelector('.admin-link[data-admin-tab="reviews"]')
  panel.hidden = !is_admin
  if (link) link.hidden = !is_admin
  if (!is_admin) return
  const [{ data: rows }, profs] = await Promise.all([
    sb.from('connectors').select('id, name, kind, url, tool_count, owner, visibility').eq('visibility', 'proposed').order('created_at'),
    allProfiles(),
  ])
  const proposed = rows || []
  $('tp-count').textContent = proposed.length ? `${proposed.length} offen` : 'nichts offen'
  const list = $('tp-list')
  list.innerHTML = ''
  if (!proposed.length) {
    list.innerHTML = '<div class="empty-plain">Keine offenen Tool-Vorschläge.</div>'
    return
  }
  const act = async (id, action) => {
    const res = await fetch(`${BACKEND_URL}/api/connectors/${id}/${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}` },
    })
    if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error || 'Fehler'); return }
    loadToolProposals()
    loadConnectorRows()
  }
  for (const c of proposed) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<div><div class="r-name">${esc(c.name)}</div>
      <div class="r-sub">${esc(c.kind.toUpperCase())}${c.tool_count ? ` · ${c.tool_count} Tools` : ''} · von ${esc(profName(profs, c.owner))} · mit dessen Zugangsdaten</div></div>
      <button class="btn quiet" style="padding:5px 13px;font-size:12px">Ablehnen</button>
      <button class="btn dark" style="padding:5px 13px;font-size:12px">Für alle freischalten</button>`
    const [rejectBtn, approveBtn] = row.querySelectorAll('button')
    approveBtn.addEventListener('click', () => act(c.id, 'approve'))
    rejectBtn.addEventListener('click', () => act(c.id, 'reject'))
    list.appendChild(row)
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
    const { data } = await sb.from('profiles').select('id, display_name, email, avatar_url')
    profilesCache = data || []
  }
  return profilesCache
}
const profName = (list, id) => {
  const p = list.find((x) => x.id === id)
  return p ? p.display_name || p.email : '—'
}
const profileAvatarInner = (profile, name) => profile?.avatar_url
  ? `<img src="${esc(profile.avatar_url)}" alt="">`
  : esc(podInitials(name))

// Welcher Pod ist in der Sidebar markiert? Folgt der offenen Ansicht (Pod-Seite ODER
// Pod-Konversation) — nicht activePod, das als Seiten-Zustand auch in 1:1-Chats überlebt.
let sidebarPodId = null
function paintPodHighlight() {
  document.querySelectorAll('#pod-list .sb-item').forEach((x) => x.classList.toggle('on', x.dataset.pod === sidebarPodId))
}

function podInitials(name) {
  const w = (name || '').trim().split(/\s+/)
  return ((w[0]?.[0] || '') + (w[1]?.[0] || '')).toUpperCase() || '·'
}

async function loadPods() {
  const [{ data: pods }, { data: members }, { data: podConvs }] = await Promise.all([
    sb.from('pods').select('*').order('created_at'),
    sb.from('pod_members').select('pod_id, user_id'),
    // Aggregierter Status pro Pod: arbeitet dort etwas / liegt Ungelesenes?
    sb.from('conversations').select('id, pod_id, working, unread').not('pod_id', 'is', null),
  ])
  podsList = (pods || []).map((p) => ({
    ...p,
    members: (members || []).filter((m) => m.pod_id === p.id).map((m) => m.user_id),
  }))
  const status = {}
  for (const c of podConvs || []) {
    const s = (status[c.pod_id] ||= { work: false, done: false })
    if (c.working || activeStreams.has(c.id)) s.work = true
    if (c.unread) s.done = true
  }
  const list = $('pod-list')
  list.innerHTML = ''
  for (const p of podsList) {
    const btn = document.createElement('button')
    btn.className = 'sb-item pod' + (sidebarPodId === p.id ? ' on' : '')
    btn.dataset.pod = p.id
    const st = status[p.id]
    const ind = st?.work
      ? '<span class="c-ind work" title="Enni arbeitet in diesem Pod …"></span>'
      : st?.done ? '<span class="c-ind done" title="Fertig — noch nicht angesehen"></span>' : ''
    const tile = p.logo_url
      ? `<span class="pod-tile logo"><img src="${esc(p.logo_url)}" alt=""></span>`
      : `<span class="pod-tile">${esc(podInitials(p.name))}</span>`
    btn.innerHTML = `${tile}<span class="txt">${esc(p.name)}</span><span class="sb-right">${ind}${p.open ? '' : LOCK_SVG}</span>`
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
  const logo = $('pod-hero-logo')
  logo.className = 'pod-tile pod-hero-logo' + (pod.logo_url ? ' logo' : '')
  logo.innerHTML = pod.logo_url ? `<img src="${esc(pod.logo_url)}" alt="">` : esc(podInitials(pod.name))
  sidebarPodId = pod.id
  paintPodHighlight()
  document.querySelectorAll('#conv-list .sb-item').forEach((x) => x.classList.remove('on'))
  refreshPodCounts(pod.id)
  switchPodTab(tab)
  activateArea('chat', 'pod')
}

async function refreshPodCounts(podId) {
  const [convs, tasks, files] = await Promise.all([
    sb.from('conversations').select('id', { count: 'exact', head: true }).eq('pod_id', podId),
    sb.from('pod_tasks').select('id', { count: 'exact', head: true }).eq('pod_id', podId),
    sb.from('pod_files').select('id', { count: 'exact', head: true }).eq('pod_id', podId),
  ])
  if (activePod?.id !== podId) return
  $('pod-conv-count').textContent = convs.count ?? 0
  $('pod-task-count').textContent = tasks.count ?? 0
  $('pod-file-count').textContent = files.count ?? 0
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
    sb.from('conversations').select('id, title, updated_at, user_id, pod_id, working, unread').eq('pod_id', activePod.id).order('updated_at', { ascending: false }),
    allProfiles(),
  ])
  podConvsCache = (data || []).map((c) => ({ ...c, starter: profName(profs, c.user_id) }))
  $('pod-conv-count').textContent = podConvsCache.length
  $('pod-conv-search').value = ''
  $('pod-quick-input').placeholder = `Schreib dem Team in „${activePod.name}“ — @enni ruft Enni dazu …`
  renderPodConvs('')
}

function renderPodConvs(filter) {
  const list = $('pod-conv-list')
  list.innerHTML = ''
  const items = podConvsCache.filter((c) => !filter || (c.title || '').toLowerCase().includes(filter))
  for (const c of items) {
    const row = document.createElement('button')
    row.className = 'pod-conv-row'
    const ind = c.working || activeStreams.has(c.id)
      ? '<span class="c-ind work" title="Enni arbeitet …"></span>'
      : c.unread ? '<span class="c-ind done" title="Fertig — noch nicht angesehen"></span>' : ''
    row.innerHTML = `<div class="pod-conv-main"><div class="pod-conv-title">${ind}<span>${esc(c.title || 'Ohne Titel')}</span></div>
      <div class="pod-conv-meta">${esc(c.starter)}</div></div>
      <span class="pod-conv-date">${compactPodDate(c.updated_at)}</span>
      <svg class="pod-conv-arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>`
    row.addEventListener('click', () => { convPod = activePod; openConversation(c) })
    list.appendChild(row)
  }
  if (!items.length)
    list.innerHTML = `<div class="empty-plain">${filter ? 'Keine Treffer.' : 'Noch keine Konversationen — schreib unten die erste Nachricht, alle im Pod können mitlesen und mitschreiben.'}</div>`
}
$('pod-conv-search').addEventListener('input', () => renderPodConvs($('pod-conv-search').value.trim().toLowerCase()))
$('pod-new-conv').addEventListener('click', () => {
  $('pod-quick-input').scrollIntoView({ behavior: 'smooth', block: 'center' })
  $('pod-quick-input').focus()
})

function compactPodDate(value) {
  const date = new Date(value)
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate())
  const days = Math.round((startToday - startDate) / 86400000)
  if (days === 0) return 'Heute'
  if (days === 1) return 'Gestern'
  return date.toLocaleDateString('de-DE', {
    day: 'numeric', month: 'short', year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  })
}

// Pod-Composer: vollwertig wie im Chat (Anhänge, Diktat, Mention-Tags) — startet eine
// neue Team-Konversation und übergibt Text + Dateien an den normalen Send-Pfad.
let podPendingFiles = []
function renderPodChips() {
  const box = $('pod-attach-chips')
  box.hidden = !podPendingFiles.length
  box.innerHTML = ''
  podPendingFiles.forEach((p, i) => {
    const chip = document.createElement('span')
    chip.className = 'chip'
    chip.innerHTML = `<span class="ftype">${ALLOWED_FILES[p.type]}</span>${esc(p.file.name)}<button class="x" title="Entfernen">✕</button>`
    chip.querySelector('.x').addEventListener('click', () => { podPendingFiles.splice(i, 1); renderPodChips() })
    box.appendChild(chip)
  })
}
$('pod-attach-btn').addEventListener('click', () => $('pod-file-attach').click())
$('pod-file-attach').addEventListener('change', () => {
  for (const f of $('pod-file-attach').files) {
    const type = ALLOWED_FILES[f.type] ? f.type : extType(f.name)
    if (!type || !ALLOWED_FILES[type]) { window.alert(`Dateityp nicht erlaubt: ${f.name}`); continue }
    if (f.size > 10 * 1024 * 1024) { window.alert(`${f.name} ist größer als 10 MB`); continue }
    if (podPendingFiles.length >= 4) break
    podPendingFiles.push({ file: f, type })
  }
  $('pod-file-attach').value = ''
  renderPodChips()
})

function podQuickStart() {
  const text = $('pod-quick-input').value.trim()
  if (!text && !podPendingFiles.length) return
  $('pod-quick-input').value = ''
  autosizeEl($('pod-quick-input'))
  updateMentionBacks()
  // Anhänge in den normalen Send-Pfad übergeben
  pendingFiles = podPendingFiles
  podPendingFiles = []
  renderPodChips()
  renderChips()
  convPod = activePod
  newConversation()
  $('chat-title').textContent = `Neue Konversation · ${activePod.name}`
  $('composer-input').value = text
  autosize()
  send()
}
$('pod-send-btn').addEventListener('click', podQuickStart)
$('pod-quick-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); podQuickStart() }
})
$('pod-quick-input').addEventListener('input', () => { autosizeEl($('pod-quick-input')); updateMentionBacks() })
$('pod-quick-input').addEventListener('scroll', () => updateMentionBacks())
$('pod-mic-btn').addEventListener('click', () => startDictation($('pod-mic-btn'), $('pod-quick-input')))

// --- Tab: Aufgaben (awork-Muster: einklappbare Abschnitte, Zähler, Inline-Hinzufügen)
// Abschnitte entstehen durch Benutzung (wie Wiki-Ordner): section-Feld auf pod_tasks, '' = "Allgemein".
const collapsedTaskSections = new Set(JSON.parse(localStorage.getItem('tsecCollapsed') || '[]'))
let tasksShowDone = localStorage.getItem('tasksShowDone') !== '0'
const taskSectionDrafts = {} // podId -> [namen] — noch leere Abschnitte (existieren erst mit der ersten Aufgabe)
let taskAdding = null // Abschnitt, dessen Inline-Eingabe gerade offen ist

const CHECK_SVG = '<svg viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>'
const CAL_SVG = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
const X_SVG = '<svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg>'
const PEN_SVG = '<svg viewBox="0 0 24 24"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg>'
const PERSON_SVG = '<svg viewBox="0 0 24 24"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>'

function fmtDue(d) {
  return new Date(d + 'T00:00').toLocaleDateString('de-DE', { day: 'numeric', month: 'long' })
}
function isOverdue(t) {
  return t.due_date && t.status !== 'done' && t.due_date < new Date().toISOString().slice(0, 10)
}

async function loadPodTasks() {
  const podId = activePod.id
  const [{ data }, profs] = await Promise.all([
    sb.from('pod_tasks').select('*').eq('pod_id', podId).order('created_at'),
    allProfiles(),
  ])
  const tasks = data || []
  $('pod-task-count').textContent = tasks.length
  // Gruppen: "Allgemein" ('') zuerst, dann Abschnitte in Reihenfolge der ersten Verwendung, dann leere Entwürfe
  const groups = new Map([['', []]])
  for (const t of tasks) {
    if (!groups.has(t.section)) groups.set(t.section, [])
    groups.get(t.section).push(t)
  }
  for (const d of taskSectionDrafts[podId] || []) if (!groups.has(d)) groups.set(d, [])
  const list = $('pod-task-list')
  list.innerHTML = ''
  for (const [section, items] of groups) {
    if (section === '' && !items.length && groups.size > 1 && taskAdding !== '') continue
    list.appendChild(renderTaskSection(section, items, profs))
  }
  // Offene Inline-Eingabe fokussieren (nach Re-Render, z.B. direkt nach dem Speichern)
  list.querySelector('.t-inline')?.focus()
}

function renderTaskSection(section, items, profs) {
  const podId = activePod.id
  const key = podId + ':' + section
  const open = !collapsedTaskSections.has(key)
  const doneN = items.filter((t) => t.status === 'done').length
  const wrap = document.createElement('div')
  wrap.className = 'tsec'
  const head = document.createElement('button')
  head.className = 'tsec-head' + (open ? ' open' : '')
  head.innerHTML = `<span class="tree-chev">▶</span><span class="tsec-title">${esc(section || 'Allgemein')}</span>
    <span class="tsec-count${items.length && doneN === items.length ? ' full' : ''}">${CHECK_SVG}${doneN}/${items.length}</span>
    ${section ? `<span class="sb-acts">
      <span class="sb-act ts-rename" title="Abschnitt umbenennen">${PEN_SVG}</span>
      <span class="sb-act ts-del" title="Abschnitt auflösen — Aufgaben wandern nach Allgemein">${X_SVG}</span>
    </span>` : ''}`
  head.addEventListener('click', (e) => {
    if (e.target.closest('.sb-act')) return
    if (collapsedTaskSections.has(key)) collapsedTaskSections.delete(key)
    else collapsedTaskSections.add(key)
    localStorage.setItem('tsecCollapsed', JSON.stringify([...collapsedTaskSections]))
    loadPodTasks()
  })
  head.querySelector('.ts-rename')?.addEventListener('click', () => renameTaskSection(head, section))
  head.querySelector('.ts-del')?.addEventListener('click', async () => {
    if (!window.confirm(`Abschnitt "${section}" auflösen? Die Aufgaben wandern nach Allgemein.`)) return
    await sb.from('pod_tasks').update({ section: '' }).eq('pod_id', podId).eq('section', section)
    taskSectionDrafts[podId] = (taskSectionDrafts[podId] || []).filter((d) => d !== section)
    loadPodTasks()
  })
  wrap.appendChild(head)
  if (!open) return wrap
  // Offene zuerst, Erledigte ans Ende (stabil in Anlage-Reihenfolge);
  // Erledigte optional ausblenden (Toggle im Kopf) — der Zähler zeigt sie weiterhin
  const sorted = [...items]
    .sort((a, b) => (a.status === 'done') - (b.status === 'done'))
    .filter((t) => tasksShowDone || t.status !== 'done')
  for (const t of sorted) wrap.appendChild(renderTaskRow(t, profs))
  wrap.appendChild(taskAdding === section ? taskInputRow(section, profs) : taskGhostRow(section))
  return wrap
}

function renameTaskSection(head, section) {
  const title = head.querySelector('.tsec-title')
  const input = document.createElement('input')
  input.className = 'tsec-rename'
  input.value = section
  title.replaceWith(input)
  input.focus()
  input.select()
  let done = false
  const save = async (commit) => {
    if (done) return
    done = true
    const name = input.value.trim()
    if (commit && name && name !== section) {
      await sb.from('pod_tasks').update({ section: name }).eq('pod_id', activePod.id).eq('section', section)
      const drafts = taskSectionDrafts[activePod.id] || []
      taskSectionDrafts[activePod.id] = drafts.map((d) => (d === section ? name : d))
    }
    loadPodTasks()
  }
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') save(true)
    if (e.key === 'Escape') save(false)
  })
  input.addEventListener('blur', () => save(true))
}

function renderTaskRow(t, profs) {
  const row = document.createElement('div')
  row.className = 'trow'
  const done = t.status === 'done'
  const ind = t.status === 'in_progress' ? '<span class="c-ind work" title="Enni arbeitet …"></span>' : ''
  const assigneeProfile = t.assignee ? profs.find((p) => p.id === t.assignee) : null
  const assignee = assigneeProfile ? assigneeProfile.display_name || assigneeProfile.email : null
  row.innerHTML = `
    <label class="task-check-wrap" title="${done ? 'Als offen markieren' : 'Als erledigt markieren'}">
      <input type="checkbox" class="task-check" ${done ? 'checked' : ''}>
      <span class="task-check-ui"><svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-9"/></svg></span>
    </label>
    <div class="t-main"><div class="r-name task-title${done ? ' done' : ''}">${ind}${esc(t.title)}</div>
      <div class="r-sub">von ${esc(profName(profs, t.created_by))}</div></div>
    <span class="t-meta">
      <span class="t-acts">
        <span class="sb-act t-assign" title="Person zuweisen …">${PERSON_SVG}</span>
        <span class="sb-act t-date" title="Fällig am …">${CAL_SVG}</span>
        <span class="sb-act t-del" title="Löschen">${X_SVG}</span>
      </span>
      ${t.due_date ? `<span class="t-due${isOverdue(t) ? ' over' : ''}" title="Fällig">${fmtDue(t.due_date)}</span>` : ''}
      ${t.conversation_id ? `<button class="glass-icon task-conv" title="Konversation öffnen" aria-label="Konversation öffnen"><svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg></button>` : ''}
      ${assignee ? `<span class="avatar t-av t-av-btn" title="Zugewiesen an ${esc(assignee)} — Klick ändert" style="cursor:pointer">${profileAvatarInner(assigneeProfile, assignee)}</span>` : ''}
      <button class="task-run" title="Enni an dieser Aufgabe arbeiten lassen" aria-label="Enni an dieser Aufgabe arbeiten lassen"><span class="enni-mini"></span></button>
    </span>
    <input type="date" class="t-date-input" style="position:absolute;width:0;height:0;opacity:0;border:0;padding:0">`
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
  const dateInput = row.querySelector('.t-date-input')
  row.querySelector('.t-date').addEventListener('click', () => {
    dateInput.value = t.due_date || ''
    try { dateInput.showPicker() } catch { dateInput.click() }
  })
  dateInput.addEventListener('change', async () => {
    await sb.from('pod_tasks').update({ due_date: dateInput.value || null }).eq('id', t.id)
    loadPodTasks()
  })
  row.querySelector('.t-del').addEventListener('click', async () => {
    if (!window.confirm(`Aufgabe "${t.title}" löschen?`)) return
    await sb.from('pod_tasks').delete().eq('id', t.id)
    loadPodTasks()
  })
  row.querySelector('.t-assign').addEventListener('click', (e) => openAssignMenu(e.currentTarget, t, profs))
  row.querySelector('.t-av-btn')?.addEventListener('click', (e) => openAssignMenu(e.currentTarget, t, profs))
  return row
}

function taskGhostRow(section) {
  const btn = document.createElement('button')
  btn.className = 't-ghost'
  btn.innerHTML = '<span class="gc"></span>Aufgabe hinzufügen'
  btn.addEventListener('click', () => {
    taskAdding = section
    loadPodTasks()
  })
  return btn
}

function taskInputRow(section, profs) {
  const row = document.createElement('div')
  row.className = 'trow tin'
  row.innerHTML = '<span class="gc"></span><input class="t-inline" placeholder="Aufgabe — Enter speichert, Esc bricht ab">'
  const inp = row.querySelector('input')
  inp.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') { taskAdding = null; loadPodTasks(); return }
    if (e.key === 'Enter') {
      const title = inp.value.trim()
      if (!title) return
      inp.value = ''
      // Optimistisch: Zeile lokal einhängen, Fokus bleibt in der Eingabe — kein Re-Render,
      // sonst gehen Tastenanschläge beim schnellen Nacheinander-Anlegen verloren.
      const { data: t, error } = await sb
        .from('pod_tasks')
        .insert({ pod_id: activePod.id, title, section, created_by: session.user.id })
        .select().single()
      if (error || !t) { inp.value = title; return }
      row.before(renderTaskRow(t, profs))
      const count = row.closest('.tsec')?.querySelector('.tsec-count')
      if (count) {
        const [d, n] = count.textContent.split('/').map((x) => parseInt(x, 10))
        count.lastChild.textContent = `${d}/${n + 1}`
      }
      const drafts = taskSectionDrafts[activePod.id] || []
      taskSectionDrafts[activePod.id] = drafts.filter((d) => d !== section)
    }
  })
  inp.addEventListener('blur', () => {
    setTimeout(() => {
      if (taskAdding === section && !inp.value.trim() && document.activeElement !== inp) {
        taskAdding = null
        loadPodTasks()
      }
    }, 150)
  })
  return row
}

$('tasks-show-done').checked = tasksShowDone
$('tasks-show-done').addEventListener('change', () => {
  tasksShowDone = $('tasks-show-done').checked
  localStorage.setItem('tasksShowDone', tasksShowDone ? '1' : '0')
  loadPodTasks()
})

// Aufgabe einem Pod-Mitglied zuweisen (kleines Popover am Personen-Icon/Avatar)
function openAssignMenu(anchor, t, profs) {
  document.querySelector('.assign-menu')?.remove()
  const candidates = activePod.open
    ? profs
    : profs.filter((p) => activePod.members.includes(p.id) || p.id === activePod.created_by)
  const menu = document.createElement('div')
  menu.className = 'assign-menu'
  const entry = (html, val) => {
    const b = document.createElement('button')
    b.innerHTML = html
    b.addEventListener('click', async () => {
      menu.remove()
      await sb.from('pod_tasks').update({ assignee: val }).eq('id', t.id)
      loadPodTasks()
    })
    return b
  }
  menu.appendChild(entry('<span class="none-av"></span>Niemand zugewiesen', null))
  for (const p of candidates) {
    const name = p.display_name || p.email
    menu.appendChild(entry(`<span class="avatar t-av">${profileAvatarInner(p, name)}</span>${esc(name)}`, p.id))
  }
  document.body.appendChild(menu)
  const r = anchor.getBoundingClientRect()
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - menu.offsetHeight - 12) + 'px'
  menu.style.left = Math.max(12, r.right - menu.offsetWidth) + 'px'
  setTimeout(() => {
    const close = (e) => { if (!menu.contains(e.target)) { menu.remove(); document.removeEventListener('click', close) } }
    document.addEventListener('click', close)
  }, 0)
}

$('section-add-btn').addEventListener('click', () => {
  const list = $('pod-task-list')
  if (list.querySelector('.tsec-new')) { list.querySelector('.tsec-new input').focus(); return }
  const wrap = document.createElement('div')
  wrap.className = 'tsec tsec-new'
  wrap.innerHTML = '<div class="tsec-head open"><span class="tree-chev">▶</span><input class="tsec-rename" placeholder="Name des Abschnitts …"></div>'
  const inp = wrap.querySelector('input')
  const commit = () => {
    const name = inp.value.trim()
    if (!name) { wrap.remove(); return }
    const drafts = (taskSectionDrafts[activePod.id] ||= [])
    if (!drafts.includes(name)) drafts.push(name)
    taskAdding = name
    loadPodTasks()
  }
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') wrap.remove()
  })
  inp.addEventListener('blur', () => setTimeout(() => { if (wrap.isConnected) commit() }, 150))
  list.appendChild(wrap)
  inp.focus()
})

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
  // Explizit zugewiesene Person nicht überschreiben — nur setzen, wenn noch niemand zugewiesen ist
  await sb.from('pod_tasks').update({ status: 'in_progress', assignee: taskForModal.assignee || session.user.id }).eq('id', taskForModal.id)
  convPod = activePod
  pendingTaskId = taskForModal.id
  newConversation()
  $('chat-title').textContent = `Aufgabe: ${taskForModal.title}`
  $('composer-input').value = `Bitte arbeite an dieser Aufgabe aus dem Pod "${activePod.name}": ${taskForModal.title}` + (custom ? `\n\nZusätzlicher Kontext: ${custom}` : '')
  autosize()
  send()
})

// --- Tab: Dateien
const FILE_DOC_SVG = '<svg viewBox="0 0 24 24"><path d="M6 2h8l4 4v16H6z"/><path d="M14 2v5h5"/><path d="M9 13h6M9 17h5"/></svg>'
const FILE_EYE_SVG = '<svg viewBox="0 0 24 24"><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.5"/></svg>'
const FILE_DOWNLOAD_SVG = '<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>'
const FILE_TRASH_SVG = '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="m6 7 1 14h10l1-14"/><path d="M10 11v6M14 11v6"/></svg>'

async function signedPodFileUrl(file, download = false) {
  const options = download ? { download: file.name } : undefined
  const { data, error } = await sb.storage.from('pod-files').createSignedUrl(file.storage_path, 300, options)
  if (error || !data?.signedUrl) {
    alert('Datei konnte nicht geöffnet werden.')
    return null
  }
  return data.signedUrl
}

async function loadPodFiles() {
  const [{ data }, profs] = await Promise.all([
    sb.from('pod_files').select('*').eq('pod_id', activePod.id).order('created_at', { ascending: false }),
    allProfiles(),
  ])
  $('pod-file-count').textContent = (data || []).length
  const list = $('pod-file-list')
  list.innerHTML = ''
  for (const f of data || []) {
    const row = document.createElement('div')
    row.className = 'file-row'
    row.innerHTML = `<span class="file-kind">${FILE_DOC_SVG}</span>
      <div class="file-main"><div class="file-name">${esc(f.name)}</div>
      <div class="file-sub">${esc(f.media_type || 'Datei')} · ${(f.size / 1024 / 1024).toFixed(1)} MB · ${esc(profName(profs, f.uploaded_by))}</div></div>
      <div class="file-actions">
        <button class="glass-icon f-preview" title="Vorschau öffnen" aria-label="${esc(f.name)} ansehen">${FILE_EYE_SVG}</button>
        <button class="glass-icon f-download" title="Herunterladen" aria-label="${esc(f.name)} herunterladen">${FILE_DOWNLOAD_SVG}</button>
        <button class="glass-icon danger f-del" title="Löschen" aria-label="${esc(f.name)} löschen">${FILE_TRASH_SVG}</button>
      </div>`
    row.querySelector('.f-preview').addEventListener('click', async () => {
      const preview = window.open('about:blank', '_blank')
      const url = await signedPodFileUrl(f)
      if (url && preview) preview.location.href = url
      else preview?.close()
    })
    row.querySelector('.f-download').addEventListener('click', async () => {
      const url = await signedPodFileUrl(f, true)
      if (!url) return
      const a = document.createElement('a')
      a.href = url
      a.download = f.name
      document.body.appendChild(a)
      a.click()
      a.remove()
    })
    row.querySelector('.f-del').addEventListener('click', async () => {
      if (!window.confirm(`Datei "${f.name}" löschen?`)) return
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

let pendingPodLogo = null // File = neues Logo, 'remove' = Logo entfernen, null = unverändert
function paintPodLogoTile() {
  const tile = $('pset-logo-tile')
  const url = pendingPodLogo instanceof File
    ? URL.createObjectURL(pendingPodLogo)
    : pendingPodLogo === 'remove' ? null : activePod.logo_url
  tile.classList.toggle('logo', !!url)
  tile.innerHTML = url ? `<img src="${esc(url)}" alt="">` : esc(podInitials(activePod.name))
  $('pset-logo-remove').hidden = !url
}

async function fillPodSettings() {
  $('pset-name').value = activePod.name
  $('pset-desc').value = activePod.description || ''
  $('pset-instructions').value = activePod.instructions || ''
  $('pset-open').checked = activePod.open
  pendingPodLogo = null
  paintPodLogoTile()
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
$('pset-logo-btn').addEventListener('click', () => $('pset-logo-file').click())
$('pset-logo-file').addEventListener('change', () => {
  const f = $('pset-logo-file').files[0]
  $('pset-logo-file').value = ''
  if (!f) return
  if (f.size > 2 * 1024 * 1024) { window.alert('Logo: max. 2 MB.'); return }
  pendingPodLogo = f
  paintPodLogoTile()
})
$('pset-logo-remove').addEventListener('click', () => {
  pendingPodLogo = 'remove'
  paintPodLogoTile()
})

$('pset-save').addEventListener('click', async () => {
  const patch = {
    name: $('pset-name').value.trim() || activePod.name,
    description: $('pset-desc').value.trim(),
    instructions: $('pset-instructions').value.trim(),
    open: $('pset-open').checked,
  }
  try {
    if (pendingPodLogo) {
      // Alte Logos dieses Pods aufräumen (public Bucket avatars, Prefix pod-{id})
      const { data: old } = await sb.storage.from('avatars').list('', { search: `pod-${activePod.id}` })
      if (old?.length) await sb.storage.from('avatars').remove(old.map((o) => o.name))
    }
    if (pendingPodLogo instanceof File) {
      const ext = (pendingPodLogo.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg')
      const path = `pod-${activePod.id}-${Date.now()}.${ext}`
      const { error: upErr } = await sb.storage.from('avatars').upload(path, pendingPodLogo)
      if (upErr) throw upErr
      patch.logo_url = sb.storage.from('avatars').getPublicUrl(path).data.publicUrl
    } else if (pendingPodLogo === 'remove') {
      patch.logo_url = null
    }
  } catch (err) {
    window.alert('Logo-Upload fehlgeschlagen: ' + err.message)
    return
  }
  const { error } = await sb.from('pods').update(patch).eq('id', activePod.id)
  if (error) { alert('Fehler: ' + error.message); return }
  Object.assign(activePod, patch)
  pendingPodLogo = null
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

// Diktat v2: Aufnahme via MediaRecorder → serverseitige Transkription (ElevenLabs Scribe,
// versteht Deutsch + Englisch GEMISCHT in derselben Aufnahme). Fällt automatisch auf die
// Browser-Spracherkennung zurück, wenn der Server-Endpoint nicht konfiguriert ist (503).
let mediaRec = null
// Fallback-Flag bewusst NUR in-memory: nach einem Reload wird Server-STT wieder
// versucht (sonst bliebe man dauerhaft auf Browser-Erkennung, obwohl der Key längst da ist)
let sttFallback = false
localStorage.removeItem('sttFallback') // Altlast aus der Zeit vor dem ELEVENLABS_API_KEY
async function startDictation(btn, textarea, withLangHint = false) {
  if (sttFallback || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder)
    return startDictationWebSpeech(btn, textarea, withLangHint)
  if (mediaRec) { mediaRec.stop(); return } // läuft → Klick stoppt
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  } catch (err) {
    showHint('Mikrofon nicht verfügbar: ' + err.message)
    return
  }
  const chunks = []
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
  mediaRec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  mediaRec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  mediaRec.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop())
    btn.classList.remove('recording')
    const blob = new Blob(chunks, { type: mediaRec?.mimeType || 'audio/webm' })
    mediaRec = null
    if (blob.size < 1500) return // zu kurz, nichts gesagt
    btn.disabled = true
    btn.style.opacity = '.45'
    try {
      const res = await fetch(`${BACKEND_URL}/api/transcribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ audio_base64: await fileToBase64(blob), mime: blob.type }),
      })
      if (res.status === 503) {
        sttFallback = true // nur für diese Sitzung — Reload versucht Server-STT erneut
        showHint('Server-Diktat noch nicht konfiguriert — Browser-Erkennung übernimmt, bitte nochmal aufs Mikro klicken.')
        return
      }
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      const base = textarea.value ? textarea.value.trim() + ' ' : ''
      textarea.value = base + (data.text || '').trim()
      autosizeEl(textarea)
      updateMentionBacks()
      textarea.focus()
    } catch (err) {
      showHint('Diktat-Fehler: ' + err.message)
    } finally {
      btn.disabled = false
      btn.style.opacity = ''
    }
  }
  mediaRec.start()
  btn.classList.add('recording')
}

function startDictationWebSpeech(btn, textarea, withLangHint = false) {
  if (!SpeechRec) { showHint('Diktat wird von diesem Browser nicht unterstützt (Chrome/Edge/Safari nutzen).'); return }
  if (dictating) { recognition?.stop(); return }
  recognition = new SpeechRec()
  recognition.lang = sttLang()
  recognition.continuous = true
  recognition.interimResults = true
  dictBase = textarea.value ? textarea.value.trim() + ' ' : ''
  recognition.onresult = (e) => {
    let text = ''
    for (const res of e.results) text += res[0].transcript
    textarea.value = dictBase + text
    autosizeEl(textarea)
    updateMentionBacks()
  }
  recognition.onend = () => {
    dictating = false
    btn.classList.remove('recording')
    if (withLangHint) renderCtx()
  }
  recognition.onerror = (e) => { if (e.error !== 'aborted') showHint('Diktat-Fehler: ' + e.error) }
  recognition.start()
  dictating = true
  btn.classList.add('recording')
  if (!withLangHint) return
  const other = sttLang() === 'de-DE' ? 'en-US' : 'de-DE'
  const hint = $('ctx-hint')
  hint.hidden = false
  hint.className = 'ctx-hint'
  hint.innerHTML = `Aufnahme läuft (${sttLang() === 'de-DE' ? 'Deutsch' : 'English'}) — Klick aufs Mikro stoppt · <a href="#" id="stt-switch" style="color:var(--lila-deep)">auf ${other === 'de-DE' ? 'Deutsch' : 'English'} wechseln</a>`
  document.getElementById('stt-switch').addEventListener('click', (ev) => {
    ev.preventDefault()
    localStorage.setItem('enni-stt-lang', other)
    recognition.stop()
    setTimeout(() => btn.click(), 300)
  })
}
$('mic-btn').addEventListener('click', () => startDictation($('mic-btn'), $('composer-input'), true))

// ============================================================ Composer-Autosize
function autosizeEl(t) {
  t.style.height = 'auto'
  t.style.height = Math.min(t.scrollHeight, 180) + 'px'
}
function autosize() {
  autosizeEl($('composer-input'))
  updateMentionBacks()
}
$('composer-input').addEventListener('input', autosize)
$('composer-input').addEventListener('scroll', () => updateMentionBacks())

// ============================================================ Mention-Tags im Composer
// Backdrop hinter der Textarea rendert denselben Text transparent und legt Pills
// hinter erkannte @Mentions (Enni + alle Team-Namen) — sieht aus wie ein Tag.
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function renderMentionBack(textarea, back) {
  if (!back) return
  const val = textarea.value
  if (!val) { back.innerHTML = ''; return }
  const names = ['enni', ...(profilesCache || []).map((p) => p.display_name || p.email).filter(Boolean)]
  const re = new RegExp(`@(${names.sort((a, b) => b.length - a.length).map(escRe).join('|')})`, 'gi')
  back.innerHTML = esc(val).replace(re, '<span class="mtag">$&</span>')
  back.scrollTop = textarea.scrollTop
}
function updateMentionBacks() {
  renderMentionBack($('composer-input'), $('hl-back'))
  const pod = $('pod-quick-input')
  if (pod) renderMentionBack(pod, $('pod-hl-back'))
}

// ============================================================ Senden + Streaming
// ============================================================ Prompt-Warteschlange
// Während Enni arbeitet, kann der Nutzer weitere Nachrichten senden — sie werden
// pro Konversation gequeued und nach Abschluss des laufenden Turns automatisch gesendet.
const promptQueues = new Map() // convId -> [{ text, files, el }]

function queueAttachmentMeta(files) {
  return (files || []).map((f) => ({ name: f.file.name, media_type: f.type }))
}

function removeQueuedPrompt(convId, item) {
  const list = promptQueues.get(convId) || []
  const idx = list.indexOf(item)
  if (idx >= 0) list.splice(idx, 1)
  item.wrap?.remove()
  if (!list.length) {
    promptQueues.delete(convId)
    $('msgs').querySelector('.prompt-queue')?.remove()
  } else updatePromptQueue(convId)
}

function renderQueuedPrompt(convId, item, dock) {
  item.wrap = document.createElement('div')
  item.wrap.className = 'queued-item'
  item.el = renderUser(item.text || item.files.map((f) => f.file.name).join(', '), queueAttachmentMeta(item.files))
  item.el.classList.add('queued')
  item.tag = document.createElement('button')
  item.tag.className = 'queued-tag'
  item.tag.addEventListener('click', () => removeQueuedPrompt(convId, item))
  item.wrap.append(item.el, item.tag)
  dock.appendChild(item.wrap)
}

function updatePromptQueue(convId) {
  const list = promptQueues.get(convId) || []
  const dock = $('msgs').querySelector('.prompt-queue')
  if (!dock) return
  dock.querySelector('.prompt-queue-head').textContent = `Danach · ${list.length} ${list.length === 1 ? 'Prompt' : 'Prompts'}`
  list.forEach((item, i) => { if (item.tag) item.tag.textContent = `${i + 1}. in der Warteschlange · entfernen` })
}

function mountPromptQueue(convId) {
  const box = $('msgs')
  box.querySelector('.prompt-queue')?.remove()
  const list = promptQueues.get(convId) || []
  if (!list.length) return null
  const dock = document.createElement('div')
  dock.className = 'prompt-queue'
  dock.dataset.conversation = convId
  dock.innerHTML = '<div class="prompt-queue-head"></div>'
  for (const item of list) renderQueuedPrompt(convId, item, dock)
  box.appendChild(dock)
  updatePromptQueue(convId)
  return dock
}

function appendBeforePromptQueue(box, node) {
  const dock = box.querySelector('.prompt-queue')
  if (dock) box.insertBefore(node, dock)
  else box.appendChild(node)
}

function enqueuePrompt(convId, text) {
  const input = $('composer-input')
  const files = pendingFiles
  pendingFiles = []
  renderChips()
  input.value = ''
  autosize()
  const q = promptQueues.get(convId) || []
  const item = { text, files, el: null, tag: null, wrap: null }
  q.push(item)
  promptQueues.set(convId, q)
  const dock = $('msgs').querySelector('.prompt-queue') || mountPromptQueue(convId)
  if (item.wrap == null) renderQueuedPrompt(convId, item, dock)
  updatePromptQueue(convId)
  item.wrap.scrollIntoView({ block: 'end' })
}

function drainPromptQueue(convId) {
  const q = promptQueues.get(convId)
  if (!q?.length) return
  // Nur senden, wenn die Konversation gerade offen ist und nichts mehr läuft
  if (currentConv?.id !== convId || activeStreams.has(convId) || currentConv.working) return
  const item = q.shift()
  item.wrap?.remove()
  if (!q.length) {
    promptQueues.delete(convId)
    $('msgs').querySelector('.prompt-queue')?.remove()
  } else updatePromptQueue(convId)
  $('composer-input').value = item.text
  pendingFiles = item.files || []
  renderChips()
  send()
}

async function send() {
  const input = $('composer-input')
  const text = input.value.trim()
  if (!text && !pendingFiles.length) return
  if (compacting) return
  // Enni arbeitet hier gerade -> Nachricht queuen statt blocken (Prompt-Warteschlange)
  const busyHere = sendingViews.has(viewSeq) || (currentConv && (activeStreams.has(currentConv.id) || currentConv.working))
  if (busyHere && currentConv) { enqueuePrompt(currentConv.id, text); return }
  if (busyHere) return
  if (ctxPct() >= 80) { renderCtx(); return } // Pflicht-Kompaktierung (Dust: 80%)
  if (dictating) recognition?.stop()
  input.value = ''
  autosize()
  // Multi-Session: dieser Stream gehört zu DIESER Ansicht — wechselt der Nutzer weg,
  // läuft er weiter (Backend persistiert), fasst aber die neue Ansicht nicht mehr an.
  const mySeq = viewSeq
  const inView = () => viewSeq === mySeq
  let streamConvId = currentConv?.id || null
  if (streamConvId) activeStreams.add(streamConvId)
  sendingViews.add(mySeq)
  updateComposerState()

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
  appendBeforePromptQueue(box, renderUser(text || 'Bitte analysiere die angehängten Dateien.', attachMeta))
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
    // Zugeklappt starten — der Shimmer-Status im Header zeigt jederzeit, WAS Enni tut
    think.className = 'think'
    think.innerHTML = `<button class="think-head"><span class="chev">▶</span><span class="t-status shimmer">Enni denkt nach …</span></button>`
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
    appendBeforePromptQueue(box, wrap)
    wrap.scrollIntoView({ block: 'end' })
  }

  let thinkingText = ''
  let answerText = ''
  let thinkPara = null
  let toolCount = 0
  const pendingTools = {}

  const follow = followIfNearBottom
  // Arbeitsdauer live im Shimmer-Status (Codex: "Working for 21s")
  const t0 = Date.now()
  let statusLabel = 'Enni denkt nach …'
  const paintStatus = (working = true) => {
    const el = think?.querySelector('.t-status')
    if (!el) return
    el.textContent = working ? `${statusLabel} · ${fmtDur(Date.now() - t0)}` : statusLabel
    el.classList.toggle('shimmer', working)
  }
  const setStatus = (label, working = true) => {
    statusLabel = label
    paintStatus(working)
  }
  const statusTimer = setInterval(() => {
    if (think?.isConnected && sendingViews.has(mySeq)) paintStatus()
  }, 1000)

  try {
    const chatRequest = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({
        conversation_id: currentConv?.id,
        message: text,
        model: $('model-select').value,
        attachments: attachments.length ? attachments : undefined,
        pod_id: !currentConv && convPod ? convPod.id : undefined,
      }),
    }
    let res
    try {
      res = await fetch(`${BACKEND_URL}/api/chat`, chatRequest)
    } catch (firstError) {
      // Railway/Netzwerk kann einen einzelnen Verbindungsaufbau verlieren. Nur
      // VOR Empfang der Response einmal neu verbinden; ein abgerissener SSE-Stream
      // wird bewusst nicht erneut gesendet (sonst könnte die Nachricht doppelt laufen).
      if (!(firstError instanceof TypeError)) throw firstError
      setStatus('Verbindung wird wiederhergestellt …')
      await new Promise((resolve) => setTimeout(resolve, 900))
      await fetch(`${BACKEND_URL}/health`, { cache: 'no-store' }).catch(() => null)
      res = await fetch(`${BACKEND_URL}/api/chat`, chatRequest)
    }
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

        if (ev.type === 'conversation') {
          if (!streamConvId) {
            streamConvId = ev.conversation_id
            activeStreams.add(streamConvId)
            loadConversations() // neue Konversation sofort mit Puls-Punkt in der Sidebar
          }
          if (inView() && !currentConv) {
            currentConv = { id: ev.conversation_id, title: text.slice(0, 80), pod_id: convPod?.id || null }
            $('chat-close').hidden = false
            updateComposerState() // Konversations-ID da → Send-Button wird zum Stop-Button
            if (pendingTaskId) {
              sb.from('pod_tasks').update({ conversation_id: ev.conversation_id }).eq('id', pendingTaskId).then(() => {})
              pendingTaskId = null
            }
          }
        } else if (ev.type === 'thinking_delta') {
          thinkingText += ev.text
          if (!thinkPara) {
            thinkPara = document.createElement('div')
            thinkPara.className = 'tp'
            thinkBody.insertBefore(thinkPara, runIndicator)
          }
          thinkPara.textContent = thinkingText
          setStatus('Enni denkt nach …')
          follow()
        } else if (ev.type === 'tool_use') {
          toolCount++
          thinkPara = null // nächster Thinking-Block wird neuer Absatz
          thinkingText = ''
          // Text VOR einem Tool-Aufruf war Arbeits-Narrativ, keine finale Antwort —
          // er wandert ins Gedanken-Panel, der Antwortbereich bleibt sauber.
          if (answerText.trim()) {
            const narr = document.createElement('div')
            narr.className = 'tp narr'
            narr.innerHTML = md(answerText)
            thinkBody.insertBefore(narr, runIndicator)
            answerText = ''
            body.innerHTML = ''
          }
          const call = { name: ev.name, input: ev.input, output: 'läuft …', is_error: false }
          const row = toolRow(call)
          pendingTools[ev.name + ':' + toolCount] = { call, row }
          pendingTools['last:' + ev.name] = { call, row }
          thinkBody.insertBefore(row, runIndicator)
          setStatus(`Nutzt ${ev.name} …`)
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
          // Blinkender Cursor = es kommt noch Text; verschwindet erst bei "done"
          body.innerHTML = md(answerText)
          body.insertAdjacentHTML('beforeend', '<span class="scursor"></span>')
          setStatus('Schreibt …')
          follow()
        } else if (ev.type === 'done') {
          if (!isTeamMsg) {
            body.innerHTML = md(answerText) // Cursor entfernen — Antwort ist final
            if (ev.stopped && !answerText.trim()) body.innerHTML = '<p><em>Gestoppt.</em></p>'
            runIndicator.remove()
            enhanceCode(body)
            renderFileCards(body)
            thinkBody.insertAdjacentHTML('beforeend', `<div class="think-done">${ev.stopped ? '⏹ Gestoppt' : '✓ Fertig'}</div>`)
            think.classList.remove('open')
            const dur = ev.duration_ms || Date.now() - t0
            setStatus(`Gedanken${toolCount ? ` · ${toolCount} Tool-Aufruf${toolCount > 1 ? 'e' : ''}` : ''} · ${fmtDur(dur)}`, false)
            wrap.appendChild(agentMeta(() => answerText, ev.cost_eur))
            // volle Tool-Outputs aus der DB nachladen (Stream enthält nur Status)
            hydrateToolOutputs(ev.message_id, thinkBody, wrap)
          }
        } else if (ev.type === 'title') {
          if (currentConv?.id === streamConvId) currentConv.title = ev.title
          if (inView() && !convPod) $('chat-title').textContent = ev.title
          loadConversations()
        } else if (ev.type === 'error') {
          runIndicator?.remove()
          ;(body || box).insertAdjacentHTML('beforeend', `<p style="color:var(--high)">${esc(ev.message)}</p>`)
        }
      }
    }
  } catch (err) {
    runIndicator?.remove()
    const message = err instanceof TypeError
      ? 'Verbindung zu Enni unterbrochen. Bitte sende die Nachricht erneut.'
      : `Fehler: ${err.message}`
    ;(body || box).insertAdjacentHTML('beforeend', `<p style="color:var(--high)">${esc(message)}</p>`)
  }

  clearInterval(statusTimer)
  sendingViews.delete(mySeq)
  if (streamConvId) activeStreams.delete(streamConvId)
  updateComposerState()
  if (inView()) {
    ctxTokens += Math.round((text.length + answerText.length) / 4)
    renderCtx()
    $('composer-input').focus()
  }
  // Nutzer schaut gerade auf diese Konversation → "fertig"-Punkt direkt löschen;
  // kam er mittendrin zurück (andere Ansicht, gleiche Konv), Ansicht mit finaler Antwort neu laden
  if (streamConvId) statusSnapshot.set(streamConvId, { working: false, unread: false })
  if (streamConvId && currentConv?.id === streamConvId) {
    currentConv.working = false // sonst baut der Reload einen Geister-Live-Container
    sb.from('conversations').update({ unread: false }).eq('id', streamConvId).then(() => {})
    if (!inView()) openConversation(currentConv)
  }
  loadConversations()
  refreshCosts()
  if (streamConvId) drainPromptQueue(streamConvId)
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
  if (wrap) {
    renderWriteCards(wrap, data.tool_calls)
    renderConnectCards(wrap, data.tool_calls)
  }
}

$('send-btn').addEventListener('click', () => {
  if ($('send-btn').classList.contains('stop')) stopTurn()
  else send()
})
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
    { insert: '@enni', name: 'Enni ruft den AI-Assistenten in die Konversation' },
    ...people
      .filter((p) => p.id !== session.user.id)
      .map((p) => ({
        insert: '@' + (p.display_name || p.email.split('@')[0]).split(' ')[0],
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
    (c) => c.insert.slice(1).toLowerCase().startsWith(query) || c.name.toLowerCase().includes(query)
  )
  if (!items.length) return mentionClose()
  mentionState = { input, items, sel: 0, start: pos - query.length - 1 }
  renderMentionMenu()
}

// Slash-Autocomplete: "/" am Nachrichtenanfang schlägt Skills vor
let skillsCache = null
async function allSkills() {
  if (!skillsCache) {
    // Nur Skills, die für MICH per /slash aufrufbar sind: team-weite + meine eigenen
    const { data } = await sb
      .from('skills').select('slug, name, visibility, created_by').eq('enabled', true).order('slug')
    skillsCache = (data || []).filter((s) => s.visibility === 'team' || s.created_by === session.user.id)
  }
  return skillsCache
}

async function slashCheck(input) {
  const pos = input.selectionStart
  const before = input.value.slice(0, pos)
  const m = before.match(/^\/([a-z0-9-]*)$/i)
  if (!m) return false
  const q = m[1].toLowerCase()
  const skills = (await allSkills()).filter(
    (s) => s.slug.startsWith(q) || s.name.toLowerCase().includes(q)
  )
  if (!skills.length) return false
  mentionState = {
    input,
    items: skills.map((s) => ({ insert: '/' + s.slug, name: s.name })),
    sel: 0,
    start: 0,
  }
  renderMentionMenu()
  return true
}

function renderMentionMenu() {
  const { input, items, sel } = mentionState
  mentionMenu.innerHTML = items
    .map(
      (c, i) =>
        `<button class="mm-row${i === sel ? ' on' : ''}" data-i="${i}"><span class="mm-name">${esc(c.insert)}</span><span class="mm-sub">${esc(c.name)}</span></button>`
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
  input.value = `${input.value.slice(0, start)}${c.insert} ${after}`
  const caret = start + c.insert.length + 1
  mentionClose()
  input.focus()
  input.setSelectionRange(caret, caret)
  if (input.id === 'composer-input') autosize()
  else autosizeEl(input)
  updateMentionBacks()
}

function attachMentions(input, getPod) {
  input.addEventListener('input', async () => {
    if (await slashCheck(input)) return
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
// Inhaltsgruppen nach Slug-Prefix — jede Seite landet in GENAU einer Gruppe
// (erste Übereinstimmung gewinnt; "Weitere" fängt unbekannte Prefixe auf).
// Ordner = erstes Slug-Segment. Bekannte Crawl-Prefixe bekommen sprechende Labels,
// alles andere ist ein nutzerdefinierter Ordner (entsteht einfach durch Benutzung).
const KNOWN_GROUPS = {
  '': { label: 'Unternehmen & eigene Seiten' },
  'product-docs': { label: 'Enneo Produkt-Doku', sub: 'importiert aus docs.enneo.ai' },
  'api-docs': { label: 'Enneo API-Referenz', sub: 'importiert aus docs.enneo.ai/api-reference' },
  'enneo-api': { label: 'Enneo-API-Rezepte', sub: 'Rezepte für Enni aus dem Claude-Code-Plugin' },
  'marketing-site': { label: 'enneo.ai Website', sub: 'importiert aus enneo.ai' },
  'import': { label: 'Importierte Seiten', sub: 'per URL importiert' },
}
const folderLabel = (prefix) =>
  KNOWN_GROUPS[prefix]?.label || prefix.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())

function groupPages(pages) {
  const map = new Map()
  for (const p of pages) {
    const prefix = p.slug.includes('/') ? p.slug.split('/')[0] : ''
    if (!map.has(prefix))
      map.set(prefix, { prefix, label: folderLabel(prefix), sub: KNOWN_GROUPS[prefix]?.sub, pages: [] })
    map.get(prefix).pages.push(p)
  }
  return [...map.values()].sort((a, b) =>
    a.prefix === '' ? -1 : b.prefix === '' ? 1 : a.label.localeCompare(b.label)
  )
}

// Vorhandene Ordner eines Space
function spaceFolderPrefixes(spaceId) {
  return [...new Set(
    (wikiPages || [])
      .filter((p) => p.space_id === spaceId && p.slug.includes('/'))
      .map((p) => p.slug.split('/')[0])
  )].sort()
}

const NEW_FOLDER = '__new__'

function configureFolderPicker(prefix, selected = '', { allowRoot = true, ensure = [], disabled = false } = {}) {
  const select = $(`${prefix}-folder`)
  const folders = [...new Set([
    ...ensure,
    ...spaceFolderPrefixes(currentSpace?.id),
    selected,
  ].filter(Boolean))].sort((a, b) => folderLabel(a).localeCompare(folderLabel(b)))
  select.innerHTML = [
    ...(allowRoot ? ['<option value="">Ohne Ordner</option>'] : []),
    ...folders.map((folder) => `<option value="${esc(folder)}">${esc(folderLabel(folder))}</option>`),
    `<option value="${NEW_FOLDER}">＋ Neuen Ordner hinzufügen …</option>`,
  ].join('')
  select.value = selected || (allowRoot ? '' : ensure[0] || folders[0] || NEW_FOLDER)
  select.disabled = disabled
  $(`${prefix}-folder-new`).value = ''
  $(`${prefix}-folder-new-row`).hidden = true
}

function syncFolderPicker(prefix) {
  const isNew = $(`${prefix}-folder`).value === NEW_FOLDER
  $(`${prefix}-folder-new-row`).hidden = !isNew
  if (isNew) setTimeout(() => $(`${prefix}-folder-new`).focus(), 0)
}

function folderPickerValue(prefix) {
  return $(`${prefix}-folder`).value === NEW_FOLDER
    ? $(`${prefix}-folder-new`).value.trim()
    : $(`${prefix}-folder`).value
}

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
  const tree = $('space-tree')
  tree.innerHTML = ''

  // Eine Liste für alle Spaces — Restricted trägt nur das Lock, keine eigene Sektion
  for (const s of spacesList) {
    const isOpen = expanded.has(s.id)
    const row = treeItem({ chev: true, label: s.name, lock: s.restricted })
    row.dataset.space = s.id
    row.classList.toggle('on', activeArea === 'wiki' && SPACE_NAV_VIEWS.has(activeView) && currentSpace?.id === s.id)
    if (isOpen) row.classList.add('open')
    row.addEventListener('click', () => {
      expanded.add(s.id)
      renderSpaceTree()
      openSpaceHome(s) // Klick auf den Space öffnet die Übersicht
    })
    row.querySelector('.tree-chev')?.addEventListener('click', (e) => {
      e.stopPropagation() // Chevron klappt nur auf/zu, ohne Navigation
      isOpen ? expanded.delete(s.id) : expanded.add(s.id)
      renderSpaceTree()
    })
    tree.appendChild(row)
    if (!isOpen) continue

    const kids = document.createElement('div')
    kids.className = 'tree-kids'
    const spacePages = (wikiPages || []).filter((p) => p.space_id === s.id)
    for (const g of groupPages(spacePages)) {
      const item = treeItem({ label: `${g.label} · ${g.pages.length}` })
      item.addEventListener('click', () => openPagelist(s, g.label, g.pages, g.prefix))
      kids.appendChild(item)
    }
    if (!spacePages.length)
      kids.insertAdjacentHTML('beforeend', '<div class="sb-item" style="cursor:default;color:var(--ink-3)"><span class="txt">Noch keine Seiten</span></div>')
    tree.appendChild(kids)
  }
}

// ---------- Space-Übersicht (Hauptfläche): Suche, Inhalte, Quellen
function setSpaceHomeTab(tab) {
  const sources = tab === 'sources'
  $('sh-tab-content').classList.toggle('on', !sources)
  $('sh-tab-sources').classList.toggle('on', sources)
  $('sh-content-pane').hidden = sources
  $('sh-sources-pane').hidden = !sources
}

function spacePageRow(page) {
  const row = document.createElement('button')
  row.className = 'space-page-row'
  row.innerHTML = `<div class="space-page-main"><div class="space-page-name">${esc(pageLabel(page))}</div><div class="space-page-sub">${esc(page.slug)}</div></div>
    <svg class="space-page-arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>`
  row.addEventListener('click', () => openWikiPage(page.slug))
  return row
}

function openSpaceHome(space) {
  currentSpace = space
  // Kleines Lock inline — LOCK_SVG ist nur für Sidebar-Items gestylt (sonst riesig/schwarz)
  const miniLock = '<svg viewBox="0 0 24 24" style="width:18px;height:18px;stroke:var(--ink-3);fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;vertical-align:-2px;margin-left:6px"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'
  $('sh-title').innerHTML = esc(space.name) + (space.restricted ? miniLock : '')
  const spacePages = (wikiPages || []).filter((p) => p.space_id === space.id)
  $('sh-sub').textContent = space.restricted ? 'Privater Wissensraum für ausgewählte Mitglieder' : 'Gemeinsamer Wissensraum für Enni'
  $('sh-page-count').textContent = spacePages.length
  $('sh-source-count').textContent = space.connections.length
  $('sh-search').value = ''
  $('sh-results-panel').hidden = true
  $('sh-main').hidden = false
  setSpaceHomeTab('content')
  renderSpaceTree()

  const groupsBox = $('sh-groups')
  groupsBox.innerHTML = ''
  const groups = groupPages(spacePages)
  $('sh-folder-count').textContent = `${groups.length} ${groups.length === 1 ? 'Bereich' : 'Bereiche'}`
  for (const g of groups) {
    const row = document.createElement('button')
    row.className = 'space-folder'
    row.innerHTML = `<span class="space-folder-icon"><svg viewBox="0 0 24 24"><path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.2 3.9A2 2 0 0 0 7.5 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/></svg></span>
      <span class="space-folder-copy"><span class="space-folder-name">${esc(g.label)}</span><span class="space-folder-sub">${g.pages.length} Seiten${g.sub ? ' · ' + esc(g.sub) : ''}</span></span>
      <svg class="space-folder-arrow" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>`
    row.addEventListener('click', () => openPagelist(space, g.label, g.pages, g.prefix))
    groupsBox.appendChild(row)
  }
  if (!groupsBox.children.length)
    groupsBox.innerHTML = '<div class="space-empty">Noch keine Inhalte — erstelle eine Seite oder importiere eine URL.</div>'

  // Quellen (ehem. "Connected Data") kompakt in der Übersicht
  const srcBox = $('sh-sources')
  srcBox.innerHTML = ''
  if (!space.connections.length) {
    srcBox.innerHTML = '<div class="space-empty">Noch keine Quellen verbunden.</div>'
  }
  for (const key of space.connections) {
    const c = CONNECTIONS[key] || { name: key, sub: '' }
    srcBox.insertAdjacentHTML('beforeend',
      `<div class="crow">${c.logo ? `<span class="c-logo"><img src="${c.logo}" alt=""></span>` : ''}<div><div class="c-name">${esc(c.name)}</div><div class="c-sub">${esc(c.sub)}</div></div><span class="c-right ok"><span class="dot-s"></span>Aktiv</span></div>`)
  }
  activateArea('wiki', 'space-home')
}
$('sh-tab-content').addEventListener('click', () => setSpaceHomeTab('content'))
$('sh-tab-sources').addEventListener('click', () => setSpaceHomeTab('sources'))
$('sh-src-edit').addEventListener('click', () => { if (currentSpace) openConnectedData(currentSpace) })

// Live-Suche über ALLE Seiten des Space (Titel + Slug)
$('sh-search').addEventListener('input', () => {
  const q = $('sh-search').value.trim().toLowerCase()
  const panel = $('sh-results-panel')
  if (!q || !currentSpace) {
    panel.hidden = true
    $('sh-main').hidden = false
    return
  }
  const hits = (wikiPages || [])
    .filter((p) => p.space_id === currentSpace.id)
    .filter((p) => (pageLabel(p) + ' ' + p.slug).toLowerCase().includes(q))
    .slice(0, 25)
  panel.hidden = false
  $('sh-main').hidden = true
  const box = $('sh-results')
  box.innerHTML = hits.length ? '' : '<div class="space-empty">Keine Treffer.</div>'
  for (const p of hits) box.appendChild(spacePageRow(p))
})
$('sh-new-page').addEventListener('click', () => openPageEditor(null, ''))
$('pl-new-page').addEventListener('click', () => openPageEditor(null, currentFolderPrefix))

// ---------- Seite per URL importieren (Crawl → Markdown → Auto-Reindex)
function openImportModal(folderPrefix = '') {
  $('iu-url').value = ''
  configureFolderPicker('iu', folderPrefix || 'import', { allowRoot: false, ensure: ['import'] })
  $('iu-err').textContent = ''
  $('iu-overlay').classList.add('open')
  setTimeout(() => $('iu-url').focus(), 50)
}
$('sh-import-url').addEventListener('click', () => openImportModal(''))
$('pl-import-url').addEventListener('click', () => openImportModal(currentFolderPrefix))
$('iu-folder').addEventListener('change', () => syncFolderPicker('iu'))
$('iu-cancel').addEventListener('click', () => $('iu-overlay').classList.remove('open'))
$('iu-save').addEventListener('click', async () => {
  const err = $('iu-err')
  err.textContent = ''
  const url = $('iu-url').value.trim()
  if (!/^https?:\/\/.+\..+/.test(url)) { err.textContent = 'Bitte eine vollständige URL eingeben.'; return }
  if ($('iu-folder').value === NEW_FOLDER && !folderPickerValue('iu')) { err.textContent = 'Bitte den neuen Ordner benennen.'; $('iu-folder-new').focus(); return }
  $('iu-save').disabled = true
  $('iu-save').textContent = 'Importiert …'
  try {
    const res = await fetch(`${BACKEND_URL}/api/wiki/import-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ url, space_id: currentSpace?.id || null, folder: slugify2(folderPickerValue('iu')) || undefined }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    $('iu-overlay').classList.remove('open')
    wikiPages = null
    await loadSpacesTree()
    openWikiPage(data.slug)
  } catch (e) {
    err.textContent = 'Fehler: ' + e.message
  }
  $('iu-save').disabled = false
  $('iu-save').textContent = 'Importieren'
})

// ---------- Connected Data eines Space
function openConnectedData(space) {
  currentSpace = space
  $('cd-space-name').textContent = space.name
  const list = $('cd-list')
  list.innerHTML = ''
  if (!space.connections.length) {
    list.innerHTML = '<div class="space-empty">Noch keine Quellen verbunden.</div>'
  }
  for (const key of space.connections) {
    const c = CONNECTIONS[key] || { name: key, sub: '' }
    list.insertAdjacentHTML('beforeend',
      `<div class="crow">${c.logo ? `<span class="c-logo"><img src="${c.logo}" alt=""></span>` : ''}<div><div class="c-name">${esc(c.name)}</div><div class="c-sub">${esc(c.sub)}</div></div><span class="c-right ok"><span class="dot-s"></span>Aktiv</span></div>`)
  }
  activateArea('wiki', 'connected')
}
$('cd-back').addEventListener('click', () => { if (currentSpace) openSpaceHome(currentSpace) })

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

// ---------- Seiten-Liste (ein Ordner eines Space)
let plPages = []
let currentFolderPrefix = '' // Ordner-Kontext für "+ Neue Seite" aus einer Liste heraus
function openPagelist(space, label, pages, prefix = '') {
  currentSpace = space
  plPages = pages
  currentFolderPrefix = prefix
  $('pl-crumb').textContent = space.name
  $('pl-title').textContent = label
  $('pl-sub').textContent = pages.length ? `${pages.length} Seiten` : 'Noch keine Inhalte.'
  $('pl-filter').value = ''
  renderPagelist('')
  activateArea('wiki', 'pagelist')
}
$('pl-back').addEventListener('click', () => { if (currentSpace) openSpaceHome(currentSpace) })

function renderPagelist(filter) {
  const list = $('pl-list')
  list.innerHTML = ''
  let shown = 0
  for (const p of plPages) {
    if (filter && !(pageLabel(p) + ' ' + p.slug).toLowerCase().includes(filter)) continue
    list.appendChild(spacePageRow(p))
    shown++
  }
  if (!shown) list.innerHTML = `<div class="space-empty">${filter ? 'Keine Treffer.' : 'Noch keine Seiten.'}</div>`
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
$('new-space').addEventListener('click', () => openSpaceModal(false))
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
let currentPage = null
async function openWikiPage(slug) {
  const { data } = await sb.from('wiki_pages').select('*').eq('slug', slug).maybeSingle()
  if (!data) return
  currentPage = data
  currentSpace = spacesList.find((s) => s.id === data.space_id) || currentSpace
  $('doc-crumb').textContent = (currentSpace?.name || 'Company Data') + ' / ' + data.slug
  $('doc-title').textContent = pageLabel(data)
  $('doc-body').innerHTML = md(data.content.replace(/^#\s+.+\n/, ''))
  enhanceCode($('doc-body'))
  $('doc-edit').hidden = false
  activateArea('wiki')
  window.scrollTo({ top: 0 })
}
$('doc-edit').addEventListener('click', () => { if (currentPage) openPageEditor(currentPage) })
$('doc-back').addEventListener('click', () => { if (currentSpace) openSpaceHome(currentSpace) })

// ---------- Seiten-Editor (neu anlegen + bearbeiten) — nach dem Speichern wird die
// Seite automatisch für Ennis Suche neu indexiert (Backend re-embedded die Chunks).
let editingPage = null // null = neue Seite
const slugify2 = (t) => t.toLowerCase().replace(/ä/g,'ae').replace(/ö/g,'oe').replace(/ü/g,'ue').replace(/ß/g,'ss').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80)

async function openPageEditor(page, folderPrefix = '') {
  editingPage = page
  $('pe-crumb').textContent = currentSpace?.name || 'Space'
  $('pe-heading').textContent = page ? 'Seite bearbeiten' : 'Neue Seite'
  $('pe-title').value = page ? page.title : ''
  $('pe-title').disabled = false
  // Ordner: bei bestehender Seite fix (Slug ändert sich nicht), bei neuer Seite frei
  // wählbar — vorbefüllt mit dem Ordner, aus dem heraus man "Neue Seite" geklickt hat
  configureFolderPicker('pe', page ? (page.slug.includes('/') ? page.slug.split('/')[0] : '') : folderPrefix, { allowRoot: true, disabled: !!page })
  $('pe-slug').textContent = page ? page.slug : ''
  $('pe-content').value = page ? page.content : ''
  $('pe-preview').hidden = true
  $('pe-content').hidden = false
  $('pe-preview-btn').textContent = 'Vorschau'
  $('pe-err').textContent = ''
  const { is_admin } = await ownProfile()
  $('pe-delete').hidden = !(page && is_admin)
  activateArea('wiki', 'page-edit')
  setTimeout(() => (page ? $('pe-content') : $('pe-title')).focus(), 50)
}

function updateSlugPreview() {
  if (editingPage) return
  const folder = slugify2(folderPickerValue('pe'))
  const title = slugify2($('pe-title').value)
  $('pe-slug').textContent = title ? (folder ? `${folder}/${title}` : title) : ''
}
$('pe-title').addEventListener('input', updateSlugPreview)
$('pe-folder').addEventListener('change', () => { syncFolderPicker('pe'); updateSlugPreview() })
$('pe-folder-new').addEventListener('input', updateSlugPreview)
$('pe-preview-btn').addEventListener('click', () => {
  const showPreview = $('pe-preview').hidden
  $('pe-preview').hidden = !showPreview
  $('pe-content').hidden = showPreview
  $('pe-preview-btn').textContent = showPreview ? 'Bearbeiten' : 'Vorschau'
  if (showPreview) $('pe-preview').innerHTML = md($('pe-content').value)
})
$('pe-cancel').addEventListener('click', () => {
  if (editingPage) openWikiPage(editingPage.slug)
  else if (currentSpace) openSpaceHome(currentSpace)
})
$('pe-back').addEventListener('click', () => $('pe-cancel').click())

async function reindexWikiPage(slug) {
  const res = await fetch(`${BACKEND_URL}/api/wiki/reindex`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
    body: JSON.stringify({ slug }),
  })
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Re-Index fehlgeschlagen')
}

$('pe-save').addEventListener('click', async () => {
  const err = $('pe-err')
  err.textContent = ''
  const title = $('pe-title').value.trim()
  const content = $('pe-content').value
  if (!title) { err.textContent = 'Titel fehlt.'; return }
  if (!content.trim()) { err.textContent = 'Inhalt fehlt.'; return }
  if (!editingPage && $('pe-folder').value === NEW_FOLDER && !folderPickerValue('pe')) { err.textContent = 'Bitte den neuen Ordner benennen.'; $('pe-folder-new').focus(); return }
  $('pe-save').disabled = true
  $('pe-save').textContent = 'Speichert …'
  try {
    let slug
    if (editingPage) {
      slug = editingPage.slug
      const { error } = await sb.from('wiki_pages').update({ title, content, updated_by: session.user.id }).eq('id', editingPage.id)
      if (error) throw new Error(error.message)
    } else {
      const folder = slugify2(folderPickerValue('pe'))
      const titleSlug = slugify2(title)
      slug = folder ? `${folder}/${titleSlug}` : titleSlug
      if (!titleSlug) throw new Error('Aus dem Titel lässt sich kein Slug bilden.')
      const { error } = await sb.from('wiki_pages').insert({
        slug, title, content,
        space_id: currentSpace?.id || null,
        created_by: session.user.id,
        updated_by: session.user.id,
      })
      if (error) throw new Error(error.code === '23505' ? `Es gibt schon eine Seite mit dem Slug "${slug}".` : error.message)
    }
    await reindexWikiPage(slug) // Ennis RAG sofort aktuell halten
    wikiPages = null // Seiten-Cache invalidieren
    await loadSpacesTree()
    openWikiPage(slug)
  } catch (e) {
    err.textContent = 'Fehler: ' + e.message
  }
  $('pe-save').disabled = false
  $('pe-save').textContent = 'Speichern'
})

$('pe-delete').addEventListener('click', async () => {
  if (!editingPage) return
  if (!window.confirm(`Seite "${editingPage.title}" endgültig löschen? Sie verschwindet auch aus Ennis Wissen.`)) return
  try {
    const res = await fetch(`${BACKEND_URL}/api/wiki/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ slug: editingPage.slug }),
    })
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`)
    wikiPages = null
    await loadSpacesTree()
    if (currentSpace) openSpaceHome(spacesList.find((s) => s.id === currentSpace.id) || currentSpace)
  } catch (e) {
    $('pe-err').textContent = 'Fehler: ' + e.message
  }
})

// ============================================================ Mitglieder (Admin)
async function loadMembers() {
  const [{ data }, { is_admin }] = await Promise.all([
    sb.from('profiles').select('email, display_name, is_admin, role_title').order('created_at'),
    ownProfile(),
  ])
  $('invite-box').hidden = !is_admin
  const list = $('member-list')
  list.innerHTML = ''
  $('member-count').textContent = `${(data || []).length} Accounts`
  for (const m of data || []) {
    const row = document.createElement('div')
    row.className = 'row'
    row.innerHTML = `<div><div class="r-name">${esc(m.display_name || m.email)}</div><div class="r-sub">${esc(m.email)}${m.role_title ? ' · ' + esc(m.role_title) : ''}</div></div>
      <div></div><span class="role${m.is_admin ? ' admin' : ''}">${m.is_admin ? 'Admin' : 'Member'}</span>`
    list.appendChild(row)
  }
}

// Mitglied einladen (Admin): Backend erzeugt Invite-/Login-Link zum Weitergeben
async function createInvite() {
  const email = $('inv-email').value.trim()
  $('inv-err').textContent = ''
  $('inv-result').hidden = true
  if (!email) return
  $('inv-create').disabled = true
  try {
    const res = await fetch(`${BACKEND_URL}/api/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ email }),
    })
    const data = await res.json()
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    $('inv-link').textContent = data.link
    $('inv-result').hidden = false
    $('inv-copy').textContent = data.existing ? 'Login-Link kopieren' : 'Einladungslink kopieren'
    $('inv-email').value = ''
    loadMembers()
  } catch (err) {
    $('inv-err').textContent = err.message
  }
  $('inv-create').disabled = false
}
$('inv-create').addEventListener('click', createInvite)
$('inv-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') createInvite() })
$('inv-copy').addEventListener('click', async () => {
  if (await copyText($('inv-link').textContent)) {
    $('inv-copy').textContent = 'Kopiert ✓'
    setTimeout(() => ($('inv-copy').textContent = 'Kopieren'), 1600)
  }
})

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

// Modell-Wahl: Sonnet 5 ist Default bei jedem Chat-Start. Der sichtbare Glass-Picker
// schreibt weiterhin in das versteckte Select, das der bestehende Send-Flow liest.
const MODEL_LABELS = {
  'claude-sonnet-5': 'Sonnet 5',
  'claude-fable-5': 'Fabel 5',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-haiku-4-5': 'Haiku 4.5',
}

function setModel(model) {
  if (!MODEL_LABELS[model]) return
  $('model-select').value = model
  $('model-current').textContent = MODEL_LABELS[model]
  $('model-current-flame').hidden = model !== 'claude-fable-5'
  document.querySelectorAll('#model-menu [data-model]').forEach((option) => {
    option.setAttribute('aria-selected', String(option.dataset.model === model))
  })
}

function closeModelMenu() {
  $('model-menu').hidden = true
  $('model-trigger').setAttribute('aria-expanded', 'false')
}

function openModelMenu() {
  $('model-menu').hidden = false
  $('model-trigger').setAttribute('aria-expanded', 'true')
}

$('model-trigger').addEventListener('click', (event) => {
  event.stopPropagation()
  if ($('model-menu').hidden) openModelMenu()
  else closeModelMenu()
})
document.querySelectorAll('#model-menu [data-model]').forEach((option) => {
  option.addEventListener('click', () => {
    setModel(option.dataset.model)
    closeModelMenu()
    $('model-trigger').focus()
  })
})
$('model-picker').addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModelMenu()
    $('model-trigger').focus()
  } else if (event.key === 'ArrowDown' && document.activeElement === $('model-trigger')) {
    event.preventDefault()
    openModelMenu()
  }
})
document.addEventListener('click', (event) => {
  if (!event.target.closest('#model-picker')) closeModelMenu()
})
setModel('claude-sonnet-5')

// ============================================================ Connectors (MCP-Server verknüpfen)
let cnCategory = 'tool'

// Teilen-Antrag eines eigenen Tools (personal → proposed, Admin entscheidet)
async function shareConnector(id) {
  const res = await fetch(`${BACKEND_URL}/api/connectors/${id}/share`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}` },
  })
  if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error || 'Fehler'); return }
  loadConnectorRows()
}

const connScopeBadge = (c, me) => {
  if (c.visibility === 'team') return ''
  if (c.visibility === 'proposed') return '<span class="sk-badge prop">Team-weit vorgeschlagen</span>'
  return c.owner === me ? '<span class="sk-badge">Persönlich</span>' : ''
}

async function loadConnectorRows() {
  const { data } = await sb
    .from('connectors')
    .select('id, name, url, category, tool_count, kind, owner, visibility, auth_type, external_account_name')
    .order('created_at')
  const { is_admin } = await ownProfile()
  const me = session.user.id
  // Sichtbar: team-weite + eigene (personal/proposed)
  const visible = (data || []).filter((c) => c.visibility === 'team' || c.owner === me)
  for (const kind of Object.keys(NATIVE_CONNECTORS)) {
    // Eigener persönlicher Connector hat Vorrang vor dem Team-Connector (wie im Tool-Loop)
    const rows = visible.filter((x) => x.kind === kind)
    const conn = rows.find((x) => x.owner === me && x.visibility !== 'team') || rows.find((x) => x.visibility === 'team') || null
    renderNativeRow(kind, conn, is_admin, me)
  }
  {
    const box = $('dyn-tools')
    if (!box) return
    box.innerHTML = ''
    for (const c of visible.filter((x) => x.kind === 'mcp')) {
      const mine = c.owner === me
      const row = document.createElement('div')
      row.className = 'crow'
      row.innerHTML = `<span class="c-logo" style="background:none;border-style:dashed"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:var(--lila-deep);fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg></span>
        <div><div class="c-name">${esc(c.name)}</div><div class="c-sub">${esc(new URL(c.url).hostname)} · ${c.tool_count ?? '?'} Tools · MCP</div></div>
        ${connScopeBadge(c, me)}
        ${mine && c.visibility === 'personal' ? '<button class="btn quiet c-share" style="padding:4px 12px;font-size:11.5px" title="Team-weite Nutzung beantragen — der Admin entscheidet">Teilen</button>' : ''}
        <span class="c-right ok"><span class="dot-s"></span>Verbunden</span>` +
        (is_admin || mine ? '<button class="c-del" title="Trennen"><svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>' : '')
      row.querySelector('.c-share')?.addEventListener('click', () => shareConnector(c.id))
      row.querySelector('.c-del')?.addEventListener('click', async () => {
        if (!window.confirm(`"${c.name}" trennen? Enni verliert sofort den Zugriff auf diese Tools.`)) return
        const res = await fetch(`${BACKEND_URL}/api/connectors/${c.id}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${await token()}` },
        })
        if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error || 'Fehler'); return }
        toolCatalogCache = null
        loadConnectorRows()
      })
      box.appendChild(row)
    }
  }
}

// Native Connectors (Attio, Slack): Status live, Klick öffnet das Key-Modal (Admin),
// Trennen über ✕. Ein Config-Eintrag pro Dienst — keine Code-Kopien.
const NATIVE_CONNECTORS = {
  attio: {
    row: 'attio-row', status: 'attio-status', sub: 'attio-sub',
    overlay: 'attio-overlay', input: 'at-token', err: 'at-err', save: 'at-save', cancel: 'at-cancel',
    subConnected: 'CRM: Accounts, Kontakte, Deals, Notizen · read-only',
    subDefault: 'CRM-Daten · read-only',
    confirmMsg: 'Attio trennen? Enni verliert sofort den CRM-Zugriff.',
    missingMsg: 'API-Key fehlt.',
  },
  slack: {
    row: 'slack-row', status: 'slack-status', sub: 'slack-sub',
    auth: 'oauth',
    subConnected: 'Channels lesen: öffentlich automatisch, privat nach Bot-Einladung',
    subDefault: 'Channels und Threads · read-only · sicherer Slack-Login',
    confirmMsg: 'Slack trennen? Enni verliert sofort den Lesezugriff.',
  },
}
const nativeState = {} // kind -> connector-Row oder null

function showOAuthResult(type, title, detail = '') {
  const box = $('oauth-result')
  box.hidden = false
  box.className = `oauth-result${type === 'error' ? ' error' : ''}`
  const icon = type === 'error'
    ? '<svg viewBox="0 0 24 24"><path d="M12 8v5"/><path d="M12 17h.01"/><circle cx="12" cy="12" r="9"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="m5 12 4 4L19 6"/></svg>'
  box.innerHTML = `<span class="oauth-result-icon">${icon}</span><span><strong>${esc(title)}</strong>${detail ? ` · ${esc(detail)}` : ''}</span>`
}

function handleOAuthReturn() {
  const params = new URLSearchParams(location.search)
  if (params.get('oauth') !== 'slack') return
  if (params.get('status') === 'connected') {
    showOAuthResult('success', 'Slack ist verbunden', params.get('workspace') || 'Enni kann jetzt Channels und Threads lesen.')
  } else {
    const detail = params.get('reason') === 'cancelled'
      ? 'Die Verbindung wurde abgebrochen.'
      : 'Bitte versuche die Verbindung erneut.'
    showOAuthResult('error', 'Slack konnte nicht verbunden werden', detail)
  }
  const clean = new URL(location.href)
  for (const key of ['oauth', 'status', 'workspace', 'reason']) clean.searchParams.delete(key)
  history.replaceState({}, '', clean)
}

async function startSlackOAuth() {
  const status = $('slack-status')
  const previous = status.innerHTML
  status.className = 'c-right off'
  status.innerHTML = '<span class="connector-connect">Öffne Slack …</span>'
  try {
    const { is_admin } = await ownProfile()
    const res = await fetch(`${BACKEND_URL}/api/oauth/slack/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
      body: JSON.stringify({ scope: is_admin ? 'team' : 'personal' }),
    })
    const data = await res.json()
    if (!res.ok || !data.url) throw new Error(data.error || 'OAuth-Start fehlgeschlagen')
    location.assign(data.url)
  } catch (err) {
    status.innerHTML = previous
    showOAuthResult('error', 'Slack ist noch nicht bereit', err.message)
  }
}

function renderNativeRow(kind, conn, isAdmin, me) {
  const cfg = NATIVE_CONNECTORS[kind]
  nativeState[kind] = conn
  const status = $(cfg.status)
  const sub = $(cfg.sub)
  if (!status) return
  if (conn) {
    const mine = conn.owner === me
    const scope = conn.visibility === 'team' ? 'Verbunden' : conn.visibility === 'proposed' ? 'Verbunden · vorgeschlagen' : 'Verbunden · persönlich'
    status.className = 'c-right ok'
    status.innerHTML = `<span class="dot-s"></span>${scope}` +
      (mine && conn.visibility === 'personal' ? `<button class="btn quiet" data-native-share="${kind}" style="padding:3px 10px;font-size:11px;margin-left:8px" title="Team-weite Nutzung beantragen">Teilen</button>` : '') +
      (isAdmin || mine ? `<button class="c-del" data-native-del="${kind}" title="Trennen" style="display:inline-flex;margin-left:8px"><svg viewBox="0 0 24 24"><line x1="5" y1="5" x2="19" y2="19"/><line x1="19" y1="5" x2="5" y2="19"/></svg></button>` : '')
    sub.textContent = kind === 'slack' && conn.external_account_name
      ? `${conn.external_account_name} · ${cfg.subConnected}`
      : cfg.subConnected
    status.querySelector('[data-native-share]')?.addEventListener('click', (e) => {
      e.stopPropagation()
      shareConnector(conn.id)
    })
    status.querySelector('[data-native-del]')?.addEventListener('click', async (e) => {
      e.stopPropagation()
      if (!window.confirm(cfg.confirmMsg)) return
      const res = await fetch(`${BACKEND_URL}/api/connectors/${conn.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${await token()}` },
      })
      if (!res.ok) { window.alert((await res.json().catch(() => ({}))).error || 'Fehler'); return }
      toolCatalogCache = null
      loadConnectorRows()
    })
  } else {
    status.className = 'c-right off'
    status.innerHTML = cfg.auth === 'oauth'
      ? '<span class="connector-connect"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>Verbinden</span>'
      : '<span class="dot-s"></span>Verbinden'
    sub.textContent = cfg.auth === 'oauth' ? cfg.subDefault : `${cfg.subDefault} · Klick zum Verbinden (persönlich; Admin: team-weit)`
  }
}

for (const [kind, cfg] of Object.entries(NATIVE_CONNECTORS)) {
  if (cfg.auth === 'oauth') {
    $(cfg.row).addEventListener('click', () => {
      if (!nativeState[kind]) startSlackOAuth()
    })
    continue
  }
  $(cfg.row).addEventListener('click', async () => {
    if (nativeState[kind]) return // verbunden — Trennen läuft über das ✕ (jeder darf verbinden)
    $(cfg.input).value = ''
    $(cfg.err).textContent = ''
    $(cfg.overlay).classList.add('open')
    setTimeout(() => $(cfg.input).focus(), 50)
  })
  $(cfg.cancel).addEventListener('click', () => $(cfg.overlay).classList.remove('open'))
  $(cfg.save).addEventListener('click', async () => {
    const err = $(cfg.err)
    err.textContent = ''
    if (!$(cfg.input).value.trim()) { err.textContent = cfg.missingMsg; return }
    $(cfg.save).disabled = true
    $(cfg.save).textContent = 'Verbinde …'
    try {
      const res = await fetch(`${BACKEND_URL}/api/connectors`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token()}` },
        body: JSON.stringify({ kind, token: $(cfg.input).value.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
      $(cfg.overlay).classList.remove('open')
      toolCatalogCache = null
      loadConnectorRows()
    } catch (e) {
      err.textContent = e.message
    }
    $(cfg.save).disabled = false
    $(cfg.save).textContent = 'Verbinden'
  })
}

document.querySelectorAll('[data-category]').forEach((b) =>
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
    toolCatalogCache = null
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
let skillListCache = [] // zuletzt geladene Skills (für die clientseitige Suche)
let skillListAdmin = false
let skillListProfs = []

async function loadSkills() {
  const [{ data: skills }, { is_admin }, profs] = await Promise.all([
    sb.from('skills').select('*').order('name'),
    ownProfile(),
    allProfiles(),
  ])
  $('skill-add').hidden = false // jeder darf Skills bauen (persönlich; team-weit schaltet der Admin frei)
  skillListCache = skills || []
  skillListAdmin = is_admin
  skillListProfs = profs
  // Kategorien-Datalist für den Editor
  const cats = [...new Set(skillListCache.map((s) => s.category || 'Allgemein'))]
    .sort((a, b) => (a === 'Meta') - (b === 'Meta') || a.localeCompare(b, 'de'))
  $('sk-cat-list').innerHTML = cats.map((c) => `<option value="${esc(c)}">`).join('')
  renderSkillList($('skill-search')?.value || '')
}

function renderSkillList(filter = '') {
  const list = $('skill-list')
  list.innerHTML = ''
  if (!skillListCache.length) {
    list.innerHTML = '<div class="empty-plain">Noch keine Skills definiert.</div>'
    return
  }
  const q = filter.trim().toLowerCase()
  const matches = skillListCache.filter(
    (s) => !q || s.name.toLowerCase().includes(q) || s.slug.includes(q) || (s.category || '').toLowerCase().includes(q)
  )
  if (!matches.length) {
    list.innerHTML = `<div class="empty-plain">Keine Skills für „${esc(filter)}".</div>`
    return
  }
  // Nach Kategorie gruppieren ("Meta" ans Ende)
  const groups = new Map()
  for (const s of matches) {
    const c = s.category || 'Allgemein'
    if (!groups.has(c)) groups.set(c, [])
    groups.get(c).push(s)
  }
  const cats = [...groups.keys()].sort((a, b) => (a === 'Meta') - (b === 'Meta') || a.localeCompare(b, 'de'))
  for (const cat of cats) {
    list.insertAdjacentHTML('beforeend', `<div class="skill-cat">${esc(cat)}</div>`)
    for (const s of groups.get(cat)) {
      const row = document.createElement('button')
      row.className = 'crow'
      const vis = s.visibility === 'personal'
        ? '<span class="sk-badge">Persönlich</span>'
        : s.visibility === 'proposed'
          ? `<span class="sk-badge prop">Vorgeschlagen${skillListAdmin ? ' von ' + esc(profName(skillListProfs, s.created_by)) : ''}</span>`
          : ''
      row.innerHTML = `<span class="c-logo" style="background:none;border-style:dashed"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:var(--lila-deep);fill:none;stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg></span>
        <div><div class="c-name">${esc(s.name)}</div><div class="c-sub">/${esc(s.slug)}${s.tools?.length ? ` · ${s.tools.length} Tools` : ''} · ${esc((s.context || '').split('\n')[0].slice(0, 80))}</div></div>
        ${vis}<span class="c-right ${s.enabled ? 'ok' : 'off'}"><span class="dot-s"></span>${s.enabled ? 'Aktiv' : 'Aus'}</span>`
      row.addEventListener('click', () => openSkill(s, skillListAdmin))
      list.appendChild(row)
    }
  }
}
$('skill-search').addEventListener('input', () => renderSkillList($('skill-search').value))

// ============================================================ Workflow-Diagramm
// EINE einheitliche Visualisierung für alle Skill-Workflows: der Text (nummerierte
// Schritte) bleibt Source of Truth, das Diagramm ist eine generierte Read-only-Ansicht.
function parseWorkflowSteps(text) {
  const steps = []
  let current = null
  for (const line of (text || '').split('\n')) {
    const m = line.match(/^\s*(\d+)[.)]\s+(.*)$/)
    if (m) {
      if (current) steps.push(current)
      current = { num: m[1], text: m[2] }
    } else if (current && line.trim()) {
      current.text += ' ' + line.trim()
    }
  }
  if (current) steps.push(current)
  return steps
}

const TOOL_NAME_RE = /\b((?:wiki|attio|slack|enneo|gitlab|google_drive|notion|outlook|pod|skill|dashboard)_[a-z0-9_]+|mcp__[a-zA-Z0-9_]+|create_file|request_tool_connection)\b/g

const SKILL_TOOL_SERVICES = [
  { prefix: 'google_drive_', label: 'Google Drive', icon: './icons/google-drive.svg' },
  { prefix: 'wiki_', label: 'Wiki', icon: './icons/enni.png' },
  { prefix: 'enneo_', label: 'Enneo', icon: './icons/enneo-icon.svg' },
  { prefix: 'gitlab_', label: 'GitLab', icon: './icons/gitlab.svg' },
  { prefix: 'attio_', label: 'Attio', icon: './icons/attio.ico' },
  { prefix: 'slack_', label: 'Slack', icon: './icons/slack.svg' },
  { prefix: 'notion_', label: 'Notion', icon: './icons/notion.svg' },
  { prefix: 'outlook_', label: 'Outlook', icon: './icons/outlook.svg' },
  { prefix: 'pod_', label: 'Pods' },
  { prefix: 'skill_', label: 'Skills' },
  { prefix: 'dashboard_', label: 'Dashboard' },
]

let skillToolsEditable = false
let toolCatalogCache = null

const TOOL_ACTION_LABELS = {
  semantic_search: 'Wissen durchsuchen', search: 'Seiten durchsuchen', list_pages: 'Seiten auflisten',
  read_page: 'Seite lesen', write_page: 'Seite bearbeiten', create_page: 'Seite erstellen', propose_update: 'Änderung vorschlagen',
  search_projects: 'Projekte durchsuchen', search_code: 'Code durchsuchen', read_file: 'Datei lesen', list_merge_requests: 'Merge Requests auflisten',
  ticket_search: 'Tickets durchsuchen', ticket_get: 'Ticket öffnen', settings_search: 'Einstellungen durchsuchen', api_get: 'Daten abrufen', api_post: 'Aktion ausführen', propose_write: 'Änderung vorschlagen',
  list_objects: 'Objekte auflisten', query_records: 'Datensätze durchsuchen', get_record: 'Datensatz öffnen', list_notes: 'Notizen auflisten', list_meetings: 'Meetings auflisten', get_transcript: 'Transkript lesen', raw_get: 'Daten abrufen',
  list_channels: 'Channels auflisten', read_channel: 'Channel lesen', read_thread: 'Thread lesen',
  list_tasks: 'Aufgaben auflisten', list_files: 'Dateien auflisten', list_conversations: 'Konversationen auflisten', read_conversation: 'Konversation lesen',
  read: 'Skill lesen', create_draft: 'Skill-Entwurf erstellen',
  list_tickets: 'Tickets auflisten', get_ticket: 'Ticket öffnen', search_tickets: 'Tickets durchsuchen', send_message: 'Nachricht senden',
  create_file: 'Datei erstellen', request_tool_connection: 'Verbindung anfragen',
}

function humanToolAction(action) {
  if (TOOL_ACTION_LABELS[action]) return TOOL_ACTION_LABELS[action]
  const parts = action.split('_').filter(Boolean)
  const verbs = { read: 'lesen', get: 'abrufen', list: 'auflisten', search: 'durchsuchen', create: 'erstellen', update: 'aktualisieren', delete: 'löschen', send: 'senden', write: 'bearbeiten', add: 'hinzufügen' }
  const nouns = { page: 'Seite', pages: 'Seiten', ticket: 'Ticket', tickets: 'Tickets', customer: 'Kunde', customers: 'Kunden', message: 'Nachricht', messages: 'Nachrichten', file: 'Datei', files: 'Dateien', code: 'Code', data: 'Daten', user: 'Nutzer', users: 'Nutzer', project: 'Projekt', projects: 'Projekte', api: 'API' }
  const first = parts[0]
  if (verbs[first] && parts.length > 1) {
    const subject = parts.slice(1).map((p) => nouns[p] || p).join(' ')
    return subject.charAt(0).toUpperCase() + subject.slice(1) + ' ' + verbs[first]
  }
  const words = parts.map((p) => nouns[p] || verbs[p] || p)
  const label = words.join(' ')
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : 'Tool verwenden'
}

function skillToolInfo(tool) {
  if (tool.startsWith('mcp__')) {
    const [, server = 'MCP', ...action] = tool.split('__')
    const label = server.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
    return { label, action: humanToolAction(action.join('_')), icon: null }
  }
  if (tool === 'create_file') return { label: 'Dateien', action: TOOL_ACTION_LABELS.create_file, icon: null }
  if (tool === 'request_tool_connection') return { label: 'Connections', action: TOOL_ACTION_LABELS.request_tool_connection, icon: null }
  const service = SKILL_TOOL_SERVICES.find((item) => tool.startsWith(item.prefix))
  if (!service) return { label: 'Tool', action: humanToolAction(tool), icon: null }
  return { ...service, action: humanToolAction(tool.slice(service.prefix.length)) }
}

function skillToolLogoMarkup(info) {
  const wikiClass = info.label === 'Wiki' ? ' wiki' : ''
  const logo = info.icon
    ? `<img src="${info.icon}" alt="${esc(info.label)}">`
    : '<svg viewBox="0 0 24 24"><path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/></svg>'
  return `<span class="skill-tool-logo${wikiClass}">${logo}</span>`
}

function skillToolMarkup(tool, compact = false, removable = false) {
  const info = skillToolInfo(tool)
  return `<span class="skill-tool-card${compact ? ' compact' : ''}" title="${esc(info.label)} · ${esc(info.action)}">${skillToolLogoMarkup(info)}<span class="skill-tool-copy"><span class="skill-tool-service">${esc(info.label)}</span><span class="skill-tool-action">${esc(info.action)}</span></span>${removable ? `<button type="button" class="skill-tool-remove" data-remove-tool="${esc(tool)}" aria-label="${esc(info.action)} entfernen">×</button>` : ''}</span>`
}

function selectedSkillTools() {
  return $('sk-tools').value.split('\n').map((x) => x.trim()).filter(Boolean)
}

function setSelectedSkillTools(tools) {
  $('sk-tools').value = [...new Set(tools)].join('\n')
  renderSkillTools()
  if (!$('sk-tool-picker').hidden) renderToolPicker($('sk-tool-search').value)
  if (!$('sk-workflow-flow').hidden) renderWorkflowFlow($('sk-workflow-flow'), $('sk-workflow').value, selectedSkillTools())
}

function renderSkillTools() {
  const tools = selectedSkillTools()
  $('sk-tools-visual').innerHTML = tools.length
    ? tools.map((tool) => skillToolMarkup(tool, false, skillToolsEditable)).join('')
    : '<div class="skill-tools-empty">Noch keine Tools mit diesem Skill verbunden.</div>'
  $('sk-tools-visual').querySelectorAll('[data-remove-tool]').forEach((button) => {
    button.addEventListener('click', () => setSelectedSkillTools(tools.filter((tool) => tool !== button.dataset.removeTool)))
  })
}

async function loadToolCatalog() {
  if (toolCatalogCache) return toolCatalogCache
  const res = await fetch(`${BACKEND_URL}/api/tools/catalog`, { headers: { Authorization: `Bearer ${await token()}` } })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || 'Tool-Katalog konnte nicht geladen werden.')
  toolCatalogCache = data.tools || []
  return toolCatalogCache
}

function renderToolPicker(filter = '') {
  const box = $('sk-tool-list')
  const selected = new Set(selectedSkillTools())
  const q = filter.trim().toLowerCase()
  const matches = (toolCatalogCache || []).filter((tool) => {
    const info = skillToolInfo(tool.name)
    return !q || `${info.label} ${info.action} ${tool.description || ''}`.toLowerCase().includes(q)
  })
  if (!matches.length) {
    box.innerHTML = `<div class="skill-tools-empty">${q ? 'Kein passendes verbundenes Tool gefunden.' : 'Keine Tools verfügbar.'}</div>`
    return
  }
  const groups = new Map()
  for (const tool of matches) {
    const info = skillToolInfo(tool.name)
    if (!groups.has(info.label)) groups.set(info.label, [])
    groups.get(info.label).push({ ...tool, info })
  }
  box.innerHTML = [...groups.entries()].map(([label, tools]) => `<section><div class="tool-picker-group">${esc(label)}</div><div class="tool-picker-items">${tools.map((tool) => {
    const on = selected.has(tool.name)
    const description = (tool.description || '').replace(/\s+/g, ' ').slice(0, 90)
    return `<button type="button" class="tool-pick-item${on ? ' on' : ''}" data-tool="${esc(tool.name)}">${skillToolLogoMarkup(tool.info)}<span class="tool-pick-copy"><span class="tool-pick-name">${esc(tool.info.action)}</span><span class="tool-pick-description">${esc(description || tool.info.label)}</span></span><span class="tool-pick-check">${on ? '✓' : ''}</span></button>`
  }).join('')}</div></section>`).join('')
  box.querySelectorAll('[data-tool]').forEach((button) => {
    button.addEventListener('click', () => {
      const tools = selectedSkillTools()
      setSelectedSkillTools(tools.includes(button.dataset.tool) ? tools.filter((tool) => tool !== button.dataset.tool) : [...tools, button.dataset.tool])
    })
  })
}

function renderWorkflowFlow(container, text, toolsList = []) {
  const steps = parseWorkflowSteps(text)
  container.innerHTML = ''
  if (!steps.length) {
    container.innerHTML = '<div class="wf-empty">Kein nummerierter Workflow erkannt — schreibe Schritte als „1. …", „2. …", dann erscheint hier das Diagramm.</div>'
    return
  }
  for (const s of steps) {
    const found = [...new Set([...(s.text.match(TOOL_NAME_RE) || []), ...toolsList.filter((tl) => s.text.includes(tl))])]
    const node = document.createElement('div')
    node.className = 'wf-node'
    node.innerHTML = `<span class="wf-num">${esc(s.num)}</span>
      <div class="wf-body"><div class="wf-text">${esc(s.text.length > 260 ? s.text.slice(0, 260) + ' …' : s.text)}</div>
      ${found.length ? `<div class="wf-chips">${found.map((f) => skillToolMarkup(f, true)).join('')}</div>` : ''}</div>`
    container.appendChild(node)
  }
}

function setWorkflowView(view) {
  document.querySelectorAll('[data-wfview]').forEach((b) => b.classList.toggle('on', b.dataset.wfview === view))
  $('sk-workflow').hidden = view === 'flow'
  $('sk-workflow-flow').hidden = view !== 'flow'
  if (view === 'flow') {
    const tools = $('sk-tools').value.split('\n').map((x) => x.trim()).filter(Boolean)
    renderWorkflowFlow($('sk-workflow-flow'), $('sk-workflow').value, tools)
  }
}
document.querySelectorAll('[data-wfview]').forEach((b) =>
  b.addEventListener('click', () => setWorkflowView(b.dataset.wfview))
)

function openSkill(s, isAdmin) {
  setWorkflowView('text')
  editingSkill = s
  // Bearbeiten dürfen: Admins alles; Mitglieder ihre eigenen persönlichen/vorgeschlagenen Skills
  const isOwner = s && s.created_by === session.user.id && s.visibility !== 'team'
  const canEdit = isAdmin || !s || isOwner
  $('sk-title').textContent = s ? s.name : 'Neuer Skill'
  $('sk-name').value = s?.name || ''
  $('sk-slug').value = s?.slug || ''
  $('sk-category').value = s?.category || ''
  $('sk-visibility').value = s?.visibility || (isAdmin ? 'team' : 'personal')
  $('sk-enabled').checked = s ? s.enabled : true
  $('sk-context').value = s?.context || ''
  $('sk-workflow').value = s?.workflow || ''
  $('sk-tools').value = (s?.tools || []).join('\n')
  skillToolsEditable = canEdit
  renderSkillTools()
  $('sk-triggers').value = s?.triggers || ''
  $('sk-dod').value = s?.definition_of_done || ''
  $('sk-corner').value = s?.corner_cases || ''
  $('sk-err').textContent = ''
  document.querySelectorAll('#skill-overlay input, #skill-overlay textarea, #skill-overlay select').forEach((el) => (el.disabled = !canEdit))
  // "Team-weit" kann nur der Admin setzen — Mitglieder schlagen vor
  $('sk-visibility').querySelector('option[value="team"]').disabled = !isAdmin
  $('sk-save').hidden = !canEdit
  $('sk-delete').hidden = !canEdit || !s
  $('sk-tool-add').hidden = !canEdit
  $('sk-tool-picker').hidden = true
  $('sk-tool-search').value = ''
  $('skill-overlay').classList.add('open')
  if (canEdit) setTimeout(() => $('sk-name').focus(), 50)
}

$('sk-tool-add').addEventListener('click', async () => {
  const picker = $('sk-tool-picker')
  picker.hidden = !picker.hidden
  if (picker.hidden) return
  $('sk-tool-list').innerHTML = '<div class="skill-tools-empty">Tools werden geladen …</div>'
  try {
    await loadToolCatalog()
    renderToolPicker('')
    $('sk-tool-search').focus()
  } catch (err) {
    $('sk-tool-list').innerHTML = `<div class="skill-tools-empty">${esc(err.message)}</div>`
  }
})
$('sk-tool-close').addEventListener('click', () => { $('sk-tool-picker').hidden = true })
$('sk-tool-search').addEventListener('input', () => renderToolPicker($('sk-tool-search').value))

$('skill-add').addEventListener('click', async () => openSkill(null, (await ownProfile()).is_admin))
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
    category: $('sk-category').value.trim() || 'Allgemein',
    visibility: $('sk-visibility').value,
    enabled: $('sk-enabled').checked,
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
  skillsCache = null
  loadSkills()
})

$('sk-delete').addEventListener('click', async () => {
  if (!editingSkill) return
  if (!window.confirm(`Skill "${editingSkill.name}" löschen?`)) return
  const { error } = await sb.from('skills').delete().eq('id', editingSkill.id)
  if (error) { $('sk-err').textContent = 'Fehler: ' + error.message; return }
  $('skill-overlay').classList.remove('open')
  skillsCache = null
  loadSkills()
})

// ============================================================ Routinen (Enni nach Zeitplan)
// Jeder verwaltet eigene Routinen (RLS), Admins sehen alle. Der Ticker läuft im Backend.
let editingRoutine = null

function cronFromForm() {
  const [h, m] = $('rt-time').value.split(':').map(Number)
  const freq = $('rt-freq').value
  const dow = $('rt-dow').value
  const pad = (n) => String(n).padStart(2, '0')
  const time = `${pad(h)}:${pad(m)}`
  if (freq === 'weekdays') return { cron: `${m} ${h} * * 1,2,3,4,5`, label: `Werktags ${time}` }
  if (freq === 'weekly') {
    const names = { 0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa' }
    return { cron: `${m} ${h} * * ${dow}`, label: `Wöchentlich ${names[dow]} ${time}` }
  }
  if (freq === 'monthly') return { cron: `${m} ${h} 1 * *`, label: `Monatlich am 1. um ${time}` }
  return { cron: `${m} ${h} * * *`, label: `Täglich ${time}` }
}

function formFromCron(cron) {
  const [m, h, dom, , dow] = cron.trim().split(/\s+/)
  $('rt-time').value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  if (dom === '1') $('rt-freq').value = 'monthly'
  else if (dow === '1,2,3,4,5') $('rt-freq').value = 'weekdays'
  else if (dow !== '*') { $('rt-freq').value = 'weekly'; $('rt-dow').value = dow }
  else $('rt-freq').value = 'daily'
  $('rt-dow-wrap').hidden = $('rt-freq').value !== 'weekly'
}

$('rt-freq').addEventListener('change', () => { $('rt-dow-wrap').hidden = $('rt-freq').value !== 'weekly' })

async function loadRoutines() {
  const [{ data: routines }, profs] = await Promise.all([
    sb.from('routines').select('*').order('created_at'),
    allProfiles(),
  ])
  const list = $('routine-list')
  list.innerHTML = ''
  if (!(routines || []).length) list.innerHTML = '<div class="empty-plain">Noch keine Routinen.</div>'
  for (const r of routines || []) {
    const pod = podsList.find((p) => p.id === r.pod_id)
    const last = r.last_run_at
      ? ` · zuletzt ${new Date(r.last_run_at).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${r.last_result === 'ok' ? '' : ' ⚠'}`
      : ''
    const row = document.createElement('div')
    row.className = 'crow'
    row.style.cursor = 'pointer'
    row.innerHTML = `<span class="c-logo" style="background:none;border-style:dashed"><svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:var(--lila-deep);fill:none;stroke-width:1.7;stroke-linecap:round"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg></span>
      <div><div class="c-name">${esc(r.name)}</div><div class="c-sub">${esc(r.schedule_label || r.cron)} · ${pod ? `Pod „${esc(pod.name)}“` : 'Privat'} · ${esc(profName(profs, r.created_by))}${last}</div></div>
      <span class="c-right ${r.enabled ? 'ok' : 'off'}"><span class="dot-s"></span>${r.enabled ? 'Aktiv' : 'Aus'}</span>
      <button class="c-del rt-run" title="Jetzt ausführen" style="display:inline-flex"><svg viewBox="0 0 24 24" style="fill:none"><polygon points="6 4 20 12 6 20 6 4"/></svg></button>`
    row.addEventListener('click', (e) => { if (!e.target.closest('.rt-run')) openRoutine(r) })
    row.querySelector('.rt-run').addEventListener('click', async (ev) => {
      const btn = ev.currentTarget
      btn.style.opacity = '.4'
      const res = await fetch(`${BACKEND_URL}/api/routines/${r.id}/run`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await token()}` },
      })
      const data = await res.json().catch(() => ({}))
      btn.style.opacity = ''
      if (!res.ok) { window.alert(data.error || 'Fehler beim Ausführen'); return }
      loadRoutines()
      loadConversations()
    })
    list.appendChild(row)
  }
}

async function openRoutine(r) {
  editingRoutine = r
  $('rt-title').textContent = r ? r.name : 'Neue Routine'
  $('rt-name').value = r?.name || ''
  $('rt-prompt').value = r?.prompt || ''
  $('rt-model').value = r?.model || 'claude-haiku-4-5'
  $('rt-enabled').checked = r ? r.enabled : true
  const podSel = $('rt-pod')
  podSel.innerHTML = '<option value="">Privat (nur ich)</option>' +
    podsList.map((p) => `<option value="${p.id}">Pod: ${esc(p.name)}</option>`).join('')
  podSel.value = r?.pod_id || ''
  if (r?.cron) formFromCron(r.cron)
  else { $('rt-freq').value = 'daily'; $('rt-time').value = '08:00'; $('rt-dow-wrap').hidden = true }
  $('rt-err').textContent = ''
  $('rt-delete').hidden = !r
  $('routine-overlay').classList.add('open')
}

$('routine-add').addEventListener('click', () => openRoutine(null))
$('rt-cancel').addEventListener('click', () => $('routine-overlay').classList.remove('open'))

$('rt-save').addEventListener('click', async () => {
  const err = $('rt-err')
  err.textContent = ''
  const name = $('rt-name').value.trim()
  const prompt = $('rt-prompt').value.trim()
  if (!name || !prompt) { err.textContent = 'Name und Auftrag sind Pflicht.'; return }
  const { cron, label } = cronFromForm()
  const row = {
    name, prompt, cron, schedule_label: label,
    pod_id: $('rt-pod').value || null,
    model: $('rt-model').value,
    enabled: $('rt-enabled').checked,
  }
  $('rt-save').disabled = true
  const q = editingRoutine
    ? sb.from('routines').update(row).eq('id', editingRoutine.id)
    : sb.from('routines').insert({ ...row, created_by: session.user.id })
  const { error } = await q
  $('rt-save').disabled = false
  if (error) { err.textContent = 'Fehler: ' + error.message; return }
  $('routine-overlay').classList.remove('open')
  loadRoutines()
})

$('rt-delete').addEventListener('click', async () => {
  if (!editingRoutine) return
  if (!window.confirm(`Routine "${editingRoutine.name}" löschen?`)) return
  const { error } = await sb.from('routines').delete().eq('id', editingRoutine.id)
  if (error) { $('rt-err').textContent = 'Fehler: ' + error.message; return }
  $('routine-overlay').classList.remove('open')
  loadRoutines()
})

// ============================================================ Realtime (Multi-Sessions + Pod-Team-Chat)
// Supabase Realtime pusht Änderungen instant; RLS scopet die Events (eigene Konvs +
// sichtbare Pod-Konvs). Der 60s-Poll darunter ist nur Fallback für abgerissene Sockets.
const statusSnapshot = new Map()
let debounceTimer = null
const loadConversationsDebounced = () => {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(loadConversations, 200)
}
let podsDebounceTimer = null
const loadPodsDebounced = () => {
  clearTimeout(podsDebounceTimer)
  podsDebounceTimer = setTimeout(loadPods, 300)
}

function onConvChange(c) {
  if (!c?.id) return
  const prev = statusSnapshot.get(c.id)
  statusSnapshot.set(c.id, { working: c.working, unread: c.unread })
  // Offene Konversation wurde außerhalb dieses Tabs fertig (Routine, anderes Gerät) → neu laden
  if (prev?.working && !c.working && currentConv?.id === c.id && !activeStreams.has(c.id) && !sendingViews.size) {
    openConversation(currentConv)
    return
  }
  if (!c.pod_id && c.user_id === session.user.id) loadConversationsDebounced()
  // Pod-Status-Punkte in der Sidebar + Konversationsliste live halten
  if (c.pod_id) {
    loadPodsDebounced()
    if (activePod?.id === c.pod_id && !$('ptab-convs').hidden) loadPodConvs()
  }
}

function subscribeRealtime() {
  sb.channel('conv-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'conversations' }, (p) => onConvChange(p.new))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'conversations' }, (p) => onConvChange(p.new))
    .subscribe()
}

// Live-Nachrichten der gerade offenen Konversation (Pod-Team-Chat ohne Reload).
// Eigene Nachrichten + eigene Streams rendern lokal — nur Fremdes wird angehängt.
let msgChannel = null
function subscribeConvMessages(convId) {
  if (msgChannel) { sb.removeChannel(msgChannel); msgChannel = null }
  if (!convId) return
  msgChannel = sb
    .channel('msgs-' + convId)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` },
      async (p) => {
        const m = p.new
        if (currentConv?.id !== convId) return
        if (activeStreams.has(convId)) return // eigener Stream rendert live
        if (m.role === 'compaction') return
        if (m.role === 'user' && m.author_id === session.user.id) return // schon im DOM
        const profs = await allProfiles()
        const box = $('msgs')
        box.querySelector('.empty')?.remove()
        if (m.role === 'user')
          box.appendChild(renderPeer(profName(profs, m.author_id), m.content, m.attachments))
        else if (m.role === 'assistant')
          box.appendChild(renderAgent(m.content, m.thinking, m.tool_calls || [], undefined, m.duration_ms))
        window.scrollTo({ top: document.body.scrollHeight })
      }
    )
    .subscribe()
}

// Live-Wiedereinstieg: öffnet man eine Konversation, in der Enni GERADE arbeitet
// (nach Wegnavigieren, anderes Gerät, Routine), zeigt dieser Container die aktuellen
// Gedanken/Tools/Text aus dem Progress-Broadcast des Backends — nicht erst das Endergebnis.
let progressChannel = null
function closeProgressChannel() {
  if (progressChannel) {
    sb.removeChannel(progressChannel)
    progressChannel = null
  }
}

function renderLiveProgressIfWorking(c) {
  closeProgressChannel()
  // Realtime-Snapshot ist frischer als das gecachte Konversations-Objekt aus der Sidebar
  const snap = statusSnapshot.get(c.id)
  const working = (snap ? snap.working : c.working) || activeStreams.has(c.id)
  if (!working) return
  const box = $('msgs')
  const wrap = document.createElement('div')
  wrap.className = 'm-agent'
  wrap.innerHTML = `<div class="who"><span class="enni-dot">E</span><b>Enni</b></div>
    <div class="think"><button class="think-head"><span class="chev">▶</span><span class="t-status shimmer">Enni arbeitet …</span></button>
      <div class="think-body"><div class="tp"></div><div class="think-run"><span class="pulse"></span>Enni arbeitet …</div></div>
    </div>
    <div class="body"></div>`
  const thinkEl = wrap.querySelector('.think')
  thinkEl.addEventListener('click', (e) => {
    if (e.target.closest('.tool-row')) return
    thinkEl.classList.toggle('open')
  })
  box.appendChild(wrap)
  const tstatus = wrap.querySelector('.t-status')
  const tp = wrap.querySelector('.tp')
  const body = wrap.querySelector('.body')
  progressChannel = sb
    .channel('progress-' + c.id)
    .on('broadcast', { event: 'progress' }, ({ payload: p }) => {
      if (currentConv?.id !== c.id || !p) return
      tp.textContent = p.thinking || ''
      const tools = p.tools?.length ? ` · ${p.tools.length} Tool-Aufruf${p.tools.length > 1 ? 'e' : ''}` : ''
      tstatus.textContent =
        p.phase === 'text' ? `Schreibt …${tools}` :
        p.phase === 'tool' ? `Nutzt ${p.tools[p.tools.length - 1]} …` :
        p.phase === 'done' ? 'Schließt ab …' : `Enni denkt nach …${tools}`
      body.innerHTML = p.text ? md(p.text) : ''
      if (p.text && p.phase !== 'done') body.insertAdjacentHTML('beforeend', '<span class="scursor"></span>')
      followIfNearBottom()
    })
    .subscribe()
  // Frisch-Check gegen die DB: war der Turn beim Öffnen schon vorbei (Race mit dem
  // Realtime-Event), Container wieder entfernen — die finale Antwort ist ja schon gerendert.
  sb.from('conversations').select('working').eq('id', c.id).maybeSingle().then(({ data }) => {
    if (data && !data.working && !activeStreams.has(c.id)) {
      closeProgressChannel()
      wrap.remove()
    }
  })
  // Fertigstellung lädt die Konversation neu (onConvChange working→false) und
  // räumt diesen Kanal über closeProgressChannel() beim Re-Open ab.
}

// Fallback-Poll (60s): fängt verpasste Events nach Netz-Abrissen/Schlaf-Modus ab
setInterval(async () => {
  if (document.hidden || !session) return
  const { data } = await sb
    .from('conversations')
    .select('id, user_id, pod_id, working, unread')
    .eq('user_id', session.user.id)
    .is('pod_id', null)
    .order('updated_at', { ascending: false })
    .limit(50)
  for (const c of data || []) onConvChange(c)
}, 60000)

// Hell/Dunkel-Umschalter (Init passiert inline im <head>, gegen Theme-Flash)
$('theme-toggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  localStorage.setItem('enni-theme', next)
})

// Klick auf den abgedunkelten Hintergrund schließt jedes Modal (Abbrechen)
document.addEventListener('mousedown', (e) => {
  if (e.target.classList?.contains('overlay') && e.target.classList.contains('open')) {
    e.target.classList.remove('open')
  }
})

// ============================================================ Globale Suche (⌘K)
// Durchsucht Konversationen (RLS-gescoped: eigene + sichtbare Pod-Konvs), Wiki-Seiten,
// Skills (nur team-weit + eigene) und Pods. Tastatur: ⌘/Strg+K öffnet, Pfeile + Enter.
const PAL_ICONS = {
  conv: '<svg viewBox="0 0 24 24"><path d="M21 12a8 8 0 0 1-8 8H5l-2 2V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/></svg>',
  pod: '<svg viewBox="0 0 24 24"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
  wiki: '<svg viewBox="0 0 24 24"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>',
  skill: '<svg viewBox="0 0 24 24"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
}
let palItems = []
let palSel = 0
let palSeq = 0

function openPalette() {
  $('pal-input').value = ''
  $('pal-results').innerHTML = '<div class="pal-empty">Tippen zum Suchen …</div>'
  palItems = []
  palSel = 0
  $('pal-overlay').classList.add('open')
  setTimeout(() => $('pal-input').focus(), 30)
}
function closePalette() { $('pal-overlay').classList.remove('open') }

async function palSearch(q) {
  const seq = ++palSeq
  q = q.trim()
  if (!q) {
    palItems = []
    $('pal-results').innerHTML = '<div class="pal-empty">Tippen zum Suchen …</div>'
    return
  }
  const like = `%${q.replace(/[%_]/g, '')}%`
  const { data: convs } = await sb
    .from('conversations').select('id, title, pod_id, updated_at')
    .ilike('title', like).order('updated_at', { ascending: false }).limit(6)
  if (seq !== palSeq) return // veraltete Antwort verwerfen
  if (!wikiPages) {
    const { data } = await sb.from('wiki_pages').select('slug, title, updated_at, space_id').order('slug')
    if (data) wikiPages = data
  }
  const ql = q.toLowerCase()
  const items = []
  for (const c of convs || []) {
    const pod = c.pod_id ? podsList.find((p) => p.id === c.pod_id) : null
    items.push({ type: 'conv', title: c.title || 'Ohne Titel', sub: pod ? `Pod · ${pod.name}` : 'Konversation', run: () => { convPod = pod || null; openConversation(c) } })
  }
  for (const p of podsList.filter((p) => p.name.toLowerCase().includes(ql)).slice(0, 4)) {
    items.push({ type: 'pod', title: p.name, sub: 'Pod öffnen', run: () => openPod(p) })
  }
  for (const w of (wikiPages || []).filter((p) => (p.title || '').toLowerCase().includes(ql) || p.slug.toLowerCase().includes(ql)).slice(0, 6)) {
    items.push({ type: 'wiki', title: pageLabel(w), sub: `Wiki · ${w.slug}`, run: () => openWikiPage(w.slug) })
  }
  for (const s of (await allSkills()).filter((s) => s.name.toLowerCase().includes(ql) || s.slug.includes(ql)).slice(0, 6)) {
    items.push({ type: 'skill', title: s.name, sub: `Skill · /${s.slug}`, run: () => { history.pushState({}, '', '/spaces/skills'); route(); setTimeout(() => sb.from('skills').select('*').eq('slug', s.slug).maybeSingle().then(({ data }) => data && openSkill(data, false)), 400) } })
  }
  if (seq !== palSeq) return
  // In Gruppen-Reihenfolge sortieren (= Render-Reihenfolge, damit Pfeiltasten stimmen)
  const order = { conv: 0, pod: 1, wiki: 2, skill: 3 }
  items.sort((a, b) => order[a.type] - order[b.type])
  palItems = items
  palSel = 0
  renderPalette()
}

function renderPalette() {
  const box = $('pal-results')
  if (!palItems.length) { box.innerHTML = '<div class="pal-empty">Keine Treffer.</div>'; return }
  const groups = { conv: 'Konversationen', pod: 'Pods', wiki: 'Wiki', skill: 'Skills' }
  box.innerHTML = ''
  palItems.forEach((it, i) => {
    if (i === 0 || palItems[i - 1].type !== it.type) {
      box.insertAdjacentHTML('beforeend', `<div class="pal-group">${groups[it.type]}</div>`)
    }
    const el = document.createElement('button')
    el.className = 'pal-item' + (i === palSel ? ' sel' : '')
    el.dataset.i = i
    el.innerHTML = `<span class="pal-i">${PAL_ICONS[it.type]}</span><span class="pal-main"><span class="pal-t">${esc(it.title)}</span><span class="pal-s">${esc(it.sub)}</span></span>`
    el.addEventListener('click', () => palRun(i))
    el.addEventListener('mousemove', () => { if (palSel !== i) { palSel = i; markPalSel() } })
    box.appendChild(el)
  })
}
function markPalSel() {
  document.querySelectorAll('#pal-results .pal-item').forEach((el) => el.classList.toggle('sel', Number(el.dataset.i) === palSel))
  document.querySelector('#pal-results .pal-item.sel')?.scrollIntoView({ block: 'nearest' })
}
function palRun(i) {
  const it = palItems[i]
  if (!it) return
  closePalette()
  it.run()
}

let palDebounce = null
$('pal-input').addEventListener('input', (e) => {
  clearTimeout(palDebounce)
  palDebounce = setTimeout(() => palSearch(e.target.value), 130)
})
$('pal-input').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (palItems.length) { palSel = (palSel + 1) % palItems.length; markPalSel() } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (palItems.length) { palSel = (palSel - 1 + palItems.length) % palItems.length; markPalSel() } }
  else if (e.key === 'Enter') { e.preventDefault(); palRun(palSel) }
  else if (e.key === 'Escape') closePalette()
})
$('global-search-btn').addEventListener('click', openPalette)
$('pal-overlay').addEventListener('click', (e) => { if (e.target === $('pal-overlay')) closePalette() })
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    $('pal-overlay').classList.contains('open') ? closePalette() : openPalette()
  }
})

init()
