# enneo OS — Konzept (Kurzfassung)

Stand 2026-07-03. Langfassung + Dust.tt-Doku-Analyse liegen im claude-team-Repo (`ai-team/agents/enni-enneo/knowledge/company-os-dust-research.md`, `knowledge.md` §89).

## Produkt in einem Satz

Ein internes AI-Betriebssystem für ~20 enneo-Mitarbeiter:innen: **Enni**, ein selbstlernender Agent mit massivem enneo-Wissen, unterstützt jede Abteilung — plus ein **Wiki** als Notion-Ersatz und eine schlanke **Verwaltung**.

## Warum ein Agent statt vieler

Nutzer wollen nicht vor jeder Frage einen Agent auswählen. Unter der Haube bleibt Struktur:
- **Skills** — Abteilungs-Expertise wird je Frage lazy geladen (gegen Kontext-Verwässerung)
- **Rechte pro Nutzer** — Enni läuft mit den Credentials der fragenden Person; Quellen sind Space-gebunden
- **Routinen** — geplante Aufgaben (Weekly Digest, Sync-Checks) sind Enni-Jobs mit Owner, keine eigenen Agenten

## Selbstlernen (Kern-Differenzierer)

Enni schlägt Wissens-Updates als **Diff auf Wiki-Seiten** vor. Ein Mensch gibt frei, nie Auto-Apply. Jede Übernahme ist im Audit-Log attribuiert. So wächst das Firmenwissen kuratiert mit — das können Kauf-Alternativen (Dust.tt) nicht kernmäßig.

## Abgrenzung zu Slack

Slack bleibt Kommunikation: News (#general, #learning), Alerts (#sre-alerts, #issues), Kunden-Channels, Kultur. enneo OS baut davon nichts nach — kein Feed, keine Posts, keine Notifications. Slack ist höchstens read-only-Wissensquelle.

## Pods (Phase 2, von Dust übernommen)

Gemeinsame Konversations-Räume mit Zugriff **Open** (ganze Org) oder **Restricted** (eingeladene Mitglieder). Enni liest in Pods nur Quellen, die alle Mitglieder sehen dürfen.

## Governance von Tag 1 (auch bei 20 Nutzern)

- **Tool Stakes:** High-Stake-Aktionen (CRM-Writes) brauchen Freigabe, pro Agent merkbar
- **Audit-Trail** mit Mensch/KI-Attribution und ausgelöster Person
- **Kosten transparent:** Euro-Betrag an jeder Antwort, `llm_usage`-Tabelle, Monats-Cap für Routinen
- **Analytics metadata-only** — Inhalte werden nie ausgewertet (Überwachungs-Einwand)

## Build vs. Buy

Dust.tt deckt ~70-80 % ab (≈ 5.500 €/Jahr für 20 Seats), kann aber das kuratierte organisationale Lernen nicht und bindet an fremde Roadmap. Empfehlung: Eigenbau mit Dogfooding-Argument — eine AI-Firma kauft ihr internes AI-OS nicht ein. Dust-Patterns (Tool Stakes, Views als Permission-Schicht, Diff-Approval, Wake-up-Guardrails) übernehmen wir gezielt.
