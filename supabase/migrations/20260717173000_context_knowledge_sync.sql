-- Context-shaped Wiki proposals must also appear in the Context library.
-- knowledge_update_id identifies the personal pending mirror; wiki_page_id
-- keeps the published Context tied to its canonical Wiki/RAG source.

alter table public.contexts
  add column if not exists wiki_page_id uuid references public.wiki_pages(id) on delete set null,
  add column if not exists knowledge_update_id uuid references public.knowledge_updates(id) on delete cascade;

create unique index if not exists contexts_knowledge_update_idx
  on public.contexts(knowledge_update_id);

create index if not exists contexts_wiki_page_idx
  on public.contexts(wiki_page_id)
  where wiki_page_id is not null;
