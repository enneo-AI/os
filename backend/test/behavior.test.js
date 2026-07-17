import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { capabilityPromptBlock } from '../src/behavior.js'

const here = dirname(fileURLToPath(import.meta.url))

test('capability block reflects the actual per-turn tool catalog', () => {
  const block = capabilityPromptBlock([
    { name: 'wiki_semantic_search' },
    { name: 'gitlab_search_code' },
    { name: 'attio_query_records' },
    { name: 'skill_read' },
    { name: 'create_file' },
    { name: 'ux_ui_request_change' },
    { name: 'gitlab_ui_create_branch' },
    { name: 'mcp__deepwiki__read_wiki_structure' },
  ])

  assert.match(block, /Firmenwiki & Docs: VERFÜGBAR/)
  assert.match(block, /Enneo-Monorepo \(GitLab\): VERFÜGBAR/)
  assert.match(block, /Attio CRM & Meetings: VERFÜGBAR/)
  assert.match(block, /Slack: nicht verbunden/)
  assert.match(block, /enneo-Brand-Dateien: VERFÜGBAR/)
  assert.match(block, /UX\/UI-Aenderungsanfragen: VERFÜGBAR/)
  assert.match(block, /UX\/UI-Code-Umsetzung \(Admin\): VERFÜGBAR/)
  assert.match(block, /Weitere MCP-Server: deepwiki/)
})

