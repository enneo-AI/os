// Tool-Registrierung aus dem Chat heraus: Wenn Enni erkennt, dass für eine Aufgabe /
// einen Workflow ein Tool fehlt (CRM nicht verbunden, externer Dienst nötig, MCP-Server
// bekannt), ruft er request_tool_connection auf. Das Frontend rendert daraus eine
// Verbindungs-Karte im Chat (native Anbieter per OAuth, MCP optional mit Token).
// Enni sieht die Credentials NIE — die Karte spricht direkt mit dem Backend.

export const registrationToolDefinitions = [
  {
    name: 'request_tool_connection',
    description:
      'Zeigt dem Nutzer eine Verbindungs-Karte für ein fehlendes Tool. Outlook, Google Drive, Notion, Attio und Slack nutzen einen sicheren Anbieter-Login; nur beliebige MCP-Server brauchen URL und optional einen Token. Nutze kind "outlook", "google_drive", "notion", "attio", "slack" oder "mcp". Admin-Verbindungen werden teamweit, Member-Verbindungen persönlich angelegt.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['outlook', 'google_drive', 'notion', 'attio', 'slack', 'mcp'], description: 'Art der Verbindung' },
        name: { type: 'string', description: 'Anzeigename des Tools, z. B. "Attio CRM" oder "Firecrawl MCP"' },
        url: { type: 'string', description: 'Nur bei kind=mcp: die https-URL des MCP-Servers (weglassen, wenn unbekannt — der Nutzer kann sie eintragen)' },
        reason: { type: 'string', description: 'Ein Satz für den Nutzer: wofür wird das Tool gebraucht?' },
      },
      required: ['kind', 'name', 'reason'],
      additionalProperties: false,
    },
  },
]

export async function runRegistrationTool(name, input) {
  if (name !== 'request_tool_connection') throw new Error(`Unbekanntes Tool: ${name}`)
  return JSON.stringify({
    card: 'tool_connection',
    kind: input.kind,
    name: input.name,
    url: input.url || null,
    reason: input.reason,
    hinweis:
      'Dem Nutzer wird jetzt eine Verbindungs-Karte angezeigt. Bei nativen Anbietern meldet er sich direkt beim Anbieter an; Zugangsdaten sind für dich unsichtbar. Sage das in EINEM Satz und warte nicht auf die Verbindung.',
  })
}
