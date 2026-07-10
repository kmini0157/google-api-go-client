// Shared client bootstrap: decides between the real Supabase backend and the
// zero-setup demo adapter, and normalizes config defaults. Used by both the
// app (app.js) and the public collection page (collection.js).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createLocalClient } from "./local-adapter.js";

export const cfg = {
  FREE_SAVES_PER_MONTH: 30,
  FREE_ASKS_PER_MONTH: 10,
  JINA_READER: "https://r.jina.ai/",
  STRIPE_PAYMENT_LINK: "",
  ...(window.INBOX_CONFIG || {}),
};

// Demo mode when: no config.js at all, the placeholder was never filled, or
// ?demo=1 forces it. Demo keeps everything in this browser's localStorage.
export const IS_DEMO =
  new URLSearchParams(location.search).has("demo") ||
  !window.INBOX_CONFIG ||
  !cfg.SUPABASE_URL ||
  cfg.SUPABASE_URL.includes("YOUR-PROJECT");

export const sb = IS_DEMO
  ? createLocalClient()
  : createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
