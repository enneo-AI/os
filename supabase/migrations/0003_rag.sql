-- enneo OS — RAG: pgvector-Chunks für semantische Wiki-Suche (2026-07-04)
-- Embeddings: gte-small (384 Dim.) via Supabase Edge Function "embed" (eingebaut, kostenlos)

create extension if not exists vector;

create table wiki_chunks (
  id uuid primary key default gen_random_uuid(),
  page_id uuid not null references wiki_pages (id) on delete cascade,
  slug text not null,
  title text not null,
  chunk_index int not null,
  content text not null,
  embedding vector(384),
  created_at timestamptz not null default now(),
  unique (page_id, chunk_index)
);

create index wiki_chunks_embedding_idx on wiki_chunks
  using hnsw (embedding vector_cosine_ops);

alter table wiki_chunks enable row level security;
create policy wc_select on wiki_chunks for select to authenticated using (true);
-- Inserts/Updates nur via Backend/Indexer (service_role)

-- Ähnlichkeitssuche fürs Backend
create or replace function match_wiki_chunks(
  query_embedding vector(384),
  match_count int default 8
) returns table (slug text, title text, chunk_index int, content text, similarity float)
language sql stable as $$
  select c.slug, c.title, c.chunk_index, c.content,
         1 - (c.embedding <=> query_embedding) as similarity
  from wiki_chunks c
  where c.embedding is not null
  order by c.embedding <=> query_embedding
  limit match_count
$$;
