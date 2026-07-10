# 📥 Inbox — AI read-it-later that you can't leave

Save any link. It's auto-extracted, summarized, tagged, and embedded so you can
search your saved reading **by meaning** — "that article about burnout" finds it
even if those words never appeared in the title. With **Ask-your-inbox**, you
can ask questions and get answers cited from your own saved corpus — retrieval
is the pgvector index you already have, generation runs client-side, so an
answer costs the server nothing.

The point isn't the features. It's the **moat**: the more you save, the more
valuable *your* personal semantic index becomes, and the more it hurts to leave.
That's the subscription engine.

## Why this is (almost) free to run

Every part of the core pipeline avoids paid API keys:

| Step | Service | Key needed? | Cost |
|------|---------|-------------|------|
| Extract clean article text | **Jina Reader** (`r.jina.ai`) | ❌ | free |
| Summary + tags | **Puter.js** (client-side LLM) | ❌ | free |
| Embeddings (384-dim) | **Transformers.js** (in-browser, local) | ❌ | free |
| Store + auth + vector search | **Supabase** (pgvector + Auth + RLS) | anon key (public, RLS-safe) | free tier |
| Weekly digest email | **Resend** | yes (server-only) | free tier |
| Push (optional) | **ntfy** | ❌ | free |
| Hosting | **Cloudflare Pages** | ❌ | free |

Marginal cost per user is ~0: embeddings and LLM calls run on the user's own
device, not your server.

## Architecture

```
            ┌─────────────── browser (PWA) ───────────────┐
 paste URL  │  Jina Reader → Puter.js LLM → Transformers.js │
   or       │     (extract)    (summary+tags)   (embed)      │
 share-to → │                      │                         │
            │                      ▼                         │
            │        Supabase JS  (upsert + RLS)             │
            └──────────────────────┬───────────────────────┘
                                   │
                       Supabase (Postgres + pgvector)
                                   │
                   match_items() RPC ← semantic search
                                   │
            Cloudflare Worker (cron) → Resend weekly digest
```

## Setup (10 min)

1. **Create a Supabase project** → SQL editor → paste & run
   [`supabase/schema.sql`](supabase/schema.sql). This creates the `items`
   table, pgvector index, row-level security, and the `match_items` /
   `saves_this_month` RPCs.
2. **Configure the client**: `cp config.example.js config.js` and fill in
   `SUPABASE_URL` + `SUPABASE_ANON_KEY` (Settings → API). The anon key is
   public-safe because RLS confines every query to the signed-in user.
3. **Run locally**: any static server, e.g. `npx serve .` then open the URL.
4. **Deploy the app**: push this folder to Cloudflare Pages (no build step).
5. **Deploy the digest** (optional but recommended — it's the retention loop):
   ```
   cd workers
   wrangler secret put SUPABASE_URL
   wrangler secret put SUPABASE_SERVICE_KEY   # service role — server only
   wrangler secret put RESEND_API_KEY
   wrangler deploy
   ```

## Monetization

Free tier is metered by saves/month (`FREE_SAVES_PER_MONTH` in `config.js`,
enforced server-side via the `saves_this_month` RPC). When a user hits it,
they've already built up a personal index they don't want to abandon — that's
when the paywall converts.

**Pro** ($X/mo): unlimited saves · search across everything · weekly digest ·
multi-device sync · highlights & notes (next).

## Roadmap / stickiness levers

- [x] Ask-your-inbox: RAG answers over your saved corpus (shipped — free tier
      metered via `FREE_ASKS_PER_MONTH` / `asks_this_month` RPC)
- [x] Notes on saved items, folded into the embedding so they're searchable
- [x] "Related to what you saved" resurfacing in the weekly digest
- [x] Public/shareable collections with a signup CTA (`collection.html`)
- [x] Pro tier plumbing: `profiles.is_pro` bypasses quotas; paywall CTA links
      to a Stripe Payment Link (see DEPLOY.md for the webhook step)
- [x] ntfy push alongside the digest email (`digest_prefs.ntfy_topic`)
- [x] Onboarding starter links for the first-session save→search aha moment
- [ ] Browser extension (share sheet already works via the PWA share target)

Deploying for real? Follow [DEPLOY.md](DEPLOY.md) — ~40 minutes, ~$1/month.

## Security notes

- The **anon key** ships in the client; never ship the **service key** — it
  bypasses RLS and is used only inside the Cloudflare Worker.
- All item access is gated by RLS (`auth.uid() = user_id`); the search RPC is
  `security invoker` so it can never read another user's rows.
