// Tool-Schemas sind für das Modell zwar sichtbar, aber ein kompakter Lageplan
// verbessert die Quellenwahl deutlich: Enni erkennt auf einen Blick, welche
// Connections in DIESEM Nutzer-Turn wirklich vorhanden sind und welche fehlen.
export function capabilityPromptBlock(definitions) {
  const names = definitions.map((tool) => tool.name)
  const count = (prefix) => names.filter((name) => name.startsWith(prefix)).length
  const has = (prefix) => count(prefix) > 0
  const connected = [
    ['Firmenwiki & Docs', has('wiki_'), count('wiki_')],
    ['Enneo-Monorepo (GitLab)', has('gitlab_'), count('gitlab_')],
    ['Live-Enneo-Instanzen', has('enneo_'), count('enneo_')],
    ['Attio CRM & Meetings', has('attio_'), count('attio_')],
    ['Slack', has('slack_'), count('slack_')],
    ['Outlook Mail & Kalender', has('outlook_'), count('outlook_')],
    ['Google Drive', has('google_drive_'), count('google_drive_')],
    ['Notion', has('notion_'), count('notion_')],
    ['Skills', has('skill_'), count('skill_')],
    ['enneo-Brand-Dateien', names.includes('create_file'), names.includes('create_file') ? 1 : 0],
    ['Pod-Kontext', has('pod_'), count('pod_')],
  ]
  const mcpNames = names.filter((name) => name.startsWith('mcp__'))
  const lines = connected.map(([label, available, tools]) =>
    `- ${label}: ${available ? `VERFÜGBAR (${tools} Tools)` : 'nicht verbunden'}`
  )
  if (mcpNames.length) {
    const servers = [...new Set(mcpNames.map((name) => name.split('__')[1]).filter(Boolean))]
    lines.push(`- Weitere MCP-Server: ${servers.join(', ')} (${mcpNames.length} Tools)`)
  } else {
    lines.push('- Weitere MCP-Server: keine verbunden')
  }
  return (
    `# Verfügbare Arbeitsmittel in diesem Turn\n` +
    `Diese Liste ist nutzer- und turn-spezifisch. Plane deine Recherche aktiv damit. ` +
    `„Nicht verbunden“ heißt: nicht behaupten, Zugriff zu haben; wenn die Aufgabe es braucht, request_tool_connection nutzen.\n` +
    lines.join('\n')
  )
}
