// Copy to config.js and fill in. config.js is git-ignored.
// All of these are PUBLIC client-side values — the Supabase anon key is safe
// to ship because Row-Level Security (see supabase/schema.sql) enforces access.
window.INBOX_CONFIG = {
  // From your Supabase project: Settings -> API
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-KEY",

  // Free-tier limits. Set to Infinity for self-host / unlimited.
  FREE_SAVES_PER_MONTH: 30,
  FREE_ASKS_PER_MONTH: 10,

  // Jina Reader endpoint (no key needed). Leave as-is.
  JINA_READER: "https://r.jina.ai/",

  // Stripe Payment Link for the Pro upgrade (create one in the Stripe
  // dashboard; no server code needed). Leave empty to hide the checkout link.
  STRIPE_PAYMENT_LINK: "",
};
