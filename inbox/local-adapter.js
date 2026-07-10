// Demo-mode storage adapter: implements the small slice of the supabase-js
// surface this app uses, backed by localStorage. Lets anyone run Inbox with
// ZERO setup — no account, no keys. Extraction (Jina), summarization
// (Puter.js), and embeddings (Transformers.js) already run key-free in the
// browser, so storage+auth was the only cloud dependency to replace.
//
// Data never leaves this browser. Connecting a real Supabase project (see
// config.example.js) upgrades to sync, magic-link auth, and the digest.

const KEY = "inbox-demo-v1";

function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) ?? {};
  } catch {
    return {};
  }
}

export function createLocalClient() {
  const state = load();
  state.tables ??= {};
  const tables = state.tables;
  for (const t of ["items", "save_events", "ask_events", "collections", "collection_items"]) {
    tables[t] ??= [];
  }
  let currentUser = state.user ?? null;
  let listener = null;
  let seq = state.seq ?? 0;

  function persist() {
    state.user = currentUser;
    state.seq = seq;
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
    } catch (e) {
      console.warn("demo persist failed (storage full?):", e);
    }
  }

  function monthStartUtc() {
    const d = new Date();
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }

  function cos(a, b) {
    let d = 0;
    for (let i = 0; i < a.length; i++) d += a[i] * b[i];
    return d; // inputs are L2-normalized by the embedder
  }

  function builder(store) {
    let op = "select", payload = null;
    const filters = [];
    let _order = null, _limit = null;
    const api = {
      select() { return api; },
      order(c, o) { _order = { c, asc: !!(o && o.ascending) }; return api; },
      limit(n) { _limit = n; return api; },
      insert(row) { op = "insert"; payload = row; return api; },
      upsert(row) { op = "upsert"; payload = row; return api; },
      update(vals) { op = "update"; payload = vals; return api; },
      delete() { op = "delete"; return api; },
      eq(col, val) { filters.push([col, val]); return api; },
      then(resolve) { resolve(exec()); },
    };
    const matches = (x) => filters.every(([c, v]) => x[c] === v);
    function exec() {
      if (op === "insert") {
        const r = { ...payload, id: payload.id ?? "demo-" + ++seq, created_at: new Date().toISOString() };
        store.push(r);
        persist();
        return { data: [r], error: null };
      }
      if (op === "upsert") {
        const idx = store.findIndex((x) => x.user_id === payload.user_id && x.url === payload.url);
        if (idx >= 0) {
          store[idx] = { ...store[idx], ...payload };
          persist();
          return { data: [store[idx]], error: null };
        }
        const r = {
          ...payload,
          id: "demo-" + ++seq,
          read: false,
          favorite: false,
          created_at: new Date().toISOString(),
        };
        store.push(r);
        // Mirror the schema trigger: fresh inserts consume save quota.
        tables.save_events.push({ user_id: payload.user_id, created_at: r.created_at });
        persist();
        return { data: [r], error: null };
      }
      if (op === "update") {
        const rows = store.filter(matches);
        rows.forEach((x) => Object.assign(x, payload));
        persist();
        return { data: rows, error: null };
      }
      if (op === "delete") {
        for (let i = store.length - 1; i >= 0; i--) if (matches(store[i])) store.splice(i, 1);
        persist();
        return { data: [], error: null };
      }
      let rows = store.filter(matches);
      if (_order) rows = rows.slice().sort((a, b) => (a[_order.c] < b[_order.c] ? 1 : -1) * (_order.asc ? -1 : 1));
      if (_limit != null) rows = rows.slice(0, _limit);
      return { data: rows, error: null };
    }
    return api;
  }

  return {
    auth: {
      async getUser() {
        return { data: { user: currentUser } };
      },
      // Demo sign-in is instant — no email round-trip to wait on.
      async signInWithOtp({ email }) {
        currentUser = { id: "demo-user", email };
        persist();
        if (listener) setTimeout(() => listener("SIGNED_IN", { user: currentUser }), 0);
        return { error: null };
      },
      async signOut() {
        currentUser = null;
        persist();
        if (listener) setTimeout(() => listener("SIGNED_OUT", null), 0);
        return { error: null };
      },
      onAuthStateChange(cb) {
        listener = cb;
        setTimeout(() => cb("INITIAL", currentUser ? { user: currentUser } : null), 0);
        return { data: { subscription: { unsubscribe() {} } } };
      },
    },

    from(name) {
      return builder(tables[name] ?? (tables[name] = []));
    },

    async rpc(name, params = {}) {
      const uid = currentUser && currentUser.id;
      if (name === "is_pro") return { data: false, error: null };
      if (name === "saves_this_month" || name === "asks_this_month") {
        const store = name === "saves_this_month" ? tables.save_events : tables.ask_events;
        const n = store.filter(
          (x) => x.user_id === uid && Date.parse(x.created_at) >= monthStartUtc()
        ).length;
        return { data: n, error: null };
      }
      if (name === "match_items") {
        const q = params.query_embedding;
        const th = params.similarity_threshold ?? 0.15;
        const rows = tables.items
          .filter((x) => x.user_id === uid && x.embedding)
          .map((x) => ({ ...x, similarity: cos(q, x.embedding) }))
          .filter((x) => x.similarity > th)
          .sort((a, b) => b.similarity - a.similarity)
          .slice(0, params.match_count ?? 20);
        return { data: rows, error: null };
      }
      if (name === "public_collection") {
        const col = tables.collections.find((c) => c.slug === params.p_slug && c.is_public);
        if (!col) return { data: [], error: null };
        const rows = tables.collection_items
          .filter((ci) => ci.collection_id === col.id)
          .map((ci) => {
            const i = tables.items.find((x) => x.id === ci.item_id);
            return i && {
              collection_title: col.title,
              url: i.url,
              item_title: i.title,
              summary: i.summary,
              tags: i.tags,
            };
          })
          .filter(Boolean);
        return { data: rows, error: null };
      }
      return { data: null, error: { message: "unknown rpc " + name } };
    },
  };
}
