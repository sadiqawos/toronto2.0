#!/usr/bin/env node

/**
 * ingest-codes.js — Scrape and index Toronto's municipal codes
 * 
 * Run: node ingest-codes.js [--source municipal_code|zoning_bylaw|official_plan|all]
 * 
 * This script:
 * 1. Scrapes chapter listings from toronto.ca
 * 2. Downloads each PDF
 * 3. Extracts text with pdf-parse
 * 4. Chunks into individual sections/provisions
 * 5. Stores in SQLite FTS5 via codes-db.js
 * 
 * Toronto's Municipal Code is ~150 chapters, mostly PDFs.
 * Zoning By-law 569-2013 is massive (1000+ pages) but well-structured.
 * The Official Plan is a set of policy documents.
 */

const cheerio = require('cheerio');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const codesDb = require('./codes-db');

const CACHE_DIR = path.join(__dirname, '.cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

// ══════════════════════════════════════
// CONFIG: Sources to ingest
// ══════════════════════════════════════

const SOURCES = {
  municipal_code: {
    name: 'Toronto Municipal Code',
    indexUrl: 'https://www.toronto.ca/legdocs/bylaws/lawmcode.htm',
    // These are the citizen-facing chapters most likely to appear in traces
    priorityChapters: [
      349, 354, 363, 395, 415, 441, 447, 459, 469, 489, 492,
      510, 517, 523, 545, 547, 548, 553, 555, 591, 608, 611,
      612, 615, 629, 632, 636, 658, 673, 681, 693, 694, 719,
      738, 743, 767, 813, 841, 844, 849, 851, 880, 886, 903,
      910, 915, 918, 919, 925, 937, 950
    ],
  },

  zoning_bylaw: {
    name: 'Zoning By-law 569-2013',
    baseUrl: 'https://www.toronto.ca/zoning/bylaw_amendments/ZBL_NewProvision.htm',
    pdfUrls: [
      // Volume 1: Chapters 1-800 (all the main regulations)
      {
        url: 'https://www.toronto.ca/legdocs/bylaws/2013/law0569-schedule-a-vol1-ch1-800.pdf',
        chapter: 'Zoning By-law 569-2013 Vol. 1',
        title: 'Chapters 1-800 (Administration, Zones, Parking, General Provisions, Definitions)'
      },
      // Volume 2: Exceptions Part 1
      {
        url: 'https://www.toronto.ca/legdocs/bylaws/2013/law0569-schedule-a-vol2-ch900-part1.pdf',
        chapter: 'Zoning By-law 569-2013 Vol. 2',
        title: 'Exceptions Part 1'
      },
      // Older consolidated version (has useful standalone structure)
      {
        url: 'https://www.toronto.ca/wp-content/uploads/2018/07/97ec-City-Planning-Zoning-Zoning-By-law-Part-1.pdf',
        chapter: 'Zoning By-law 569-2013 Consolidated',
        title: 'Office Consolidation (Chapters 1-80)'
      },
    ]
  },

  official_plan: {
    name: 'Official Plan',
    pdfUrls: [
      { url: 'https://www.toronto.ca/wp-content/uploads/2019/06/8f06-OfficialPlanAODA_Compiled-3.0.pdf', chapter: 'Official Plan', title: 'Consolidated Official Plan' },
    ]
  }
};

// ══════════════════════════════════════
// FETCHING
// ══════════════════════════════════════

async function fetchPage(url) {
  const cacheKey = Buffer.from(url).toString('base64').slice(0, 60);
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.html`);

  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, 'utf8');
  }

  console.log(`  ↓ Fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  fs.writeFileSync(cachePath, text);
  return text;
}

async function fetchPdf(url) {
  const cacheKey = Buffer.from(url).toString('base64').slice(0, 60);
  const cachePath = path.join(CACHE_DIR, `${cacheKey}.pdf`);

  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath);
  }

  console.log(`  ↓ Downloading PDF: ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(cachePath, buffer);
  return buffer;
}

// ══════════════════════════════════════
// PDF PARSING & CHUNKING
// ══════════════════════════════════════

/**
 * Extract text from a PDF buffer and chunk into sections.
 * 
 * Municipal code PDFs follow a fairly consistent pattern:
 * - Section headers like "§ 591-2.1" or "ARTICLE III"
 * - Subsections indented or numbered
 * 
 * We chunk on section boundaries to keep provisions atomic.
 */
async function extractAndChunk(pdfBuffer, { source, chapter, chapterTitle, pdfUrl }) {
  let parsed;
  try {
    parsed = await pdfParse(pdfBuffer);
  } catch (e) {
    console.warn(`  ⚠ Could not parse PDF for ${chapter}: ${e.message}`);
    return [];
  }

  const text = parsed.text;
  if (!text || text.length < 50) return [];

  // Split on section-like patterns
  const sectionPatterns = [
    // § 591-2.1 or § 841-4
    /(?=§\s*\d+[\-–]\d+)/g,
    // ARTICLE I, ARTICLE II etc.
    /(?=ARTICLE\s+[IVXLC]+)/gi,
    // Section 15.10.40 or 5.10.40
    /(?=\d+\.\d+\.\d+)/g,
    // Numbered sections like "(1)", "(2)" at start of line
    /(?=\n\s*\(\d+\)\s+[A-Z])/g,
  ];

  let sections = [text]; // Start with the full text

  // Try each pattern, use the one that gives the best granularity
  for (const pattern of sectionPatterns) {
    const splits = text.split(pattern).filter(s => s.trim().length > 30);
    if (splits.length > sections.length && splits.length < 200) {
      sections = splits;
    }
  }

  // If we couldn't split into sections, chunk by ~1500 chars with overlap
  if (sections.length <= 1 && text.length > 2000) {
    sections = chunkBySize(text, 1500, 200);
  }

  const provisions = sections.map((content, i) => {
    // Try to extract a section number from the beginning
    const sectionMatch = content.match(/^§?\s*([\d\-–.]+)/);
    const section = sectionMatch ? sectionMatch[1].trim() : null;

    // Try to extract a title (first line, if it looks like a title)
    const lines = content.trim().split('\n');
    const firstLine = lines[0]?.trim();
    const sectionTitle = firstLine && firstLine.length < 120 ? firstLine : null;

    return {
      source,
      chapter,
      chapter_title: chapterTitle,
      section: section ? `${chapter}-${section}` : `${chapter} (Part ${i + 1})`,
      section_title: sectionTitle,
      content: content.trim().slice(0, 3000), // Cap at 3000 chars per provision
      summary: null,
      pdf_url: pdfUrl,
      keywords: extractKeywords(content),
    };
  });

  return provisions.filter(p => p.content.length > 50);
}

/**
 * Chunk text by character count with overlap
 */
function chunkBySize(text, chunkSize, overlap) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    const end = Math.min(start + chunkSize, text.length);
    chunks.push(text.slice(start, end));
    start = end - overlap;
    if (start >= text.length - overlap) break;
  }
  return chunks;
}

/**
 * Extract useful keywords from provision text
 * (helps FTS5 find provisions for citizen stories)
 */
function extractKeywords(text) {
  const keywords = new Set();
  const t = text.toLowerCase();

  // Domain-specific keyword extraction
  const patterns = {
    'parking': /parking|garage|vehicle storage/i,
    'noise': /noise|sound|decibel|quiet/i,
    'height': /height|storey|angular plane|setback/i,
    'density': /density|floor area|FSI|units per/i,
    'transit': /transit|TTC|streetcar|bus|subway|LRT/i,
    'cycling': /bicycle|cycling|bike lane|bike parking/i,
    'pedestrian': /pedestrian|sidewalk|crosswalk|walkway/i,
    'snow': /snow|ice|winter|plow|windrow/i,
    'fence': /fence|enclosure|barrier/i,
    'tree': /tree|canopy|urban forest/i,
    'heritage': /heritage|conservation|historic/i,
    'sign': /sign|billboard|advertising/i,
    'waste': /waste|garbage|recycling|bin/i,
    'water': /water|sewer|drainage|stormwater/i,
    'housing': /housing|dwelling|residential|apartment|multiplex/i,
    'commercial': /commercial|retail|restaurant|business/i,
    'property': /property|land|lot|zoning/i,
    'permit': /permit|licence|license|application/i,
    'construction': /construction|demolition|building/i,
    'accessibility': /accessibility|accessible|barrier-free/i,
    'fire': /fire|safety|emergency|smoke/i,
    'boulevard': /boulevard|right-of-way|road allowance/i,
    'animal': /animal|dog|pet|cat/i,
    'food': /food|restaurant|patio|cafe/i,
    'rental': /rental|tenant|landlord|eviction/i,
    'development': /development|site plan|subdivision/i,
    'setback': /setback|yard|front yard|rear yard|side yard/i,
    'laneway': /laneway|lane|alley|rear lane/i,
  };

  for (const [keyword, pattern] of Object.entries(patterns)) {
    if (pattern.test(t)) keywords.add(keyword);
  }

  return [...keywords].join(', ');
}

// ══════════════════════════════════════
// INGESTION: Municipal Code
// ══════════════════════════════════════

async function ingestMunicipalCode() {
  console.log('\n📜 Ingesting Toronto Municipal Code...');

  const config = SOURCES.municipal_code;
  const html = await fetchPage(config.indexUrl);
  const $ = cheerio.load(html);

  // Parse chapter links from the table
  const chapters = [];
  $('a[href*="municode"]').each((_, el) => {
    const href = $(el).attr('href');
    const text = $(el).text().trim();
    const chapterMatch = text.match(/Chapter\s+(\d+)/);

    if (chapterMatch && href.endsWith('.pdf')) {
      const num = parseInt(chapterMatch[1]);
      // Get the chapter title from the next cell or the link context
      const row = $(el).closest('tr');
      const cells = row.find('td');
      const title = cells.eq(1)?.text()?.trim() || text;

      chapters.push({
        number: num,
        title: title,
        url: href.startsWith('http') ? href : `https://www.toronto.ca/legdocs/municode/${href.split('/').pop()}`,
      });
    }
  });

  console.log(`  Found ${chapters.length} chapters`);

  // Filter to priority chapters (or all if flag set)
  const doAll = process.argv.includes('--all-chapters');
  const toIngest = doAll
    ? chapters
    : chapters.filter(c => config.priorityChapters.includes(c.number));

  console.log(`  Ingesting ${toIngest.length} ${doAll ? 'total' : 'priority'} chapters\n`);

  let totalProvisions = 0;

  for (const ch of toIngest) {
    const chapterRef = `Chapter ${ch.number}`;

    if (codesDb.isIngested('municipal_code', chapterRef)) {
      console.log(`  ✓ ${chapterRef} (${ch.title}) — already indexed`);
      continue;
    }

    try {
      const pdfBuffer = await fetchPdf(ch.url);
      const provisions = await extractAndChunk(pdfBuffer, {
        source: 'municipal_code',
        chapter: chapterRef,
        chapterTitle: ch.title,
        pdfUrl: ch.url,
      });

      if (provisions.length > 0) {
        codesDb.bulkInsert(provisions);
        codesDb.logIngestion('municipal_code', chapterRef, provisions.length);
        totalProvisions += provisions.length;
        console.log(`  ✓ ${chapterRef} (${ch.title}) — ${provisions.length} provisions indexed`);
      } else {
        console.log(`  ⚠ ${chapterRef} (${ch.title}) — no provisions extracted`);
      }

      // Be polite to the server
      await sleep(300);

    } catch (e) {
      console.error(`  ✗ ${chapterRef} (${ch.title}) — ${e.message}`);
    }
  }

  console.log(`\n  Municipal Code: ${totalProvisions} provisions indexed`);
  return totalProvisions;
}

