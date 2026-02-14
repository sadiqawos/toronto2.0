# Toronto 2.0

**Trace the code behind your city.**

Citizens share stories about their frustrations with Toronto. We trace each story back to the specific municipal bylaws, zoning provisions, and policies that caused it.

## Setup

```bash
# Install dependencies
npm install

# Configure your API key
cp .env.example .env
# Edit .env and add your Anthropic API key

# Ingest Toronto's municipal codes (one-time, ~10 min)
node ingest-codes.js

# Start the server
npm start
# → http://localhost:3000
```

## Code Ingestion

The ingestion script downloads and indexes Toronto's actual municipal codes into a local SQLite FTS5 database. This means:

- **More accurate traces** — the LLM references real provision text, not hallucinated section numbers
- **~50% lower token usage** — instead of a long system prompt listing every possible source, we search locally and pass only the 5-8 most relevant provisions as context
- **Offline-capable search** — the code database works without API calls

```bash
# Ingest everything (Municipal Code + Zoning By-law + Official Plan)
node ingest-codes.js

# Ingest only one source
node ingest-codes.js --source=municipal_code
node ingest-codes.js --source=zoning_bylaw
node ingest-codes.js --source=official_plan

# Include all chapters (not just priority ones)
node ingest-codes.js --all-chapters

# Check what's been indexed
curl http://localhost:3000/api/codes/stats

# Search the code database directly
curl "http://localhost:3000/api/codes/search?q=parking+minimum"
```

PDFs are cached in `.cache/` so re-running the script won't re-download.

## Architecture

```
toronto2/
├── server.js          # Express backend
│   ├── POST /api/trace        # Generate a trace (local search → Anthropic API)
│   ├── GET  /api/feed         # Paginated feed of published traces
│   ├── GET  /api/trace/:id    # Single trace by ID
│   ├── POST /api/trace/:id/upvote  # Upvote a trace
│   ├── GET  /api/stats        # Aggregate stats (top codes, neighbourhoods)
│   ├── GET  /api/codes/search # Search the code database
│   └── GET  /api/codes/stats  # Code database stats
├── codes-db.js        # SQLite FTS5 code search module
├── ingest-codes.js    # Scraper/parser for municipal code PDFs
├── public/
│   └── index.html     # Single-page frontend
├── toronto2.db        # Stories database (auto-created)
├── codes.db           # Code provisions database (created by ingestion)
├── .cache/            # Cached PDFs (created by ingestion)
├── .env               # API key (not committed)
└── package.json
```

## How Trace Generation Works

1. **Citizen submits a story** → "I was late because the streetcar didn't come"
2. **Local keyword extraction** → maps citizen language to legal terminology ("streetcar" → "transit TTC service")
3. **FTS5 search** → finds the 5-8 most relevant provisions from the indexed code database
4. **LLM call** → sends the story + matched provisions to Claude Sonnet, which selects the 2-3 most relevant and writes human-readable annotations
5. **Storage** → trace is saved and appears in the public feed

This approach is ~50% cheaper per trace than sending a massive system prompt, and produces significantly more accurate references because the LLM is working with real provision text.

## Stack

- **Backend**: Express + better-sqlite3
- **AI**: Anthropic Claude Sonnet (for trace generation)
- **Search**: SQLite FTS5 with porter stemming (for code lookup)
- **Frontend**: Vanilla HTML/CSS/JS (no framework)
- **Storage**: SQLite × 2 (stories + codes, zero-config)

## Deployment

Works on any Node.js host. Recommended:
- **Railway** or **Render** for quick deploys
- **Fly.io** for SQLite persistence (supports volumes)
- **Vercel** if you move to a Postgres/Supabase backend

The SQLite files need persistent disk. If deploying to serverless, swap to Supabase or Turso.

Run `node ingest-codes.js` on the server after first deploy to populate the code database.

## API Key

You need an Anthropic API key. Get one at https://console.anthropic.com. The key stays server-side — it's never exposed to the frontend.
