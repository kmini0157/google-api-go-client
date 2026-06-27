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
    ctx.waitUntil(runDigest(env));
  },
  // Manual trigger for testing: GET /run
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/run") {
      const n = await runDigest(env);
      return new Response(`Sent ${n} digests`);
    }
    return new Response("Inbox digest worker. POST cron or GET /run.", { status: 200 });
  },
};

async function runDigest(env) {
  // Pull each user's top unread items from the last 7 days, grouped by user.
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const rows = await sb(
    env,
    `items?read=eq.false&created_at=gte.${since}` +
      `&select=user_id,url,title,summary&order=created_at.desc`
  );

  // Join to auth emails (admin endpoint).
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    if (byUser.get(r.user_id).length < 5) byUser.get(r.user_id).push(r);
  }

  let sent = 0;
  for (const [userId, items] of byUser) {
    const email = await userEmail(env, userId);
    if (!email) continue;
    await sendEmail(env, email, items);
    sent++;
  }
  return sent;
}

// --- Supabase REST helpers (service role) ----------------------------------
async function sb(env, path) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    },
  });
  return res.ok ? res.json() : [];
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
    .map(
      (i) =>
        `<li style="margin:0 0 14px"><a href="${i.url}" style="color:#5d6cf0;font-weight:600;text-decoration:none">${esc(i.title || i.url)}</a><br><span style="color:#777;font-size:14px">${esc(i.summary || "")}</span></li>`
    )
    .join("");
  const html =
    `<div style="font-family:system-ui;max-width:560px;margin:auto">` +
    `<h2>📥 Your weekly Inbox</h2>` +
    `<p style="color:#777">${items.length} unread save${items.length === 1 ? "" : "s"} waiting for you.</p>` +
    `<ul style="list-style:none;padding:0">${list}</ul></div>`;

  await fetch("https://api.resend.com/emails", {
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
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
