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
