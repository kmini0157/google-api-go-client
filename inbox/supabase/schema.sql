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
  note        text,                       -- user's own note (embedded for search)
  tags        text[]      default '{}',
  embedding   vector(384),                -- all-MiniLM-L6-v2 dimension
  read        boolean     default false,
  favorite    boolean     default false,
  created_at  timestamptz default now()
);

-- Migration for databases created before the note column existed.
alter table public.items add column if not exists note text;

-- One row per user+url so re-saving updates instead of duplicating.
create unique index if not exists items_user_url_idx
  on public.items (user_id, url);

-- Approximate-nearest-neighbour index for fast semantic search.
-- HNSW (not ivfflat): ivfflat trains its centroids at CREATE INDEX time, so
-- building it on this freshly-created empty table would leave it permanently
-- degenerate (silently bad recall until a manual REINDEX). HNSW builds its
-- graph incrementally as rows arrive, so it is correct from day one.
create index if not exists items_embedding_idx
  on public.items using hnsw (embedding vector_cosine_ops);

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
--
-- hnsw.iterative_scan (pgvector >= 0.8, present on current Supabase): without
-- it, an ANN scan collects the *globally* nearest candidates first and only
-- then applies the user_id filter — in a multi-tenant table almost all
-- candidates belong to other users, so a user gets far fewer than match_count
-- results (often zero) despite having many on-topic items. Iterative scan
-- keeps searching until enough rows survive the filter.
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
  note text,
  tags text[],
  read boolean,
  favorite boolean,
  created_at timestamptz,
  similarity float
)
language sql
stable
security invoker
set hnsw.iterative_scan = 'relaxed_order'
as $$
  select
    i.id, i.url, i.title, i.summary, i.note, i.tags, i.read, i.favorite, i.created_at,
    1 - (i.embedding <=> query_embedding) as similarity
  from public.items i
  where i.user_id = auth.uid()
    and i.embedding is not null
    and 1 - (i.embedding <=> query_embedding) > similarity_threshold
  order by i.embedding <=> query_embedding
  limit match_count;
$$;

-- 5. Usage counter for the free/pro gate -----------------------------------
-- Append-only event log, populated by trigger on every item INSERT. Counting
-- events (not surviving rows) means delete-and-resave cannot bypass the
-- monthly cap. Updates (re-saving an existing URL) don't fire the trigger,
-- so refreshing an already-saved link never consumes quota.
create table if not exists public.save_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  created_at timestamptz default now()
);

create index if not exists save_events_user_created_idx
  on public.save_events (user_id, created_at desc);

alter table public.save_events enable row level security;

drop policy if exists "own save events" on public.save_events;
create policy "own save events"
  on public.save_events
  for select
  using (auth.uid() = user_id);
-- No insert/update/delete policies: clients can't write this table directly;
-- only the trigger below (security definer) appends to it.

create or replace function public.log_save_event ()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.save_events (user_id) values (new.user_id);
  return new;
end;
$$;

drop trigger if exists items_log_save on public.items;
create trigger items_log_save
  after insert on public.items
  for each row execute function public.log_save_event();

-- Counts a user's save events in the current calendar month. The month
-- boundary is deliberately UTC (documented in the UI copy): a global quota
-- reset time that is the same for everyone beats a server-timezone accident.
create or replace function public.saves_this_month ()
returns int
language sql
stable
security invoker
as $$
  select count(*)::int
  from public.save_events
  where user_id = auth.uid()
    and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
$$;

-- 6. Ask-your-inbox usage metering ------------------------------------------
-- Unlike saves, the ask LLM call runs entirely client-side, so this cap is
-- advisory (a determined user could skip logging). That's acceptable: the
-- metered resource costs us nothing — the cap exists as a conversion nudge,
-- not to protect infrastructure. Clients insert their own rows (RLS-checked).
create table if not exists public.ask_events (
  id         bigint generated always as identity primary key,
  user_id    uuid not null,
  created_at timestamptz default now()
);

create index if not exists ask_events_user_created_idx
  on public.ask_events (user_id, created_at desc);

alter table public.ask_events enable row level security;

drop policy if exists "own ask events select" on public.ask_events;
create policy "own ask events select"
  on public.ask_events
  for select
  using (auth.uid() = user_id);

drop policy if exists "own ask events insert" on public.ask_events;
create policy "own ask events insert"
  on public.ask_events
  for insert
  with check (auth.uid() = user_id);

-- Clients insert these rows directly, so pin the fields server-side: a
-- crafted insert can't backdate/forward-date created_at (which would skew
-- the monthly count) or spoof user_id past the policy.
create or replace function public.pin_ask_event ()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.user_id := auth.uid();
  new.created_at := now();
  return new;
end;
$$;

drop trigger if exists ask_events_pin on public.ask_events;
create trigger ask_events_pin
  before insert on public.ask_events
  for each row execute function public.pin_ask_event();

create or replace function public.asks_this_month ()
returns int
language sql
stable
security invoker
as $$
  select count(*)::int
  from public.ask_events
  where user_id = auth.uid()
    and created_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc';
$$;

