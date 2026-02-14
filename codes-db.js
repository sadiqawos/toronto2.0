/**
 * codes-db.js — Local search index for Toronto municipal codes
 * 
 * Uses SQLite FTS5 (full-text search) to store and query
 * provisions from the Toronto Municipal Code, Zoning By-law 569-2013,
 * and the Official Plan.
 * 
 * This is intentionally keyword-based, not vector/embedding-based.
 * Legal text responds better to keyword search than semantic search
 * because the exact terminology matters (e.g. "angular plane" vs "height limit").
 */

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'codes.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    -- Main table for code provisions
    CREATE TABLE IF NOT EXISTS provisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,          -- 'municipal_code', 'zoning_bylaw', 'official_plan', 'ttc', 'building_code'
      chapter TEXT,                  -- e.g. 'Chapter 591' or 'Part 15.10'
      chapter_title TEXT,            -- e.g. 'Noise' or 'Parking Minimums'
      section TEXT,                  -- e.g. '591-2.1' or '15.10.40.70'
      section_title TEXT,            -- e.g. 'Prohibited noise levels'
      content TEXT NOT NULL,         -- The actual provision text
      summary TEXT,                  -- Plain-language summary (optional, AI-generated)
      pdf_url TEXT,                  -- Source URL for verification
      keywords TEXT,                 -- Extra searchable terms
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    -- FTS5 virtual table for fast full-text search
    CREATE VIRTUAL TABLE IF NOT EXISTS provisions_fts USING fts5(
      chapter_title,
      section_title,
      content,
      summary,
      keywords,
      content=provisions,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS provisions_ai AFTER INSERT ON provisions BEGIN
      INSERT INTO provisions_fts(rowid, chapter_title, section_title, content, summary, keywords)
      VALUES (new.id, new.chapter_title, new.section_title, new.content, new.summary, new.keywords);
    END;

    CREATE TRIGGER IF NOT EXISTS provisions_ad AFTER DELETE ON provisions BEGIN
      INSERT INTO provisions_fts(provisions_fts, rowid, chapter_title, section_title, content, summary, keywords)
      VALUES ('delete', old.id, old.chapter_title, old.section_title, old.content, old.summary, old.keywords);
    END;

    CREATE TRIGGER IF NOT EXISTS provisions_au AFTER UPDATE ON provisions BEGIN
      INSERT INTO provisions_fts(provisions_fts, rowid, chapter_title, section_title, content, summary, keywords)
      VALUES ('delete', old.id, old.chapter_title, old.section_title, old.content, old.summary, old.keywords);
      INSERT INTO provisions_fts(rowid, chapter_title, section_title, content, summary, keywords)
      VALUES (new.id, new.chapter_title, new.section_title, new.content, new.summary, new.keywords);
    END;

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_provisions_source ON provisions(source);
    CREATE INDEX IF NOT EXISTS idx_provisions_chapter ON provisions(chapter);

    -- Metadata table for tracking ingestion state
    CREATE TABLE IF NOT EXISTS ingestion_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      chapter TEXT,
      status TEXT DEFAULT 'completed',
      provisions_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

/**
 * Search provisions using full-text search
 * Returns the most relevant provisions for a given query
 */
function searchProvisions(query, { limit = 5, source = null } = {}) {
  const db = getDb();

  // Clean query for FTS5 — remove special chars, add OR between terms for broader matching
  const cleanQuery = query
    .replace(/[^\w\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 2)
    .map(w => `"${w}"`)
    .join(' OR ');

  if (!cleanQuery) return [];

  let sql = `
    SELECT 
      p.id, p.source, p.chapter, p.chapter_title,
      p.section, p.section_title, p.content,
      p.summary, p.pdf_url,
      rank
    FROM provisions_fts fts
    JOIN provisions p ON p.id = fts.rowid
    WHERE provisions_fts MATCH ?
  `;

  const params = [cleanQuery];

  if (source) {
    sql += ` AND p.source = ?`;
    params.push(source);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  try {
    return db.prepare(sql).all(...params);
  } catch (e) {
    // FTS5 can throw on malformed queries — fall back to LIKE
    console.warn('FTS5 search failed, falling back to LIKE:', e.message);
    return fallbackSearch(query, limit, source);
  }
}

/**
 * Fallback search using LIKE when FTS5 fails
 */
function fallbackSearch(query, limit, source) {
  const db = getDb();
  const terms = query.split(/\s+/).filter(w => w.length > 2);
  if (terms.length === 0) return [];

  const conditions = terms.map(() => `(p.content LIKE ? OR p.chapter_title LIKE ? OR p.section_title LIKE ?)`);
  const params = terms.flatMap(t => [`%${t}%`, `%${t}%`, `%${t}%`]);

  let sql = `SELECT * FROM provisions p WHERE ${conditions.join(' OR ')}`;
  if (source) {
    sql += ` AND p.source = ?`;
    params.push(source);
  }
  sql += ` LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params);
}

/**
 * Insert a provision into the database
 */
function insertProvision({ source, chapter, chapter_title, section, section_title, content, summary, pdf_url, keywords }) {
  const db = getDb();
  return db.prepare(`
    INSERT INTO provisions (source, chapter, chapter_title, section, section_title, content, summary, pdf_url, keywords)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(source, chapter, chapter_title, section, section_title, content, summary || null, pdf_url || null, keywords || null);
}

/**
 * Bulk insert provisions (wrapped in a transaction for speed)
 */
function bulkInsert(provisions) {
  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO provisions (source, chapter, chapter_title, section, section_title, content, summary, pdf_url, keywords)
    VALUES (@source, @chapter, @chapter_title, @section, @section_title, @content, @summary, @pdf_url, @keywords)
  `);

  const tx = db.transaction((items) => {
    for (const item of items) {
      insert.run({
        source: item.source,
        chapter: item.chapter,
        chapter_title: item.chapter_title,
        section: item.section || null,
        section_title: item.section_title || null,
        content: item.content,
        summary: item.summary || null,
        pdf_url: item.pdf_url || null,
        keywords: item.keywords || null,
      });
    }
  });

  tx(provisions);
  return provisions.length;
}

/**
 * Get stats about the code database
 */
function getCodeStats() {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as count FROM provisions').get();
  const bySrc = db.prepare('SELECT source, COUNT(*) as count FROM provisions GROUP BY source ORDER BY count DESC').all();
  const byChapter = db.prepare('SELECT chapter, chapter_title, COUNT(*) as count FROM provisions GROUP BY chapter ORDER BY count DESC LIMIT 20').all();

  return {
    total_provisions: total.count,
    by_source: bySrc,
    top_chapters: byChapter,
  };
}

/**
 * Check if a source has been ingested
 */
function isIngested(source, chapter) {
  const db = getDb();
  const row = db.prepare('SELECT id FROM ingestion_log WHERE source = ? AND chapter = ?').get(source, chapter);
  return !!row;
}

function logIngestion(source, chapter, count) {
  const db = getDb();
  db.prepare('INSERT INTO ingestion_log (source, chapter, provisions_count) VALUES (?, ?, ?)').run(source, chapter, count);
}

module.exports = {
  getDb,
  searchProvisions,
  insertProvision,
  bulkInsert,
  getCodeStats,
  isIngested,
  logIngestion,
};
