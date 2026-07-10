// Inbox — UI wiring. Renders auth, the save bar, search, and the item list.
import {
  saveUrl, search, askInbox, toggleField, updateNote, remove, shareToCollection,
  auth, bindStatus, onPaywall, IS_DEMO,
} from "./app.js";
import { cfg } from "./client.js";

const $ = (sel) => document.querySelector(sel);

const els = {
  app: $("#app"),
  authView: $("#auth-view"),
  mainView: $("#main-view"),
  email: $("#email"),
  signin: $("#signin"),
  authMsg: $("#auth-msg"),
  signout: $("#signout"),
  urlInput: $("#url-input"),
  saveBtn: $("#save-btn"),
  searchInput: $("#search-input"),
  askInput: $("#ask-input"),
  askBtn: $("#ask-btn"),
  answer: $("#answer"),
  status: $("#status"),
  list: $("#list"),
  paywall: $("#paywall"),
  closePaywall: $("#close-paywall"),
};

bindStatus(els.status);
onPaywall(() => els.paywall.classList.remove("hidden"));
els.closePaywall.onclick = () => els.paywall.classList.add("hidden");

// Wire the paywall CTA to the Stripe Payment Link when one is configured.
const proCta = document.querySelector("#pro-cta");
if (cfg.STRIPE_PAYMENT_LINK) {
  proCta.href = cfg.STRIPE_PAYMENT_LINK;
}

// Demo mode: zero-setup, everything stays in this browser.
if (IS_DEMO) {
  const banner = document.createElement("div");
  banner.className = "demo-banner";
  banner.textContent =
    "🧪 Demo mode — your data stays in this browser. Sign in with any email (instant, no mail sent). Connect Supabase for sync & the weekly digest.";
  document.querySelector("#app").prepend(banner);
  els.email.placeholder = "any@email.works";
}

// --- Auth flow -------------------------------------------------------------
// Supabase fires SIGNED_IN / TOKEN_REFRESHED repeatedly (e.g. on tab refocus);
// only react when the signed-in user actually changes, so we don't reset the
// list mid-session.
let currentUserId = null;
auth.onChange((user) => {
  const uid = user?.id ?? null;
  if (uid === currentUserId) return;
  currentUserId = uid;
  // The answer panel holds private data (titles/URLs from the previous
  // account's saves) — never let it survive an account switch or sign-out.
  els.answer.classList.add("hidden");
  els.answer.textContent = "";
  els.askInput.value = "";
  if (user) {
    els.authView.classList.add("hidden");
    els.mainView.classList.remove("hidden");
    refresh();
    handleSharedUrl();
  } else {
    els.mainView.classList.add("hidden");
    els.authView.classList.remove("hidden");
  }
});

els.signin.onclick = async () => {
  try {
    await auth.signIn(els.email.value.trim());
    els.authMsg.textContent = IS_DEMO
      ? "Signed in — demo session, no email sent ✓"
      : "Check your email for the sign-in link ✉️";
  } catch (e) {
    els.authMsg.textContent = e.message;
  }
};

els.signout.onclick = () => auth.signOut();

// --- Save ------------------------------------------------------------------
// isComposing guard: with a Korean/Japanese IME, the Enter that commits the
// composition fires a keydown too — it must not submit.
els.saveBtn.onclick = doSave;
els.urlInput.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && doSave());

let saving = false; // guards the Enter-key path too, not just the button
async function doSave() {
  if (saving || asking) return; // see doAsk: shared #status, no interleaving
  const url = els.urlInput.value;
  if (!url.trim()) return;
  saving = true;
  els.saveBtn.disabled = true;
  try {
    await saveUrl(url);
    els.urlInput.value = "";
    await refresh();
  } catch (e) {
    els.status.textContent = "⚠️ " + e.message;
  } finally {
    saving = false;
    els.saveBtn.disabled = false;
  }
}

// --- Ask-your-inbox ----------------------------------------------------------
els.askBtn.onclick = doAsk;
els.askInput.addEventListener("keydown", (e) => e.key === "Enter" && !e.isComposing && doAsk());

let asking = false;
async function doAsk() {
  // Mutual exclusion with doSave: both flows narrate through the single
  // #status element, so letting them interleave stomps each other's progress
  // messages mid-await.
  if (asking || saving) return;
  const q = els.askInput.value.trim();
  if (!q) return;
  asking = true;
  els.askBtn.disabled = true;
  els.answer.classList.remove("hidden");
  els.answer.textContent = "Thinking…";
  try {
    const { answer, sources } = await askInbox(q);
    renderAnswer(answer, sources);
  } catch (e) {
    els.answer.classList.add("hidden");
    els.status.textContent = "⚠️ " + e.message;
  } finally {
    asking = false;
    els.askBtn.disabled = false;
  }
}

// The answer is LLM output over external content — render it as text only,
// same rule as render() below.
function renderAnswer(answer, sources) {
  els.answer.textContent = "";
  els.answer.appendChild(el("p", "answer-text", answer));
  if (sources.length) {
    const box = el("div", "answer-sources");
    sources.forEach((s, i) => {
      const label = `[${i + 1}] ${s.title || s.url}`;
      const href = safeHttpUrl(s.url);
      if (href) {
        const a = el("a", "src", label);
        a.href = href;
        a.target = "_blank";
        a.rel = "noopener";
        box.appendChild(a);
      } else {
        box.appendChild(el("span", "src", label));
      }
    });
    els.answer.appendChild(box);
  }
}

// --- Search (debounced) ----------------------------------------------------
let searchTimer;
els.searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 350);
});

