-- enneo OS — Turn-Dauer pro Assistant-Message (Codex-Muster "Worked for 54s") (2026-07-13)
alter table messages add column if not exists duration_ms integer;