test('system prompt keeps the decision and anti-generic quality gates', () => {
  const source = readFileSync(join(here, '../src/agent.js'), 'utf8')

  assert.match(source, /ENTSCHEIDUNGSPROTOKOLL/)
  assert.match(source, /Der spezifischste Fach-Skill gewinnt/)
  assert.match(source, /Minimal ausreichend recherchieren/)
  assert.match(source, /QUALITÄTSCHECK VOR DEM SENDEN/)
  assert.match(source, /RECHERCHE-BUDGET/)
  assert.match(source, /ANTWORT-BUDGET/)
  assert.match(source, /SEARCH_TOOL_LIMITS/)
  assert.match(source, /Recherche-Budget für/)
  assert.match(source, /# Finalisierung/)
  assert.match(source, /niemals leer antworten/)
  assert.match(source, /Automatisch geladene Skills/)
  assert.match(source, /autoSkillsPromptBlock/)
})

test('skill router preserves specialization and composition rules', () => {
  const source = readFileSync(join(here, '../src/tools/skills.js'), 'utf8')

  assert.match(source, /Der spezifischste Fach-Skill gewinnt/)
  assert.match(source, /zuerst Recherche\/Fachinhalt, zuletzt Ausgabeformat/)
  assert.match(source, /sales-call-prep, danach \/praesentation/)
  assert.match(source, /selectSkillsForPrompt/)
  assert.match(source, /Explizite Nutzerwünsche zu Länge, Format und Fokus haben Vorrang/)
  assert.match(source, /ux-ui-engineering/)
})

test('UX/UI engineering keeps member and admin capabilities technically separated', () => {
  const source = readFileSync(join(here, '../src/tools/ux-ui.js'), 'utf8')

  assert.match(source, /commonDefinitions/)
  assert.match(source, /adminDefinitions/)
  assert.match(source, /profile\?\.is_admin && profile\.account_status === 'active'/)
  assert.match(source, /Nur Admins duerfen UX\/UI-Anfragen verwalten oder umsetzen/)
  assert.match(source, /\^enni\\\/ui-/)
  assert.match(source, /Default-Branch darf nicht beschrieben werden/)
  assert.match(source, /completed erfordert Merge-Request-Link und dokumentierte Verifikation/)
})

test('Pod customer links keep Attio read-only, scoped and lazy', () => {
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const attioSource = readFileSync(join(here, '../src/tools/attio.js'), 'utf8')
  const migration = readFileSync(
    join(here, '../../supabase/migrations/20260715171459_pod_attio_links.sql'),
    'utf8'
  )

  assert.match(indexSource, /pod\.created_by === userId \|\| !!profile\?\.is_admin/)
  assert.match(indexSource, /Diese Verknüpfung ist die eindeutige Kundenidentität/)
  assert.match(indexSource, /Lade nicht reflexhaft die gesamte CRM-Historie/)
  assert.match(indexSource, /app\.put\('\/api\/pods\/:id\/attio'/)
  assert.match(attioSource, /\/objects\/records\/search/)
  assert.doesNotMatch(attioSource, /method:\s*'PATCH'/)
  assert.match(migration, /enable row level security/g)
  assert.match(migration, /grant select on table public\.pod_attio_links to authenticated/)
  assert.match(migration, /revoke all on table public\.pod_attio_links from anon, authenticated/)
})

test('notifications are user-scoped, admin-published and push-capable', () => {
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const notificationSource = readFileSync(join(here, '../src/notifications.js'), 'utf8')
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const serviceWorker = readFileSync(join(here, '../../frontend/sw.js'), 'utf8')
  const migration = readFileSync(
    join(here, '../../supabase/migrations/20260715173540_notifications_and_web_push.sql'),
    'utf8'
  )

  assert.match(migration, /notifications_select_own/)
  assert.match(migration, /user_id = \(select auth\.uid\(\)\)/)
  assert.match(migration, /revoke all on public\.push_subscriptions from anon, authenticated/)
  assert.match(migration, /private\.notify_task_assignment/)
  assert.match(migration, /private\.notify_task_comment/)
  assert.match(indexSource, /app\.post\('\/api\/admin\/announcements'/)
  assert.match(indexSource, /app\.post\('\/api\/conversations\/:id\/read'/)
  assert.match(indexSource, /const user = await requireAdmin\(req, res\)/)
  assert.match(notificationSource, /tokens\.includes\('team'\)/)
  assert.match(notificationSource, /webpush\.sendNotification/)
  assert.match(notificationSource, /\.is\('read_at', null\)/)
  assert.match(frontendSource, /Notification\.requestPermission/)
  assert.match(frontendSource, /document\.title = unread/)
  assert.match(frontendSource, /showLocalCompletionNotification/)
  assert.match(frontendSource, /visibilitychange/)
  assert.match(serviceWorker, /showNotification/)
  assert.match(serviceWorker, /notificationclick/)
})

test('slash skills work and stay visible inside complete sentences', () => {
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')

  assert.match(indexSource, /slashMatch = .*\(\?:\^\|\\s\)/)
  assert.match(frontendSource, /before\.match\(\/\(\?:\^\|\\s\)/)
  assert.match(frontendSource, /message-skill-tag/)
  assert.match(frontendSource, /!hasSlashSkill\(text\)/)
})

test('invites use durable temporary passwords instead of expiring links', () => {
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')

  assert.match(indexSource, /function temporaryPassword/)
  assert.match(indexSource, /randomBytes\(12\)/)
  assert.match(indexSource, /db\.auth\.admin\.createUser/)
  assert.match(indexSource, /email_confirm: true/)
  assert.match(indexSource, /temporary_password: password/)
  assert.doesNotMatch(indexSource, /db\.auth\.admin\.generateLink/)
  assert.match(frontendSource, /Startpasswort:/)
  assert.match(frontendSource, /Login-Daten kopieren/)
  assert.match(frontendSource, /if \(await onboardingNudge\(\)\) return/)
  assert.match(frontendSource, /await enterWorkspace\(\)/)
})

test('contexts stay private and required skill sources load deterministically', () => {
  const contextSource = readFileSync(join(here, '../src/contexts.js'), 'utf8')
  const skillSource = readFileSync(join(here, '../src/tools/skills.js'), 'utf8')
  const agentSource = readFileSync(join(here, '../src/agent.js'), 'utf8')
  const migration = readFileSync(
    join(here, '../../supabase/migrations/20260717073201_context_foundation.sql'),
    'utf8'
  )

  const selectPolicy = migration.match(/create policy contexts_select[\s\S]*?;\n/)?.[0] || ''
  assert.match(selectPolicy, /visibility = 'team' or owner_id = \(select auth\.uid\(\)\)/)
  assert.doesNotMatch(selectPolicy, /p\.is_admin/)
  assert.match(migration, /active_account_only on public\.contexts as restrictive/)
  assert.match(migration, /profiles_departments_check/)
  assert.match(contextSource, /Privater persönlicher Kontext/)
  assert.match(contextSource, /Verbindlich geladene Kontexte/)
  assert.match(skillSource, /requiredContextsText/)
  assert.match(agentSource, /loadPersonalContextBlock/)
})

test('remote MCP research is structured and keeps provider auth headers explicit', () => {
  const researchSource = readFileSync(join(here, '../src/tool-research.js'), 'utf8')
  const mcpSource = readFileSync(join(here, '../src/tools/mcp.js'), 'utf8')
  const migration = readFileSync(join(here, '../../supabase/migrations/20260717075004_mcp_auth_schemes.sql'), 'utf8')

  assert.match(researchSource, /tool_choice: \{ type: 'tool', name: 'submit_blueprint' \}/)
  assert.match(researchSource, /mcp_scheme/)
  assert.match(researchSource, /fallbackLogoUrl/)
  assert.match(researchSource, /logo_url/)
  assert.match(researchSource, /enum: \['read_only', 'read_write'\]/)
  assert.doesNotMatch(researchSource, /function parseJson/)
  assert.match(mcpSource, /'X-API-Key': token/)
  assert.match(mcpSource, /encryptSecret\(token\.trim\(\)\)/)
  assert.match(mcpSource, /decryptSecret\(c\.token\)/)
  assert.match(migration, /mcp_bearer.*mcp_x_api_key.*mcp_none/s)
})

test('researched integrations join the existing permission sections with provider logos', () => {
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const frontendHtml = readFileSync(join(here, '../../frontend/index.html'), 'utf8')

  assert.match(frontendHtml, /id="researched-read-write"/)
  assert.match(frontendHtml, /id="researched-read-only"/)
  assert.doesNotMatch(frontendHtml, /id="researched-marketplace"/)
  assert.match(frontendSource, /researchLogoUrl/)
  assert.match(frontendSource, /researchAccessLabel/)
  assert.doesNotMatch(frontendSource, /Von Enni recherchiert/)
})

test('curated MCPs use personal OAuth, new tabs and deduplicated rendering', () => {
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const frontendHtml = readFileSync(join(here, '../../frontend/index.html'), 'utf8')
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const mcpSource = readFileSync(join(here, '../src/tools/mcp.js'), 'utf8')
  const oauthSource = readFileSync(join(here, '../src/mcp-oauth.js'), 'utf8')
  const migration = readFileSync(join(here, '../../supabase/migrations/20260717121000_mcp_oauth_personal_connections.sql'), 'utf8')

  assert.match(frontendSource, /display_name: 'Lemlist'/)
  assert.match(frontendSource, /https:\/\/app\.lemlist\.com\/mcp/)
  assert.match(frontendSource, /auth_type: 'mcp_oauth'/)
  assert.match(frontendSource, /oauth_provider: 'lemlist'/)
  assert.match(frontendSource, /display_name: 'TickTick'/)
  assert.match(frontendSource, /https:\/\/mcp\.ticktick\.com/)
  assert.match(frontendSource, /oauth_provider: 'ticktick'/)
  assert.match(frontendSource, /startMcpOAuth/)
  assert.match(frontendSource, /access_mode: 'read_write'/)
  assert.match(frontendSource, /https:\/\/www\.lemlist\.com\/favicon\.ico/)
  assert.doesNotMatch(frontendHtml, /id="cn-owner"/)
  assert.doesNotMatch(frontendHtml, /for="cn-owner"/)
  assert.doesNotMatch(frontendSource, /cn-owner/)
  assert.match(indexSource, /const owner = personal \? user\.id : null/)
  assert.match(indexSource, /\/api\/mcp\/oauth\/:provider\/start/)
  assert.match(indexSource, /\/api\/mcp\/oauth\/:provider\/callback/)
  assert.match(oauthSource, /token_endpoint_auth_method: 'none'/)
  assert.match(oauthSource, /ticktick:/)
  assert.match(oauthSource, /saveClientInformation/)
  assert.match(oauthSource, /visibility: 'personal'/)
  assert.match(mcpSource, /oauthProviderForConnector/)
  assert.match(mcpSource, /moveConnectorAssignments\(previousIds, data\.id\)/)
  assert.match(mcpSource, /\.eq\('url', normalizedUrl\)/)
  assert.match(migration, /mcp_oauth_sessions/)
  assert.match(migration, /oauth_client_information/)
  assert.match(migration, /revoke all.*authenticated/s)
  assert.match(frontendSource, /window\.open\('about:blank'/)
  assert.match(frontendSource, /OAUTH_RESULT_STORAGE_KEY/)
  assert.match(frontendSource, /window\.addEventListener\('storage'/)
  assert.match(frontendSource, /toolResearchLoadVersion/)
  assert.match(frontendSource, /curatedKeys/)
  assert.match(frontendSource, /Object\.values\(NATIVE_CONNECTORS\)/)
})

test('researched MCPs require certification and gain dynamic OAuth without code changes', () => {
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const researchSource = readFileSync(join(here, '../src/tool-research.js'), 'utf8')
  const oauthSource = readFileSync(join(here, '../src/mcp-oauth.js'), 'utf8')
  const migration = readFileSync(join(here, '../../supabase/migrations/20260717124500_dynamic_mcp_oauth_providers.sql'), 'utf8')

  assert.match(researchSource, /certifyToolBlueprint/)
  assert.match(researchSource, /oauth_discovery_dcr_pkce/)
  assert.match(researchSource, /official_endpoint_runtime_credential_probe/)
  assert.match(researchSource, /connect_ready: false/)
  assert.match(indexSource, /Technische Zertifizierung fehlgeschlagen/)
  assert.match(indexSource, /\/api\/tool-requests\/:id\/oauth\/start/)
  assert.match(indexSource, /blueprint\.certification\?\.status !== 'verified'/)
  assert.match(frontendSource, /Verbindung wird geprüft/)
  assert.match(frontendSource, /Technisch verifiziert/)
  assert.match(frontendSource, /isCertifiedConnectReady/)
  assert.match(frontendSource, /\/api\/tool-requests\/\$\{item\.id\}\/oauth\/start/)
  assert.match(oauthSource, /server = null, cleanup = false/)
  assert.match(oauthSource, /connector\?\.oauth_provider/)
  assert.match(oauthSource, /oauth_provider: session\.provider/)
  assert.match(migration, /add column if not exists oauth_provider text/)
})

test('marketplace connections stay dormant until an accessible Space activates them', () => {
  const accessSource = readFileSync(join(here, '../src/connector-access.js'), 'utf8')
  const mcpSource = readFileSync(join(here, '../src/tools/mcp.js'), 'utf8')
  const productivitySource = readFileSync(join(here, '../src/tools/productivity.js'), 'utf8')
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const frontendHtml = readFileSync(join(here, '../../frontend/index.html'), 'utf8')
  const migration = readFileSync(
    join(here, '../../supabase/migrations/20260717082825_space_scoped_connectors.sql'),
    'utf8'
  )

  assert.match(accessSource, /space_connections/)
  assert.match(accessSource, /!space\.restricted \|\| space\.created_by === userId \|\| memberOf\.has\(space\.id\)/)
  assert.match(mcpSource, /canUseConnector/)
  assert.match(productivitySource, /connectorForUser/)
  assert.match(migration, /private\.can_attach_connector/)
  assert.match(migration, /Restricted really means invited/)
  assert.doesNotMatch(migration.match(/create policy spaces_select[\s\S]*?;\n/)?.[0] || '', /is_admin/)
  assert.match(frontendHtml, /Apps verbinden\. Zugriff regelst du im Space\./)
  assert.match(frontendHtml, /<h2>Marketplace<\/h2>/)
  assert.match(frontendHtml, /id="installed-connections"/)
  assert.match(frontendHtml, /id="context-access-filter"/)
  assert.match(frontendHtml, /Restricted · nur du/)
  assert.match(frontendSource, /connectorDirectory/)
  assert.match(frontendSource, /connectorAccess/)
  assert.match(frontendSource, /Noch keine Connections aktiviert/)
})

test('Space navigation is flat and Restricted owners can atomically manage members', () => {
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const frontendHtml = readFileSync(join(here, '../../frontend/index.html'), 'utf8')
  const migration = readFileSync(
    join(here, '../../supabase/migrations/20260717131500_atomic_restricted_space_members.sql'),
    'utf8'
  )

  const renderTree = frontendSource.match(/function renderSpaceTree\(\)[\s\S]*?\n}\n\n\/\/ ---------- Space-Übersicht/)?.[0] || ''
  assert.doesNotMatch(frontendSource, /const expanded = new Set/)
  assert.doesNotMatch(renderTree, /tree-chev|tree-kids|groupPages/)
  assert.match(renderTree, /row\.addEventListener\('click', \(\) => openSpaceHome\(s\)\)/)
  assert.match(frontendHtml, /id="sh-members-manage"/)
  assert.match(frontendHtml, /id="space-members-overlay"/)
  assert.match(frontendSource, /sb\.rpc\('replace_space_members'/)
  assert.match(migration, /owner_id is distinct from auth\.uid\(\)/)
  assert.match(migration, /Only the owning active account/)
  assert.doesNotMatch(migration, /is_admin/)
  assert.match(migration, /values \(target_space_id, owner_id\)/)
})

test('Pods separate discovery from membership and always load team context', () => {
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const frontendHtml = readFileSync(join(here, '../../frontend/index.html'), 'utf8')
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const contextSource = readFileSync(join(here, '../src/pod-context.js'), 'utf8')
  const notificationSource = readFileSync(join(here, '../src/notifications.js'), 'utf8')
  const migration = readFileSync(
    join(here, '../../supabase/migrations/20260717143000_pod_membership_context_and_invitations.sql'),
    'utf8'
  )

  assert.match(frontendHtml, /data-tab="context"/)
  assert.match(frontendHtml, /id="pctx-instructions"/)
  assert.match(frontendHtml, /id="pctx-responsibilities"/)
  assert.doesNotMatch(frontendHtml.match(/id="ptab-settings"[\s\S]*?<\/div>\n      <\/div>\n    <\/section>/)?.[0] || '', /pset-instructions/)
  assert.match(frontendSource, /sb\.rpc\('join_open_pod'/)
  assert.match(frontendSource, /sb\.rpc\('invite_to_pod'/)
  assert.match(frontendSource, /sb\.rpc\('respond_to_pod_invitation'/)
  assert.match(indexSource, /extraSystem \+= await podContextPrompt\(pod\)/)
  assert.match(contextSource, /POD-KONTEXT \(in jedem Turn verbindlich berücksichtigen\)/)
  assert.match(contextSource, /Teamrollen und Verantwortungen/)
  assert.doesNotMatch(notificationSource, /pod\.open\s*\?\s*Promise\.resolve/)
  assert.match(migration, /Open only controls discoverability/)
  assert.match(migration, /create table public\.pod_member_contexts/)
  assert.match(migration, /create table public\.pod_invitations/)
  assert.match(migration, /create or replace function public\.join_open_pod/)
  assert.match(migration, /create or replace function public\.respond_to_pod_invitation/)
})

test('impact reporting labels estimates and records skill usage', () => {
  const indexSource = readFileSync(join(here, '../src/index.js'), 'utf8')
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const frontendHtml = readFileSync(join(here, '../../frontend/index.html'), 'utf8')
  const migration = readFileSync(join(here, '../../supabase/migrations/20260717075535_impact_reporting.sql'), 'utf8')

  assert.match(indexSource, /app\.get\('\/api\/admin\/impact'/)
  assert.match(indexSource, /3 \+ successfulTools\.length \* 2 \+ files \* 8/)
  assert.match(indexSource, /Transparente Näherung, keine Zeiterfassung/)
  assert.match(indexSource, /skill_usage_events/)
  assert.match(frontendSource, /loadImpact/)
  assert.match(frontendHtml, /Team-Impact/)
  assert.match(migration, /skill_usage_events_select/)
  assert.match(migration, /active_account_only.*as restrictive/s)
})

test('Marketplace account login is separated from technical platform enablement', () => {
  const frontendSource = readFileSync(join(here, '../../frontend/app.js'), 'utf8')
  const frontendHtml = readFileSync(join(here, '../../frontend/index.html'), 'utf8')
  const oauthSource = readFileSync(join(here, '../src/mcp-oauth.js'), 'utf8')

  assert.match(oauthSource, /notion:[\s\S]*https:\/\/mcp\.notion\.com\/mcp/)
  assert.match(oauthSource, /attio:[\s\S]*https:\/\/mcp\.attio\.com\/mcp/)
  assert.match(frontendSource, /mcpProvider: 'notion'/)
  assert.match(frontendSource, /mcpProvider: 'attio'/)
  assert.match(frontendSource, /nativeSubConnected: 'CRM-Daten und Meetings · Read-only'/)
  assert.match(frontendSource, /const targetMode = legacyNative \? cfg\.nativeAccessMode : cfg\.accessMode/)
  assert.match(frontendSource, /Account verbinden/)
  assert.match(frontendSource, /Admin-Freigabe fehlt/)
  assert.doesNotMatch(frontendSource, /isAdmin \? '<span class="connector-setup">Einrichten/)
  assert.doesNotMatch(frontendSource, /res\.status === 409 && is_admin/)
  assert.doesNotMatch(frontendSource, /Anbieter-Portal ↗/)
  assert.match(frontendHtml, /data-admin-tab="integrations"/)
  assert.match(frontendHtml, /data-admin-pane="integrations"/)
  assert.match(frontendHtml, /Workspace freischalten/)
})