// Sequence searches: results from a superseded (older) query must never
// overwrite the results of a newer one, whatever order the promises resolve.
let searchSeq = 0;
async function refresh() {
  const seq = ++searchSeq;
  const query = els.searchInput.value;
  try {
    const items = await search(query);
    if (seq !== searchSeq) return; // stale response — a newer search is in flight
    render(items, query);
  } catch (e) {
    if (seq === searchSeq) els.status.textContent = "⚠️ " + e.message;
  }
}

// Only ever link http(s) URLs; anything else (javascript:, data:, malformed)
// renders as plain text.
function safeHttpUrl(u) {
  try {
    const p = new URL(u);
    return p.protocol === "http:" || p.protocol === "https:" ? p.href : null;
  } catch {
    return null;
  }
}

// el("span", "tag", text) — build DOM with textContent, never innerHTML.
// title/summary/tags/url all originate from EXTERNAL content (fetched pages,
// LLM output), so any string interpolation into markup is stored XSS.
function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// First-session aha flow: an empty inbox shows curated starter links so a new
// user can experience save -> search success immediately. Clicking one fills
// the save bar (the user still presses Save — no surprise writes).
const STARTERS = [
  { url: "https://jamesclear.com/atomic-habits-summary", label: "Atomic Habits — the summary worth keeping" },
  { url: "https://waitbutwhy.com/2015/01/artificial-intelligence-revolution-1.html", label: "The AI Revolution (Wait But Why)" },
  { url: "https://paulgraham.com/greatwork.html", label: "How to Do Great Work — Paul Graham" },
];

function starterBlock() {
  const box = el("div", "starter");
  box.appendChild(el("h3", "starter-title", "Start your inbox"));
  box.appendChild(el("p", "starter-hint",
    "Save 3 articles, then try searching by meaning — that's the moment it clicks. Pick one to prefill:"));
  for (const s of STARTERS) {
    const b = el("button", "starter-use", s.label);
    b.onclick = () => {
      els.urlInput.value = s.url;
      els.urlInput.focus();
    };
    box.appendChild(b);
  }
  return box;
}

function render(items, query = "") {
  els.list.textContent = "";
  if (!items.length) {
    if (query.trim()) {
      els.list.appendChild(el("p", "empty", "No matches for that search."));
    } else {
      els.list.appendChild(starterBlock());
    }
    return;
  }
  for (const it of items) {
    const card = el("article", "card" + (it.read ? " read" : ""));

    const head = el("div", "card-head");
    const href = safeHttpUrl(it.url);
    let title;
    if (href) {
      title = el("a", "title", it.title || it.url);
      title.href = href;
      title.target = "_blank";
      title.rel = "noopener";
    } else {
      title = el("span", "title", it.title || it.url);
    }
    head.appendChild(title);
    if (it.similarity != null) {
      head.appendChild(el("span", "sim", Math.round(it.similarity * 100) + "%"));
    }
    card.appendChild(head);

    card.appendChild(el("p", "summary", it.summary || ""));

    if (it.note) card.appendChild(el("p", "note", "📝 " + it.note));

    const tags = el("div", "tags");
    for (const t of it.tags || []) tags.appendChild(el("span", "tag", t));
    card.appendChild(tags);

    const actions = el("div", "actions");
    const mkBtn = (act, label, handler) => {
      const b = el("button", null, label);
      b.dataset.act = act;
      b.onclick = handler;
      actions.appendChild(b);
    };
    mkBtn("fav", it.favorite ? "★" : "☆", async () => {
      await toggleField(it.id, "favorite", !it.favorite);
      refresh();
    });
    mkBtn("read", it.read ? "Mark unread" : "Mark read", async () => {
      await toggleField(it.id, "read", !it.read);
      refresh();
    });
    mkBtn("note", it.note ? "Edit note" : "Add note", () => {
      if (card.querySelector(".note-editor")) return; // one editor at a time
      const editor = el("div", "note-editor");
      const ta = el("textarea", "note-input");
      ta.value = it.note || "";
      ta.placeholder = "Your note — it becomes searchable too";
      const save = el("button", "note-save", "Save note");
      save.onclick = async () => {
        save.disabled = true;
        try {
          await updateNote(it.id, ta.value.trim());
          refresh();
        } catch (e) {
          els.status.textContent = "⚠️ " + e.message;
          save.disabled = false;
        }
      };
      editor.appendChild(ta);
      editor.appendChild(save);
      card.appendChild(editor);
      ta.focus();
    });
    mkBtn("share", "Share", async () => {
      const name = prompt("Add to public collection:", "My reading list");
      if (!name) return;
      try {
        const link = await shareToCollection(it.id, name);
        els.status.textContent = "Public collection link: " + link;
      } catch (e) {
        els.status.textContent = "⚠️ " + e.message;
      }
    });
    mkBtn("del", "Delete", async () => {
      await remove(it.id);
      refresh();
    });
    card.appendChild(actions);

    els.list.appendChild(card);
  }
}

// --- PWA share target -------------------------------------------------------
// Android share sheets often put the link inside `text` (sometimes with
// surrounding prose) rather than `url`, so scan all shared fields for the
// first http(s) URL instead of trusting `url` alone.
async function handleSharedUrl() {
  const p = new URLSearchParams(location.search);
  const haystack = [p.get("url"), p.get("text"), p.get("title")].filter(Boolean).join(" ");
  const m = haystack.match(/https?:\/\/\S+/);
  if (m) {
    els.urlInput.value = m[0];
    history.replaceState({}, "", location.pathname);
    await doSave();
  }
}

// Register the service worker for offline + share-target support.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
