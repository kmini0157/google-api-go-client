// Copy to config.js and fill in. config.js is git-ignored.
// All of these are PUBLIC client-side values — the Supabase anon key is safe
// to ship because Row-Level Security (see supabase/schema.sql) enforces access.
window.INBOX_CONFIG = {
  // From your Supabase project: Settings -> API
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",

  // Free-tier limit. Set to Infinity for self-host / unlimited.
  FREE_SAVES_PER_MONTH: 30,

  // Jina Reader endpoint (no key needed). Leave as-is.
  JINA_READER: "https://r.jina.ai/",
};
