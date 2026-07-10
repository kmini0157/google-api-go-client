#!/usr/bin/env sh
# Run the Inbox demo locally with ZERO setup — no accounts, no keys.
# Data stays in your browser (localStorage). Requires python3 or Node.
cd "$(dirname "$0")" || exit 1
echo "📥 Inbox demo → http://localhost:8080  (Ctrl+C to stop)"
python3 -m http.server 8080 2>/dev/null || npx serve -l 8080 .
