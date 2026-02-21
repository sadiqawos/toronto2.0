require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(express.json({ limit: '10kb' }));
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false,
}));

// Rate limiting — generous for browsing, tighter for trace generation
const browseLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const traceLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 10, message: { error: 'Too many traces requested. Try again in a few minutes.' } });

app.use('/api/feed', browseLimiter);
app.use('/api/trace', traceLimiter);

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// ── Database ──
const db = new Database(path.join(__dirname, 'toronto2.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    story TEXT NOT NULL,
    neighbourhood TEXT,
    email TEXT,
    trace_json TEXT,
    summary TEXT,
    status TEXT DEFAULT 'published',
    created_at TEXT DEFAULT (datetime('now')),
    upvotes INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_stories_status ON stories(status);
  CREATE INDEX IF NOT EXISTS idx_stories_created ON stories(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_stories_upvotes ON stories(upvotes DESC);
`);

// ── Anthropic API Proxy ──
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const codesDb = require('./codes-db');

// Lean system prompt — the actual code text comes from local search
const SYSTEM_PROMPT = `You are a Toronto municipal code analyst for the Toronto 2.0 project. Given a citizen's story and a set of REAL provisions from Toronto's municipal codes, identify 2-3 provisions that contributed to the citizen's problem.

You will receive actual provision text retrieved from the city's code database. Use these real provisions in your response — quote section numbers and paraphrase the actual text. If the provided provisions don't fully explain the problem, you may reference other well-known Toronto provisions you're confident exist, but prioritize the retrieved ones.

For each provision, write:
- code_ref: The exact chapter/section reference
- title: A short descriptive title (5-8 words)
- code_content: Paraphrase of what the provision actually says
- code_comment: The systemic downstream effect
- annotation: 2-3 sentences connecting this to the citizen's specific experience (use "you" and "your")

Tone: revealing and slightly heartbroken. Not angry, not wonky. Make the invisible visible.

Respond ONLY with valid JSON (no markdown fences):
{
  "traces": [{ "code_ref": "...", "title": "...", "code_content": "...", "code_comment": "...", "annotation": "..." }],
  "summary": "One sentence capturing the systemic pattern revealed"
}`;

/**
 * Extract search terms from a citizen's story to query the code database.
 * This is the bridge between human language and legal terminology.
 */
function extractSearchTerms(story) {
  const terms = new Set();
  const s = story.toLowerCase();

  // Map citizen language → code concepts
  const mappings = {
    // Transit
    'late|commute|bus|streetcar|subway|ttc|train|transit|shuttle': 'transit TTC service streetcar bus',
    'traffic|congestion|gridlock|slow|stuck': 'traffic right-of-way road',
    // Housing
    'rent|apartment|condo|housing|afford|expensive|lease': 'housing residential dwelling density',
    'basement|suite|secondary|laneway|garden suite': 'laneway secondary suite dwelling additional',
    'build|construct|renovate|addition|permit': 'building permit construction site plan',
    // Parking
    'parking|park|car|drive|garage': 'parking minimum vehicle spaces',
    // Noise
    'noise|loud|music|construction noise|barking': 'noise sound prohibited',
    // Property
    'fence|yard|garden|tree|property line': 'fence property boundary setback',
    'snow|plow|ice|winter|shovel|salt': 'snow ice removal clearing windrow',
    'garbage|waste|recycling|bin|collection': 'waste collection recycling',
    // Commercial
    'restaurant|bar|cafe|patio|food|shop|store|business': 'commercial retail restaurant licence patio',
    'sign|billboard|awning': 'sign advertising display',
    // Streets
    'sidewalk|road|pothole|crosswalk|intersection': 'street sidewalk road maintenance',
    'bike|bicycle|cycling|cycle track': 'bicycle cycling lane',
    'pedestrian|walk|crossing': 'pedestrian crosswalk sidewalk',
    // Development
    'development|tower|highrise|condo|new building': 'development height density setback angular',
    'heritage|old building|historic': 'heritage conservation designation',
    // Safety
    'safety|dangerous|hazard': 'safety property standard',
    'fire|smoke|alarm': 'fire safety building code',
    // Animals
    'dog|pet|animal|leash': 'animal dog pet',
    // Licensing
    'licence|license|permit|application|wait': 'licence permit application',
  };

  for (const [patterns, searchTerms] of Object.entries(mappings)) {
    const regex = new RegExp(patterns, 'i');
    if (regex.test(s)) {
      searchTerms.split(' ').forEach(t => terms.add(t));
    }
  }

  // Also add any neighbourhood names or street names mentioned
  // (these help contextualize zoning)
  const locations = s.match(/\b(queen|king|bloor|dundas|yonge|spadina|bathurst|ossington|college|st\.?\s*clair|danforth|eglinton|lawrence|sheppard|finch|scarborough|etobicoke|north york|east york|leslieville|parkdale|junction|kensington|annex|beaches|liberty|distillery|corktown|regent|moss park|cabbage ?town|river ?dale)\b/gi);
  if (locations) locations.forEach(l => terms.add(l.toLowerCase()));

  return [...terms].join(' ');
}

app.post('/api/trace', async (req, res) => {
  const { story, neighbourhood, email } = req.body;

  if (!story || story.trim().length < 20) {
    return res.status(400).json({ error: 'Story must be at least 20 characters.' });
  }

  if (!ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: 'API key not configured. Set ANTHROPIC_API_KEY in .env' });
  }

  try {
    // ── Step 1: Search local code database ──
    const searchTerms = extractSearchTerms(story);
    let relevantProvisions = [];

    if (searchTerms) {
      relevantProvisions = codesDb.searchProvisions(searchTerms, { limit: 8 });
    }

    // ── Step 2: Build context for the LLM ──
    let codeContext = '';

    if (relevantProvisions.length > 0) {
      codeContext = '\n\nRELEVANT PROVISIONS FROM TORONTO\'S CODE DATABASE:\n' +
        relevantProvisions.map((p, i) => {
          return `\n--- Provision ${i + 1} ---\n` +
            `Source: ${p.source}\n` +
            `Reference: ${p.chapter}${p.section ? ', ' + p.section : ''}\n` +
            `Title: ${p.chapter_title}${p.section_title ? ' — ' + p.section_title : ''}\n` +
            `Text: ${p.content.slice(0, 800)}\n`;
        }).join('');
    } else {
      codeContext = '\n\n[No matching provisions found in the local database. Use your knowledge of Toronto municipal codes, referencing real chapter numbers and by-law sections where possible.]';
    }

    // ── Step 3: Call Anthropic API with targeted context ──
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1200,
        system: SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: `Here is a Toronto citizen's story. Trace it back to the municipal code.\n\nSTORY: "${story.trim()}"${neighbourhood ? `\nNEIGHBOURHOOD: ${neighbourhood}` : ''}${codeContext}`
          }
        ]
      })
    });

    if (!response.ok) {
      const errBody = await response.text();
      console.error('Anthropic API error:', response.status, errBody);
      return res.status(502).json({ error: 'Failed to generate trace. Try again.' });
    }

    const data = await response.json();
    const text = data.content.map(c => c.text || '').join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    // ── Step 4: Store in database ──
    const id = crypto.randomBytes(8).toString('hex');
    const stmt = db.prepare(`
      INSERT INTO stories (id, story, neighbourhood, email, trace_json, summary)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      story.trim(),
      neighbourhood || null,
      email || null,
      JSON.stringify(parsed.traces),
      parsed.summary || null
    );

    // Log which provisions were used (for analytics)
    console.log(`Trace ${id}: ${relevantProvisions.length} local provisions used, ${parsed.traces.length} traces generated`);

    res.json({
      id,
      traces: parsed.traces,
      summary: parsed.summary
    });

  } catch (err) {
    console.error('Trace generation error:', err);
    res.status(500).json({ error: 'Something went wrong generating the trace.' });
  }
});

// ── Feed Endpoints ──

// Get recent traces for the feed
app.get('/api/feed', (req, res) => {
  const { page = 1, limit = 10, sort = 'recent' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const safeLimit = Math.min(parseInt(limit), 20);

  let orderBy = 'created_at DESC';
  if (sort === 'popular') orderBy = 'upvotes DESC, created_at DESC';

  const stories = db.prepare(`
    SELECT id, story, neighbourhood, trace_json, summary, created_at, upvotes
    FROM stories
    WHERE status = 'published'
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(safeLimit, offset);

  const total = db.prepare(`SELECT COUNT(*) as count FROM stories WHERE status = 'published'`).get();

  const formatted = stories.map(s => ({
    id: s.id,
    story: s.story,
    neighbourhood: s.neighbourhood,
    traces: JSON.parse(s.trace_json || '[]'),
    summary: s.summary,
    created_at: s.created_at,
    upvotes: s.upvotes
  }));

  res.json({
    stories: formatted,
    total: total.count,
    page: parseInt(page),
    pages: Math.ceil(total.count / safeLimit)
  });
});

