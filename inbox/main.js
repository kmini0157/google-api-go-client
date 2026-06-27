// Inbox — UI wiring. Renders auth, the save bar, search, and the item list.
import {
  saveUrl, search, toggleField, remove, auth, bindStatus, onPaywall,
} from "./app.js";

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
  status: $("#status"),
  list: $("#list"),
  paywall: $("#paywall"),
  closePaywall: $("#close-paywall"),
};

bindStatus(els.status);
onPaywall(() => els.paywall.classList.remove("hidden"));
els.closePaywall.onclick = () => els.paywall.classList.add("hidden");

// --- Auth flow -------------------------------------------------------------
auth.onChange((user) => {
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
    els.authMsg.textContent = "Check your email for the sign-in link ✉️";
  } catch (e) {
    els.authMsg.textContent = e.message;
  }
};

els.signout.onclick = () => auth.signOut();

// --- Save ------------------------------------------------------------------
els.saveBtn.onclick = doSave;
els.urlInput.addEventListener("keydown", (e) => e.key === "Enter" && doSave());

async function doSave() {
  const url = els.urlInput.value;
  if (!url.trim()) return;
  els.saveBtn.disabled = true;
  try {
    await saveUrl(url);
    els.urlInput.value = "";
    await refresh();
  } catch (e) {
    els.status.textContent = "⚠️ " + e.message;
  } finally {
    els.saveBtn.disabled = false;
  }
}

// --- Search (debounced) ----------------------------------------------------
let searchTimer;
els.searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(refresh, 350);
});

async function refresh() {
  try {
    const items = await search(els.searchInput.value);
    render(items);
  } catch (e) {
    els.status.textContent = "⚠️ " + e.message;
  }
}

function render(items) {
  els.list.innerHTML = "";
  if (!items.length) {
    els.list.innerHTML = `<p class="empty">Nothing here yet. Paste a link above to start your inbox.</p>`;
    return;
  }
  for (const it of items) {
    const card = document.createElement("article");
    card.className = "card" + (it.read ? " read" : "");
    const tags = (it.tags || []).map((t) => `<span class="tag">${t}</span>`).join("");
    const sim = it.similarity != null ? `<span class="sim">${Math.round(it.similarity * 100)}%</span>` : "";
    card.innerHTML = `
      <div class="card-head">
        <a href="${it.url}" target="_blank" rel="noopener" class="title">${it.title || it.url}</a>
        ${sim}
      </div>
      <p class="summary">${it.summary || ""}</p>
      <div class="tags">${tags}</div>
      <div class="actions">
        <button data-act="fav">${it.favorite ? "★" : "☆"}</button>
        <button data-act="read">${it.read ? "Mark unread" : "Mark read"}</button>
        <button data-act="del">Delete</button>
      </div>`;
    card.querySelector('[data-act="fav"]').onclick = async () => {
      await toggleField(it.id, "favorite", !it.favorite);
      refresh();
    };
    card.querySelector('[data-act="read"]').onclick = async () => {
      await toggleField(it.id, "read", !it.read);
      refresh();
    };
    card.querySelector('[data-act="del"]').onclick = async () => {
      await remove(it.id);
      refresh();
    };
    els.list.appendChild(card);
  }
}

// --- PWA share target: ?url=... from "Share to Inbox" ----------------------
async function handleSharedUrl() {
  const shared = new URLSearchParams(location.search).get("url");
  if (shared) {
    els.urlInput.value = shared;
    history.replaceState({}, "", location.pathname);
    await doSave();
  }
}

// Register the service worker for offline + share-target support.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
