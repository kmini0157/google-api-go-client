// Weekly digest — Cloudflare Worker (cron-triggered).
// This is the retention loop: every week it surfaces a user's unread saves so
// they come back. Email via Resend, optional push via ntfy.
//
// Deploy with `wrangler deploy` using the wrangler.toml in this folder.
// Secrets (set via `wrangler secret put`):
//   SUPABASE_URL, SUPABASE_SERVICE_KEY (service role — server-only, never ship
//   to the client), RESEND_API_KEY.
//
// Trigger: cron "0 14 * * 1" (Mondays 14:00 UTC) — set in wrangler.toml.

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      runDigest(env).catch((e) => {
        // Surface a failed run in the Workers logs instead of dying silently.
        console.error("digest run failed:", e);
        throw e;
      })
    );
  },
  // Manual trigger for testing: GET /run
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/run") {
      try {
        const { sent, failed } = await runDigest(env);
        return new Response(`Sent ${sent} digests (${failed} failed)`);
      } catch (e) {
        return new Response("Digest run failed: " + e.message, { status: 500 });
      }
    }
    return new Response("Inbox digest worker. POST cron or GET /run.", { status: 200 });
  },
};

async function runDigest(env) {
  // Pull each user's unread items from the last 7 days. Paginated: PostgREST
  // caps un-ranged responses (Supabase default 1000 rows), and since the
  // ordering is global, hitting that cap would silently drop entire users
  // whose newest save ranks past it.
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const rows = await sbAll(
    env,
    `items?read=eq.false&created_at=gte.${since}` +
      `&select=user_id,url,title,summary&order=created_at.desc`
  );

  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    if (byUser.get(r.user_id).length < 5) byUser.get(r.user_id).push(r);
  }

  // Per-user isolation: one bad address or transient Resend error must not
  // abort the rest of the batch.
  let sent = 0, failed = 0;
  for (const [userId, items] of byUser) {
    try {
      const email = await userEmail(env, userId);
      if (!email) continue;
      await sendEmail(env, email, items);
      sent++;
    } catch (e) {
      failed++;
      console.error(`digest failed for user ${userId}:`, e);
    }
  }
  return { sent, failed };
}

// --- Supabase REST helpers (service role) ----------------------------------
// Fetches ALL rows for a query by paging with Range headers. Throws on any
// non-OK response — a half-failed query must fail the run visibly, not
// silently email nobody.
async function sbAll(env, path, pageSize = 1000) {
  const out = [];
  for (let from = 0; ; from += pageSize) {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        Range: `${from}-${from + pageSize - 1}`,
      },
    });
    if (!res.ok) throw new Error(`Supabase query failed (${res.status}) for ${path.split("?")[0]}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out;
}

async function userEmail(env, userId) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  if (!res.ok) return null;
  const u = await res.json();
  return u?.email ?? null;
}

// --- Resend ----------------------------------------------------------------
async function sendEmail(env, to, items) {
  const list = items
    .map((i) => {
      // Escape the URL too — it lands inside an href attribute — and only
      // link http(s) schemes.
      const href = /^https?:\/\//i.test(i.url) ? esc(i.url) : "#";
      return (
        `<li style="margin:0 0 14px"><a href="${href}" style="color:#5d6cf0;font-weight:600;text-decoration:none">${esc(i.title || i.url)}</a><br>` +
        `<span style="color:#777;font-size:14px">${esc(i.summary || "")}</span></li>`
      );
    })
    .join("");
  const html =
    `<div style="font-family:system-ui;max-width:560px;margin:auto">` +
    `<h2>📥 Your weekly Inbox</h2>` +
    `<p style="color:#777">${items.length} unread save${items.length === 1 ? "" : "s"} waiting for you.</p>` +
    `<ul style="list-style:none;padding:0">${list}</ul></div>`;

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: "Inbox <digest@yourdomain.com>",
      to,
      subject: `📥 ${items.length} saves waiting in your Inbox`,
      html,
    }),
  });
  // A non-OK send must count as failed, not sent.
  if (!res.ok) throw new Error(`Resend rejected the email (${res.status})`);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