// Get a single trace by ID
app.get('/api/trace/:id', (req, res) => {
  const story = db.prepare(`
    SELECT id, story, neighbourhood, trace_json, summary, created_at, upvotes
    FROM stories
    WHERE id = ? AND status = 'published'
  `).get(req.params.id);

  if (!story) return res.status(404).json({ error: 'Trace not found.' });

  res.json({
    id: story.id,
    story: story.story,
    neighbourhood: story.neighbourhood,
    traces: JSON.parse(story.trace_json || '[]'),
    summary: story.summary,
    created_at: story.created_at,
    upvotes: story.upvotes
  });
});

// Upvote a trace
app.post('/api/trace/:id/upvote', (req, res) => {
  const result = db.prepare(`
    UPDATE stories SET upvotes = upvotes + 1 WHERE id = ? AND status = 'published'
  `).run(req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Trace not found.' });

  const story = db.prepare(`SELECT upvotes FROM stories WHERE id = ?`).get(req.params.id);
  res.json({ upvotes: story.upvotes });
});

// ── Stats endpoint (for future dashboard) ──
app.get('/api/stats', (req, res) => {
  const total = db.prepare(`SELECT COUNT(*) as count FROM stories WHERE status = 'published'`).get();
  const neighbourhoods = db.prepare(`
    SELECT neighbourhood, COUNT(*) as count
    FROM stories
    WHERE status = 'published' AND neighbourhood IS NOT NULL AND neighbourhood != ''
    GROUP BY neighbourhood
    ORDER BY count DESC
    LIMIT 10
  `).all();

  // Most cited code references across all traces
  const allTraces = db.prepare(`SELECT trace_json FROM stories WHERE status = 'published'`).all();
  const codeRefCounts = {};
  allTraces.forEach(row => {
    const traces = JSON.parse(row.trace_json || '[]');
    traces.forEach(t => {
      const ref = t.code_ref?.split(',')[0]?.trim() || t.code_ref;
      if (ref) codeRefCounts[ref] = (codeRefCounts[ref] || 0) + 1;
    });
  });

  const topCodes = Object.entries(codeRefCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([ref, count]) => ({ ref, count }));

  res.json({
    total_stories: total.count,
    top_neighbourhoods: neighbourhoods,
    most_cited_codes: topCodes
  });
});

// ── Code Database Endpoints ──

// Search the code database directly
app.get('/api/codes/search', (req, res) => {
  const { q, source, limit = 10 } = req.query;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required.' });

  const results = codesDb.searchProvisions(q, {
    limit: Math.min(parseInt(limit), 20),
    source: source || null
  });

  res.json({ query: q, results });
});

// Get code database stats
app.get('/api/codes/stats', (req, res) => {
  res.json(codesDb.getCodeStats());
});

// About page
app.get('/about', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'about.html'));
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`\n  🏙️  Toronto 2.0 running at http://localhost:${PORT}\n`);
});
