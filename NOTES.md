# Toronto 2.0 — Development Notes

## Session: 2026-02-21

### What We Built

**Objective:** Modernize the Toronto 2.0 interface with a Reddit-style community feed while preserving the original design's best elements.

#### 1. Reddit-Style Community Feed
- **New layout:** Compact card design with voting, collapsed compose bar
- **Features:**
  - Upvoting system with local storage persistence
  - Expandable post cards (click to show full bylaw trace)
  - Sort by Recent/Popular
  - Pagination (load more)
  - Voice input support (Web Speech API)
  - Example story chips for quick testing
- **Feed became the new home page** — better default experience for returning users

#### 2. About Page
- **Content:** Manifesto ("The Premise") + Q&A section
- **Purpose:** Separate long-form explanation from the action (feed)
- **Design:** Matches original landing page style (spacious, readable)

#### 3. Navigation & Layout
- **Unified header across all pages:**
  - PUBLIC BETA tag
  - Home | About links
  - Toronto 2.0 title + subtitle
- **Why:** Prevents layout shift when navigating between pages
- **Footer:** Metro Toronto logo (five interwoven rings, 1953-1998) with explanation — carried across all pages

### Key Decisions

1. **Feed as home page** — Original landing page archived as `landing-original.html`
2. **No Instagram link** — Kept navigation minimal (Home | About only)
3. **Inline header styles** — Ensures consistency across pages without complex CSS inheritance
4. **Vote persistence** — Uses localStorage (`t2_votes` key) to prevent double-voting
5. **Server routes:**
   - `/` → feed (index.html)
   - `/about` → manifesto + Q&A
   - Original `/feed` route removed (feed is now root)

### Technical Learnings

#### Deployment Flow
- **Host:** building31 (8max.ca)
- **Path:** `/home/ubuntu/to2.daem-labs.com`
- **Service:** `systemd` service named `toronto2.service`
- **Deploy steps:**
  1. SSH to `ubuntu@8max.ca`
  2. `cd ~/to2.daem-labs.com`
  3. `git pull origin <branch>`
  4. `sudo systemctl restart toronto2.service`

#### CSS Architecture
- **Feed page:** Inline topbar removed in favor of consistent header
- **Common header:** Duplicated HTML structure across pages (acceptable trade-off for simplicity)
- **Design system:**
  - `--blue: #1B4F72` (primary)
  - `--muted: #8B8680` (text secondary)
  - `--bg: #F7F7F5` (warm off-white)
  - `--border: #DEDBD5` (subtle borders)

#### State Management
- **Voting:** LocalStorage tracks voted post IDs
- **Feed state:** currentSort, currentPage, totalPages, votedIds
- **Result caching:** lastTraceData + lastStory for share actions

### File Structure

```
public/
├── index.html              # Feed (home page)
├── about.html              # Manifesto + Q&A
├── landing-original.html   # Archived original landing page
├── metro-logo.png          # Municipality of Metro Toronto logo
└── favicon.ico

server.js                   # Express server with /about route
```

### What We Didn't Do (Yet)

- **Merge to main** — Still on `feat/reddit-feed` branch
- **Analytics** — No tracking of which bylaws are most cited
- **Search** — No search/filter on feed
- **User accounts** — All anonymous voting (localStorage only)
- **Moderation** — No admin panel for managing stories
- **RSS/API** — No public feeds for consuming traces externally

### Next Steps (Future Sessions)

1. **Merge `feat/reddit-feed` to main** when ready for permanent deployment
2. **Add search/filter** to feed (by neighbourhood, bylaw chapter, keyword)
3. **Stats page** — Most-cited bylaws, top neighbourhoods, patterns over time
4. **Social sharing improvements** — Better OG images, pre-formatted share text
5. **Performance:** Consider pagination vs infinite scroll for large feed
6. **Accessibility audit** — Keyboard nav, ARIA labels, screen reader testing

### Commits (feat/reddit-feed branch)

1. `f628c04` — Add Reddit-style community feed at /feed
2. `e59e10a` — Add /about page with manifesto and Q&A
3. `bcf494e` — Standardize navigation across all pages
4. `01c3b88` — Make feed the new home page
5. `f02adec` — Add common header to all pages to prevent layout shifts

### Design Philosophy Preserved

From the original Toronto 2.0 vision:
- **Legibility over advocacy** — Show the code, don't prescribe solutions
- **Illustrative, not forensic** — Threads worth pulling, not legal analysis
- **Pattern emergence** — When enough people trace frustrations to the same bylaw, that bylaw becomes visible
- **Metro Toronto logo** — Five rings, interwoven. Represents the people, not the building.

---

**Branch:** `feat/reddit-feed` (ready to merge)  
**Live:** https://to2.daem-labs.com/  
**Status:** ✅ Deployed and stable
