-- enneo OS — Slack als native Connector-Art (2026-07-09)
-- Read-only Lesezugang zu Slack-Channels via Bot-Token (kind='slack', Tools in src/tools/slack.js).

alter table connectors drop constraint if exists connectors_kind_check;
alter table connectors add constraint connectors_kind_check
  check (kind in ('mcp', 'attio', 'slack'));