-- 7. Profiles / Pro tier ------------------------------------------------------
-- is_pro is flipped ONLY by the service role (Stripe webhook or manual) which
-- bypasses RLS; clients can read their own flag but never write it.
create table if not exists public.profiles (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  is_pro     boolean not null default false,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;

drop policy if exists "own profile select" on public.profiles;
create policy "own profile select"
  on public.profiles
  for select
  using (auth.uid() = user_id);

-- Auto-create a profile row for every new auth user.
create or replace function public.handle_new_user ()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (user_id) values (new.id)
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_pro ()
returns boolean
language sql
stable
security invoker
as $$
  select coalesce(
    (select p.is_pro from public.profiles p where p.user_id = auth.uid()),
    false
  );
$$;

-- 8. Digest preferences (ntfy push) ------------------------------------------
create table if not exists public.digest_prefs (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  ntfy_topic text,
  updated_at timestamptz default now()
);

alter table public.digest_prefs enable row level security;

drop policy if exists "own digest prefs" on public.digest_prefs;
create policy "own digest prefs"
  on public.digest_prefs
  for all
  using  (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Related items for the weekly digest: older saves similar to the user's
-- newest unread one. SECURITY DEFINER because the digest worker (service
-- role) computes this for arbitrary users; client roles cannot execute it,
-- so it never becomes a cross-user read primitive.
create or replace function public.related_items (p_user uuid, p_limit int default 3)
returns table (url text, title text, summary text, similarity float)
language sql
stable
security definer
set search_path = public
as $$
  with newest as (
    select i.id, i.embedding
    from public.items i
    where i.user_id = p_user and i.read = false and i.embedding is not null
    order by i.created_at desc
    limit 1
  )
  select i.url, i.title, i.summary,
         1 - (i.embedding <=> n.embedding) as similarity
  from public.items i
  cross join newest n
  where i.user_id = p_user
    and i.id <> n.id
    and i.embedding is not null
  order by i.embedding <=> n.embedding
  limit p_limit;
$$;

revoke execute on function public.related_items(uuid, int) from public, anon, authenticated;
grant execute on function public.related_items(uuid, int) to service_role;

-- 9. Public collections --------------------------------------------------------
-- The acquisition loop: a user shares a curated collection; the public page
-- carries a "start your own Inbox" CTA. id and slug are generated client-side
-- (crypto.randomUUID / random hex) so inserts need no RETURNING round-trip.
create table if not exists public.collections (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  title      text not null,
  slug       text not null unique,
  is_public  boolean not null default false,
  created_at timestamptz default now()
);

create unique index if not exists collections_user_title_idx
  on public.collections (user_id, title);

alter table public.collections enable row level security;

drop policy if exists "collections owner or public read" on public.collections;
create policy "collections owner or public read"
  on public.collections
  for select
  using (auth.uid() = user_id or is_public);

drop policy if exists "collections owner write" on public.collections;
create policy "collections owner write"
  on public.collections
  for insert
  with check (auth.uid() = user_id);

drop policy if exists "collections owner update" on public.collections;
create policy "collections owner update"
  on public.collections
  for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "collections owner delete" on public.collections;
create policy "collections owner delete"
  on public.collections
  for delete
  using (auth.uid() = user_id);

create table if not exists public.collection_items (
  collection_id uuid not null references public.collections (id) on delete cascade,
  item_id       uuid not null references public.items (id) on delete cascade,
  added_at      timestamptz default now(),
  primary key (collection_id, item_id)
);

alter table public.collection_items enable row level security;

drop policy if exists "collection items visible with collection" on public.collection_items;
create policy "collection items visible with collection"
  on public.collection_items
  for select
  using (exists (
    select 1 from public.collections c
    where c.id = collection_id and (c.user_id = auth.uid() or c.is_public)
  ));

-- Insert requires owning BOTH the collection and the item — you can't
-- publish someone else's saves into your collection.
drop policy if exists "collection items owner insert" on public.collection_items;
create policy "collection items owner insert"
  on public.collection_items
  for insert
  with check (
    exists (select 1 from public.collections c
            where c.id = collection_id and c.user_id = auth.uid())
    and
    exists (select 1 from public.items i
            where i.id = item_id and i.user_id = auth.uid())
  );

drop policy if exists "collection items owner delete" on public.collection_items;
create policy "collection items owner delete"
  on public.collection_items
  for delete
  using (exists (
    select 1 from public.collections c
    where c.id = collection_id and c.user_id = auth.uid()
  ));

-- Anonymous share-page accessor: items RLS is owner-only, so the public page
-- reads through this definer function, gated hard on is_public.
create or replace function public.public_collection (p_slug text)
returns table (
  collection_title text,
  url text,
  item_title text,
  summary text,
  tags text[]
)
language sql
stable
security definer
set search_path = public
as $$
  select c.title, i.url, i.title, i.summary, i.tags
  from public.collections c
  join public.collection_items ci on ci.collection_id = c.id
  join public.items i on i.id = ci.item_id
  where c.slug = p_slug
    and c.is_public
  order by ci.added_at desc;
$$;

grant execute on function public.public_collection(text) to anon, authenticated;
