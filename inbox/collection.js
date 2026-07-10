// Public collection share page. Anonymous readers fetch through the
// public_collection definer RPC (gated on is_public server-side), so no
// login is needed and private items are never reachable.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cfg = window.INBOX_CONFIG;
const sb = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const $ = (sel) => document.querySelector(sel);

// Same rules as the app: external-content strings go through textContent,
// hrefs only for parsed http(s) URLs.
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}
function safeHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
  } catch {
    return null;
  }
}

async function load() {
  const slug = new URLSearchParams(location.search).get("c");
  if (!slug) {
    $("#col-status").textContent = "No collection specified.";
    return;
  }
  const { data, error } = await sb.rpc("public_collection", { p_slug: slug });
  if (error || !data || !data.length) {
    $("#col-status").textContent = "This collection doesn't exist or isn't public.";
    return;
  }
  $("#col-title").textContent = "📚 " + data[0].collection_title;
  document.title = `${data[0].collection_title} — Inbox collection`;
  const list = $("#col-list");
  for (const it of data) {
    const card = el("article", "card");
    const head = el("div", "card-head");
    const href = safeHttpUrl(it.url);
    let title;
    if (href) {
      title = el("a", "title", it.item_title || it.url);
      title.href = href;
      title.target = "_blank";
      title.rel = "noopener";
    } else {
      title = el("span", "title", it.item_title || it.url);
    }
    head.appendChild(title);
    card.appendChild(head);
    card.appendChild(el("p", "summary", it.summary || ""));
    const tags = el("div", "tags");
    for (const t of it.tags || []) tags.appendChild(el("span", "tag", t));
    card.appendChild(tags);
    list.appendChild(card);
  }
}

load();
