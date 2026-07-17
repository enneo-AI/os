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