// ══════════════════════════════════════
// INGESTION: Zoning By-law
// ══════════════════════════════════════

async function ingestZoningBylaw() {
  console.log('\n🏗️  Ingesting Zoning By-law 569-2013...');

  let totalProvisions = 0;

  for (const item of SOURCES.zoning_bylaw.pdfUrls) {
    if (codesDb.isIngested('zoning_bylaw', item.chapter)) {
      console.log(`  ✓ ${item.chapter} (${item.title}) — already indexed`);
      continue;
    }

    try {
      const pdfBuffer = await fetchPdf(item.url);
      const provisions = await extractAndChunk(pdfBuffer, {
        source: 'zoning_bylaw',
        chapter: item.chapter,
        chapterTitle: `Zoning By-law 569-2013 — ${item.title}`,
        pdfUrl: item.url,
      });

      if (provisions.length > 0) {
        codesDb.bulkInsert(provisions);
        codesDb.logIngestion('zoning_bylaw', item.chapter, provisions.length);
        totalProvisions += provisions.length;
        console.log(`  ✓ ${item.chapter} (${item.title}) — ${provisions.length} provisions indexed`);
      }

      await sleep(300);
    } catch (e) {
      console.error(`  ✗ ${item.chapter} — ${e.message}`);
    }
  }

  console.log(`\n  Zoning By-law: ${totalProvisions} provisions indexed`);
  return totalProvisions;
}

