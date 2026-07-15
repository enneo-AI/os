// Tool-Registrierung aus dem Chat heraus: Wenn Enni erkennt, dass für eine Aufgabe /
// einen Workflow ein Tool fehlt (CRM nicht verbunden, externer Dienst nötig, MCP-Server
// bekannt), ruft er request_tool_connection auf. Das Frontend rendert daraus eine
// Verbindungs-Karte im Chat (Slack per OAuth, andere Credentials write-only).
// Enni sieht die Credentials NIE — die Karte spricht direkt mit dem Backend.

export const registrationToolDefinitions = [
  {
    name: 'request_tool_connection',
    description:
      'Zeigt dem Nutzer eine Verbindungs-Karte im Chat, um ein fehlendes Tool zu verbinden. Slack nutzt einen sicheren Anbieter-Login; andere Credentials gehen direkt an das System und sind für dich unsichtbar. Nutze das, wenn eine Aufgabe oder ein Skill-Workflow ein Tool braucht, das nicht verbunden ist: kind "attio" (CRM), "slack" (Slack lesen) oder "mcp" (beliebiger MCP-Server per URL). Das Tool wird als persönliches Tool des Nutzers angelegt; teilen fürs Team kann er es danach unter Spaces → Tools.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['attio', 'slack', 'mcp'], description: 'Art der Verbindung' },
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
      'Dem Nutzer wird jetzt eine Verbindungs-Karte im Chat angezeigt. Bei Slack meldet er sich direkt beim Anbieter an; bei anderen Tools trägt er die Zugangsdaten dort sicher ein. Sage das in EINEM Satz und warte nicht auf die Verbindung.',
  })
}
