# CLAUDE.md — Toronto 2.0

## Project Overview

Toronto 2.0 is a civic tech web application: "Trace the code behind your city." Citizens submit stories about frustrations with Toronto's municipal services, and the app traces each story back to specific municipal bylaws, zoning provisions, and policies using AI and local full-text search.

## Tech Stack

- **Runtime**: Node.js (no build step, no transpilation)
- **Backend**: Express.js (`server.js`)
- **Database**: SQLite x2 via `better-sqlite3` (WAL mode)
  - `toronto2.db` — citizen stories and traces
  - `codes.db` — FTS5 search index of municipal code provisions
- **AI**: Anthropic Claude Sonnet API (`claude-sonnet-4-20250514`) for trace generation
- **Frontend**: Vanilla HTML/CSS/JS single-page app (`public/index.html`) — no framework
- **PDF Parsing**: `pdf-parse` + `cheerio` for municipal code ingestion

## Repository Structure

```
toronto2.0/
├── server.js           # Express backend — all API routes, middleware, Anthropic integration
├── codes-db.js         # SQLite FTS5 search module — provisions CRUD and search
├── ingest-codes.js     # Scraper/parser — downloads PDFs from toronto.ca, chunks into provisions
├── package.json        # Dependencies and scripts
├── .env.example        # Environment variable template
├── .gitignore
├── public/
│   └── index.html      # Complete SPA (HTML + embedded CSS + embedded JS, ~1200 lines)
├── toronto2.db         # Stories database (auto-created at runtime, gitignored)
├── codes.db            # Provisions database (created by ingestion, gitignored)
└── .cache/             # Cached PDFs from ingestion (gitignored)
```

## Commands

```bash
npm install              # Install dependencies
npm start                # Start server (node server.js) → http://localhost:3000
npm run dev              # Start with file watching (node --watch server.js)
npm run ingest           # Ingest priority municipal code chapters into codes.db
npm run ingest:all       # Ingest all chapters (not just priority ones)
```

Ingestion flags:
```bash
node ingest-codes.js --source=municipal_code   # Only municipal code
node ingest-codes.js --source=zoning_bylaw     # Only zoning by-law
node ingest-codes.js --source=official_plan    # Only official plan
node ingest-codes.js --all-chapters            # All chapters, not just priority subset
```

## Environment Variables

Defined in `.env` (copy from `.env.example`):
- `ANTHROPIC_API_KEY` — required for trace generation
- `PORT` — server port (default: 3000)

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/trace` | Generate a trace from a citizen story |
| `GET` | `/api/feed` | Paginated feed of published traces (`?page=&limit=&sort=recent\|popular`) |
| `GET` | `/api/trace/:id` | Single trace by ID |
| `POST` | `/api/trace/:id/upvote` | Upvote a trace |
| `GET` | `/api/stats` | Aggregate stats (top codes, neighbourhoods) |
| `GET` | `/api/codes/search` | Search code database (`?q=&source=&limit=`) |
| `GET` | `/api/codes/stats` | Code database statistics |
| `GET` | `*` | SPA fallback — serves `public/index.html` |

## Architecture — How Trace Generation Works

1. Citizen submits a story via `POST /api/trace`
2. `extractSearchTerms()` in `server.js:81` maps citizen language to legal terminology (e.g., "streetcar" → "transit TTC service streetcar bus")
3. `codesDb.searchProvisions()` in `codes-db.js:97` queries FTS5 for the 5-8 most relevant provisions
4. The story + matched provisions are sent to Claude Sonnet, which selects 2-3 provisions and writes annotations
5. Result is stored in `toronto2.db` and returned to the client

## Database Schemas

**stories** (`toronto2.db`):
- `id` TEXT PRIMARY KEY (random hex)
- `story`, `neighbourhood`, `email`, `trace_json` (JSON string), `summary`
- `status` DEFAULT 'published', `upvotes` DEFAULT 0, `created_at`

**provisions** (`codes.db`):
- `id` INTEGER PRIMARY KEY, `source` (municipal_code/zoning_bylaw/official_plan)
- `chapter`, `chapter_title`, `section`, `section_title`, `content`, `summary`, `pdf_url`, `keywords`
- FTS5 virtual table `provisions_fts` with porter stemming, synced via triggers

**ingestion_log** (`codes.db`):
- Tracks which sources/chapters have been ingested to avoid duplicates

## Code Conventions

- **Module system**: CommonJS (`require`/`module.exports`)
- **No TypeScript** — plain JavaScript throughout
- **No linter or formatter** configured
- **Comment style**: Section headers use `// ── Section Name ──` with em dashes
- **Error handling**: try/catch in async routes, `console.error` for logging, user-friendly error messages in JSON responses
- **IDs**: `crypto.randomBytes(8).toString('hex')` for story IDs
- **Database access**: Synchronous `better-sqlite3` prepared statements; transactions for bulk operations
- **Rate limiting**: 10 traces per 15 min, 100 browse requests per 15 min
- **Security middleware**: Helmet (CSP disabled), CORS, 10KB JSON body limit
- **Frontend**: All HTML/CSS/JS in a single `index.html` file with no external dependencies except Google Fonts and html2canvas CDN

## Testing

No test framework, test files, or testing dependencies exist. There are no automated tests.

## Key Patterns to Preserve

- The FTS5 search uses keyword-based matching (not semantic/embeddings) because legal text responds better to exact terminology
- The `extractSearchTerms()` mapping table is the critical bridge between citizen language and municipal code terminology — extend it when adding new domain coverage
- Provisions content is truncated to 800 chars when sent to the LLM to manage token usage
- The system prompt instructs the LLM to prioritize retrieved provisions over its own knowledge
- SQLite databases are gitignored — `toronto2.db` is auto-created on server start, `codes.db` requires running the ingestion script
- PDFs are cached in `.cache/` so re-running ingestion doesn't re-download