// ══════════════════════════════════════
// INGESTION: Official Plan
// ══════════════════════════════════════

async function ingestOfficialPlan() {
  console.log('\n📋 Ingesting Official Plan...');

  let totalProvisions = 0;

  for (const item of SOURCES.official_plan.pdfUrls) {
    if (codesDb.isIngested('official_plan', item.chapter)) {
      console.log(`  ✓ ${item.chapter} — already indexed`);
      continue;
    }

    try {
      const pdfBuffer = await fetchPdf(item.url);
      const provisions = await extractAndChunk(pdfBuffer, {
        source: 'official_plan',
        chapter: item.chapter,
        chapterTitle: item.title,
        pdfUrl: item.url,
      });

      if (provisions.length > 0) {
        codesDb.bulkInsert(provisions);
        codesDb.logIngestion('official_plan', item.chapter, provisions.length);
        totalProvisions += provisions.length;
        console.log(`  ✓ ${item.chapter} — ${provisions.length} provisions indexed`);
      }
    } catch (e) {
      console.error(`  ✗ ${item.chapter} — ${e.message}`);
    }
  }

  console.log(`\n  Official Plan: ${totalProvisions} provisions indexed`);
  return totalProvisions;
}

// ══════════════════════════════════════
// MAIN
// ══════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║   Toronto 2.0 — Code Ingestion       ║');
  console.log('╚══════════════════════════════════════╝');

  const source = process.argv[2]?.replace('--source=', '') || 'all';

  let total = 0;

  if (source === 'all' || source === 'municipal_code') {
    total += await ingestMunicipalCode();
  }

  if (source === 'all' || source === 'zoning_bylaw') {
    total += await ingestZoningBylaw();
  }

  if (source === 'all' || source === 'official_plan') {
    total += await ingestOfficialPlan();
  }

  console.log('\n════════════════════════════════════');
  const stats = codesDb.getCodeStats();
  console.log(`Total provisions indexed: ${stats.total_provisions}`);
  console.log('By source:');
  stats.by_source.forEach(s => console.log(`  ${s.source}: ${s.count}`));
  console.log('════════════════════════════════════\n');
}

main().catch(e => {
  console.error('Fatal error:', e);
  process.exit(1);
});
