-- Inbox — Supabase schema
-- Run this in the Supabase SQL editor (or `supabase db push`).
-- Provides: pgvector storage, per-user row-level security, and a
-- cosine-similarity search RPC the client calls for natural-language search.

-- 1. Extensions ------------------------------------------------------------
create extension if not exists vector;

-- 2. Tables ----------------------------------------------------------------
create table if not exists public.items (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  url         text not null,
  title       text,
  summary     text,
  content     text,                       -- cleaned article text (from Jina)
  tags        text[]      default '{}',
  embedding   vector(384),                -- all-MiniLM-L6-v2 dimension
  read        boolean     default false,
  favorite    boolean     default false,
  created_at  timestamptz default now()
);

-- One row per user+url so re-saving updates instead of duplicating.
create unique index if not exists items_user_url_idx
  on public.items (user_id, url);

-- Approximate-nearest-neighbour index for fast semantic search.
create index if not exists items_embedding_idx
  on public.items using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

create index if not exists items_user_created_idx
  on public.items (user_id, created_at desc);

-- 3. Row-level security: a user only ever sees their own rows -------------
alter table public.items enable row level security;

drop policy if exists "items are private" on public.items;
create policy "items are private"
  on public.items
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 4. Semantic search RPC ---------------------------------------------------
-- The client computes the query embedding locally (Transformers.js) and
-- passes it here. SECURITY INVOKER keeps RLS in force, so this only ever
-- searches the caller's own items.
create or replace function public.match_items (
  query_embedding vector(384),
  match_count     int default 20,
  similarity_threshold float default 0.15
)
returns table (
  id uuid,
  url text,
  title text,
  summary text,
  tags text[],
  read boolean,
  favorite boolean,
  created_at timestamptz,
  similarity float
)
language sql
stable
security invoker
as $$
  select
    i.id, i.url, i.title, i.summary, i.tags, i.read, i.favorite, i.created_at,
    1 - (i.embedding <=> query_embedding) as similarity
  from public.items i
  where i.user_id = auth.uid()
    and i.embedding is not null
    and 1 - (i.embedding <=> query_embedding) > similarity_threshold
  order by i.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Usage counter for the free/pro gate -----------------------------------
-- Counts a user's saves in the current calendar month. The client checks
-- this before allowing a save on the free tier.
create or replace function public.saves_this_month ()
returns int
language sql
stable
security invoker
as $$
  select count(*)::int
  from public.items
  where user_id = auth.uid()
    and created_at >= date_trunc('month', now());
$$;
