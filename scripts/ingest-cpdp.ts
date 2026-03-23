#!/usr/bin/env tsx
/**
 * CPDP ingestion crawler — decisions, opinions, and guidance from cpdp.bg.
 *
 * The CPDP website has two parallel structures:
 *   1. WordPress site (cpdp.bg) — decisions and opinions by year as WP categories
 *      - Discovery via WP REST API: /wp-json/wp/v2/categories + /wp-json/wp/v2/posts
 *      - Category names: "Решения на КЗЛД за {year} г." / "Становища на КЗЛД за {year} г."
 *      - NOTE: HTML category archives do NOT render posts (Elementor theme shows empty
 *        "section-empty" div despite posts existing). REST API is the only reliable path.
 *   2. Legacy PHP site (www.cpdp.bg) — practice section (redirects to cpdp.bg)
 *      - Practice index: /index.php?p=rubric&aid=3
 *      - Year rubrics: /index.php?p=rubric_element&aid={N}
 *      - Individual items: /index.php?p=element_view&aid={N}
 *
 * This crawler uses the WP REST API as primary discovery source (structured JSON,
 * no HTML parsing needed for listings). Falls back to legacy PHP site for older content.
 * Detail pages are still fetched as HTML and parsed with cheerio.
 *
 * SSL note: cpdp.bg serves an incomplete certificate chain (missing intermediate).
 * This script sets NODE_TLS_REJECT_UNAUTHORIZED=0 to work around the issue.
 *
 * Usage:
 *   npx tsx scripts/ingest-cpdp.ts
 *   npx tsx scripts/ingest-cpdp.ts --dry-run
 *   npx tsx scripts/ingest-cpdp.ts --resume
 *   npx tsx scripts/ingest-cpdp.ts --force --year-start 2022 --year-end 2024
 *   npx tsx scripts/ingest-cpdp.ts --limit 10 --verbose
 */

/**
 * cpdp.bg serves an incomplete SSL certificate chain (missing Thawte TLS RSA
 * CA G1 intermediate). Node.js rejects the connection by default. Setting
 * NODE_TLS_REJECT_UNAUTHORIZED=0 before any imports that open connections
 * works around this. Scoped to this ingestion script only.
 */
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

import Database from "better-sqlite3";
import * as cheerio from "cheerio";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SCHEMA_SQL } from "../src/db.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DB_PATH = process.env["CPDP_DB_PATH"] ?? "data/cpdp.db";
const STATE_PATH = resolve(__dirname, "../data/ingest-state.json");
const RATE_LIMIT_MS = 1500;
const MAX_RETRIES = 3;
const RETRY_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

const BASE_URL = "https://cpdp.bg";
const LEGACY_BASE_URL = "https://www.cpdp.bg";

/** WP REST API base for structured discovery (more reliable than HTML scraping). */
const WP_API_URL = `${BASE_URL}/wp-json/wp/v2`;

/** Category name prefixes for matching via WP REST API. */
const DECISIONS_CATEGORY_PREFIX = "Решения на КЗЛД за";
const OPINIONS_CATEGORY_PREFIX = "Становища на КЗЛД за";

const USER_AGENT =
  "Ansvar-CPDP-Crawler/1.0 (+https://ansvar.eu; compliance research)";

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface CliOptions {
  yearStart: number;
  yearEnd: number;
  limit: number;
  dryRun: boolean;
  resume: boolean;
  force: boolean;
  verbose: boolean;
}

function parseArgs(): CliOptions {
  const args = process.argv.slice(2);
  const opts: CliOptions = {
    yearStart: 2014,
    yearEnd: new Date().getFullYear(),
    limit: 0,
    dryRun: false,
    resume: false,
    force: false,
    verbose: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--year-start":
        opts.yearStart = parseInt(args[++i]!, 10);
        break;
      case "--year-end":
        opts.yearEnd = parseInt(args[++i]!, 10);
        break;
      case "--limit":
        opts.limit = parseInt(args[++i]!, 10);
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--resume":
        opts.resume = true;
        break;
      case "--force":
        opts.force = true;
        break;
      case "--verbose":
        opts.verbose = true;
        break;
      default:
        console.error(`Unknown argument: ${arg}`);
        process.exit(1);
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ListingEntry {
  url: string;
  title: string;
  date: string | null;
  /** "decision" or "opinion" — maps to DB tables */
  kind: "decision" | "opinion";
}

interface IngestState {
  /** URLs already processed (persisted for --resume) */
  processed: string[];
  lastRun: string;
}

interface CrawlStats {
  discovered: number;
  fetched: number;
  inserted: number;
  skipped: number;
  failed: number;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url: string, retries = MAX_RETRIES): Promise<string> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "bg,en;q=0.5",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return await res.text();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        const delay = RETRY_BACKOFF_MS * attempt;
        console.warn(`  [retry ${attempt}/${retries}] ${url} — ${msg} (waiting ${delay}ms)`);
        await sleep(delay);
      } else {
        throw new Error(`Failed after ${retries} attempts: ${url} — ${msg}`);
      }
    }
  }
  // unreachable, but satisfies TS
  throw new Error("fetchWithRetry: exhausted retries");
}

/**
 * Fetch JSON from the WP REST API with retries.
 * Sends Accept: application/json so the API returns JSON, not HTML.
 */
async function fetchJson<T>(url: string, retries = MAX_RETRIES): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        headers: {
          "User-Agent": USER_AGENT,
          "Accept": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }

      return (await res.json()) as T;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        const delay = RETRY_BACKOFF_MS * attempt;
        console.warn(`  [retry ${attempt}/${retries}] ${url} — ${msg} (waiting ${delay}ms)`);
        await sleep(delay);
      } else {
        throw new Error(`Failed after ${retries} attempts: ${url} — ${msg}`);
      }
    }
  }
  throw new Error("fetchJson: exhausted retries");
}

// ---------------------------------------------------------------------------
// WP REST API types
// ---------------------------------------------------------------------------

interface WpCategory {
  id: number;
  count: number;
  name: string;
  slug: string;
  parent: number;
}

interface WpPost {
  id: number;
  date: string;
  link: string;
  title: { rendered: string };
  content: { rendered: string };
}

// ---------------------------------------------------------------------------
// State persistence (for --resume)
// ---------------------------------------------------------------------------

function loadState(): IngestState {
  if (existsSync(STATE_PATH)) {
    try {
      return JSON.parse(readFileSync(STATE_PATH, "utf8")) as IngestState;
    } catch {
      // corrupt state — start fresh
    }
  }
  return { processed: [], lastRun: "" };
}

function saveState(state: IngestState): void {
  const dir = dirname(STATE_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// WordPress REST API discovery
// ---------------------------------------------------------------------------

/**
 * Discover WP category IDs for decisions/opinions by year range via REST API.
 *
 * The cpdp.bg WP theme does not render standard <article> elements on category
 * archive pages (it uses Elementor and shows "section-empty" even when posts
 * exist). The REST API is the reliable path to enumerate posts.
 *
 * Category name pattern: "Решения на КЗЛД за {year} г." / "Становища на КЗЛД за {year} г."
 */
async function discoverWpCategoryIds(
  kind: "decision" | "opinion",
  yearStart: number,
  yearEnd: number,
  verbose: boolean,
): Promise<Map<number, { catId: number; year: number }>> {
  const prefix = kind === "decision" ? DECISIONS_CATEGORY_PREFIX : OPINIONS_CATEGORY_PREFIX;
  const result = new Map<number, { catId: number; year: number }>();

  // Fetch all categories matching the prefix (paginate — WP default limit is 10)
  let page = 1;
  let hasMore = true;
  while (hasMore) {
    const url = `${WP_API_URL}/categories?per_page=100&page=${page}&search=${encodeURIComponent(prefix)}`;
    if (verbose) console.log(`  [api] Fetching categories page ${page}: ${url}`);

    try {
      const cats = await fetchJson<WpCategory[]>(url);
      for (const cat of cats) {
        // Match exact prefix pattern: "{prefix} {year} г."
        const yearMatch = cat.name.match(new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+(\\d{4})\\s+г\\.?$`));
        if (!yearMatch) continue;
        const year = parseInt(yearMatch[1]!, 10);
        if (year < yearStart || year > yearEnd) continue;
        if (cat.count === 0) continue;

        result.set(year, { catId: cat.id, year });
        if (verbose) console.log(`    ${cat.name}: id=${cat.id}, ${cat.count} posts`);
      }
      hasMore = cats.length === 100; // full page means there might be more
      page++;
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  [api] Error fetching categories: ${msg}`);
      hasMore = false;
    }
  }

  return result;
}

/**
 * Fetch all posts from a WP category by ID, handling pagination.
 * Returns ListingEntry items suitable for detail fetching.
 */
async function fetchPostsFromCategory(
  catId: number,
  kind: "decision" | "opinion",
  verbose: boolean,
): Promise<ListingEntry[]> {
  const entries: ListingEntry[] = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const url = `${WP_API_URL}/posts?categories=${catId}&per_page=100&page=${page}`;
    if (verbose) console.log(`  [api] Fetching posts catId=${catId} page ${page}`);

    try {
      const posts = await fetchJson<WpPost[]>(url);
      for (const post of posts) {
        // Strip HTML entities from title
        const title = post.title.rendered
          .replace(/&#8211;/g, "–")
          .replace(/&#8212;/g, "—")
          .replace(/&#8216;/g, "\u2018")
          .replace(/&#8217;/g, "\u2019")
          .replace(/&#8220;/g, "\u201c")
          .replace(/&#8221;/g, "\u201d")
          .replace(/&#8230;/g, "\u2026")
          .replace(/&amp;/g, "&")
          .replace(/&lt;/g, "<")
          .replace(/&gt;/g, ">")
          .replace(/&quot;/g, "\"")
          .replace(/&#8470;/g, "\u2116")
          .replace(/&#\d+;/g, "");

        const date = post.date ? post.date.slice(0, 10) : null;
        entries.push({ url: post.link, title, date, kind });
      }

      hasMore = posts.length === 100;
      page++;
      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // WP returns 400 for pages beyond the last — not an error
      if (/400/.test(msg)) {
        hasMore = false;
      } else {
        console.error(`  [api] Error fetching posts for catId=${catId}: ${msg}`);
        hasMore = false;
      }
    }
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Legacy PHP site crawler (fallback for older content)
// ---------------------------------------------------------------------------

/**
 * Fetch the practice index from the legacy site and discover year rubrics.
 *
 * The legacy "Practice" page (/index.php?p=rubric&aid=3) lists year-based
 * sub-rubrics (Решения за 20XX г., Становища за 20XX г.).
 */
async function discoverLegacyYearRubrics(
  verbose: boolean,
): Promise<{ url: string; label: string; kind: "decision" | "opinion" }[]> {
  const url = `${LEGACY_BASE_URL}/index.php?p=rubric&aid=3`;
  if (verbose) console.log(`  [legacy] Fetching practice index: ${url}`);

  const html = await fetchWithRetry(url);
  const $ = cheerio.load(html);
  const rubrics: { url: string; label: string; kind: "decision" | "opinion" }[] = [];

  $("a[href*='rubric_element'], a[href*='rubric&aid']").each((_i, el) => {
    const href = $(el).attr("href");
    const text = $(el).text().trim();
    if (!href || !text) return;

    const fullUrl = href.startsWith("http") ? href : `${LEGACY_BASE_URL}/${href.replace(/^\//, "")}`;

    if (/решени/i.test(text)) {
      rubrics.push({ url: fullUrl, label: text, kind: "decision" });
    } else if (/становищ/i.test(text)) {
      rubrics.push({ url: fullUrl, label: text, kind: "opinion" });
    }
  });

  return rubrics;
}

/**
 * Parse a legacy year-rubric page. Extracts links to individual decisions/opinions.
 *
 * These pages use offset-based pagination:
 *   /index.php?offset=10&p=rubric_element&aid=XXXX
 */
function parseLegacyRubricPage(html: string, kind: "decision" | "opinion"): {
  entries: ListingEntry[];
  nextUrl: string | null;
} {
  const $ = cheerio.load(html);
  const entries: ListingEntry[] = [];

  // Items are typically in <a href="index.php?p=element_view&aid=XXXX">Title</a>
  // inside <div class="rubric_element_item"> or similar containers
  $("a[href*='element_view'], a[href*='p=element&aid']").each((_i, el) => {
    const href = $(el).attr("href");
    const title = $(el).text().trim();
    if (!href || !title || title.length < 5) return;

    const fullUrl = href.startsWith("http") ? href : `${LEGACY_BASE_URL}/${href.replace(/^\//, "")}`;

    // Try to extract date from title — common patterns: "dd.mm.yyyy" or "XX.XX.XXXX г."
    let date: string | null = null;
    const m = title.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (m) {
      date = `${m[3]}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
    }

    entries.push({ url: fullUrl, title, date, kind });
  });

  // Pagination — look for "next" link with offset
  let nextUrl: string | null = null;
  $("a[href*='offset=']").each((_i, el) => {
    const text = $(el).text().trim();
    // "следваща", ">>", "Напред", or just ">"
    if (/следващ|>>|напред|›/i.test(text)) {
      const href = $(el).attr("href");
      if (href) {
        nextUrl = href.startsWith("http") ? href : `${LEGACY_BASE_URL}/${href.replace(/^\//, "")}`;
      }
    }
  });

  return { entries, nextUrl };
}

// ---------------------------------------------------------------------------
// Detail page parser
// ---------------------------------------------------------------------------

interface ParsedDetail {
  reference: string | null;
  title: string;
  date: string | null;
  body: string;
  /** For decisions: entity name if identifiable */
  entityName: string | null;
  /** For decisions: fine amount in BGN if mentioned */
  fineAmount: number | null;
  /** Decision type: наказателно_постановление, предписание, решение, etc. */
  decisionType: string | null;
  /** GDPR article references found in text */
  gdprArticles: string[];
  /** Data protection topics detected */
  topics: string[];
}

/**
 * Parse a detail page (WordPress post or legacy element_view).
 */
function parseDetailPage(html: string, fallbackTitle: string): ParsedDetail {
  const $ = cheerio.load(html);

  // Title — try WP post title first, then legacy page heading
  let title =
    $("h1.entry-title, h1.post-title, h1.page-title").first().text().trim() ||
    $("h1").first().text().trim() ||
    $(".element_title, .rubric_element_title").first().text().trim() ||
    fallbackTitle;

  // Date from meta or time element
  let date: string | null = null;
  const $time = $("time[datetime]").first();
  if ($time.length) {
    date = ($time.attr("datetime") ?? "").slice(0, 10) || null;
  }
  if (!date) {
    const $dateMeta = $('meta[property="article:published_time"]').first();
    if ($dateMeta.length) {
      date = ($dateMeta.attr("content") ?? "").slice(0, 10) || null;
    }
  }
  if (!date) {
    const dateMatch = title.match(/(\d{1,2})\.(\d{1,2})\.(\d{4})/);
    if (dateMatch) {
      date = `${dateMatch[3]}-${dateMatch[2]!.padStart(2, "0")}-${dateMatch[1]!.padStart(2, "0")}`;
    }
  }

  // Body content — WordPress .entry-content or legacy .element_content
  let body =
    $(".entry-content, .post-content, .the-content").first().text().trim() ||
    $(".element_content, .rubric_element_content, #content").first().text().trim() ||
    $("article").first().text().trim();

  // Clean up whitespace
  body = body.replace(/\s+/g, " ").trim();

  // Extract reference number from title or body
  // Common patterns: "ППН-01-XXX/dd.mm.yyyy", "рег. №", "Решение №"
  let reference: string | null = null;
  const refPatterns = [
    /(?:рег\.\s*№?\s*|Рег\.\s*№?\s*)(ППН-\d{2}-\d+\/[\d.]+\s*г\.?)/,
    /(?:рег\.\s*№?\s*|Рег\.\s*№?\s*)(Ж-\d+\/[\d.]+\s*г\.?)/,
    /(?:рег\.\s*№?\s*|Рег\.\s*№?\s*)(Н-\d+\/[\d.]+\s*г\.?)/,
    /(?:Решение\s*№?\s*)(\d+\/\d{4})/,
    /(?:НП-\S+)/,
  ];
  for (const pat of refPatterns) {
    const m = (title + " " + body.slice(0, 500)).match(pat);
    if (m) {
      reference = m[1] ?? m[0] ?? null;
      break;
    }
  }

  // Entity name — look for patterns like "срещу ...", "на ...", company suffixes
  let entityName: string | null = null;
  const entityPatterns = [
    /срещу\s+[„"«]?([^"»",.]{3,80}?)(?:[„"»"]|\s+за\s|\s+поради)/,
    /(?:на|към)\s+[„"«]?([^"»",.]{3,80}?\s+(?:ЕАД|ЕООД|ООД|АД|СД))(?:[„"»"]|[,.\s])/,
    /администратор(?:а|ът)?\s+[–—-]\s+[„"«]?([^"»",.]{3,80}?)(?:[„"»"]|[,.\s])/,
  ];
  for (const pat of entityPatterns) {
    const m = body.match(pat);
    if (m?.[1]) {
      entityName = m[1].trim();
      break;
    }
  }

  // Fine amount in BGN
  let fineAmount: number | null = null;
  const finePatterns = [
    /глоба\s+(?:в размер\s+)?(?:на|от)\s+([\d\s]+(?:\.\d+)?)\s*(?:лв|лева|BGN)/i,
    /имуществена санкция\s+(?:в размер\s+)?(?:на|от)\s+([\d\s]+(?:\.\d+)?)\s*(?:лв|лева|BGN)/i,
    /наказание\s+(?:в размер\s+)?(?:на|от)\s+([\d\s]+(?:\.\d+)?)\s*(?:лв|лева|BGN)/i,
    /([\d\s]+(?:\.\d+)?)\s*(?:лв|лева|BGN)\s+(?:глоба|санкция|наказание)/i,
  ];
  for (const pat of finePatterns) {
    const m = body.match(pat);
    if (m?.[1]) {
      const cleaned = m[1].replace(/\s/g, "");
      const val = parseFloat(cleaned);
      if (!isNaN(val) && val > 0) {
        fineAmount = val;
        break;
      }
    }
  }

  // Decision type classification
  let decisionType: string | null = null;
  const combinedText = (title + " " + body.slice(0, 1000)).toLowerCase();
  if (/наказателно\s+постановление/.test(combinedText)) {
    decisionType = "наказателно_постановление";
  } else if (/предписание/.test(combinedText)) {
    decisionType = "предписание";
  } else if (/становище/.test(combinedText)) {
    decisionType = "становище";
  } else if (/насок[аи]/.test(combinedText)) {
    decisionType = "насока";
  } else if (/ръководство/.test(combinedText)) {
    decisionType = "ръководство";
  } else if (/решение/.test(combinedText)) {
    decisionType = "решение";
  }

  // GDPR article references — match "чл. N", "член N", "Art. N", "Article N"
  const gdprArticles: string[] = [];
  const artRegex = /(?:чл\.|член|Art\.|Article)\s*(\d{1,3})(?:\s*,\s*(?:ал\.|параграф|§)\s*\d+)?/gi;
  let artMatch: RegExpExecArray | null;
  const artSeen = new Set<string>();
  while ((artMatch = artRegex.exec(body)) !== null) {
    const artNum = artMatch[1]!;
    // GDPR has articles 1–99
    if (parseInt(artNum, 10) >= 1 && parseInt(artNum, 10) <= 99 && !artSeen.has(artNum)) {
      artSeen.add(artNum);
      gdprArticles.push(artNum);
    }
  }

  // Topic detection based on keywords in Bulgarian
  const topics: string[] = [];
  const topicKeywords: [string, RegExp][] = [
    ["consent", /съгласие|валидно\s+съгласие|оттегляне\s+на\s+съгласие/i],
    ["cookies", /бисквитк[аи]|тракер[и]|cookie/i],
    ["transfers", /предаван[ие]\s+(?:на\s+)?данни|трансфер|трети\s+страни|глава\s+V/i],
    ["dpia", /оценка\s+на\s+въздействието|ОВЗД|DPIA/i],
    ["breach_notification", /нарушение\s+на\s+сигурността|изтичане\s+на\s+данни|уведомяване.*72\s*час/i],
    ["privacy_by_design", /на\s+ниво\s+проектиране|по\s+подразбиране|privacy\s+by\s+design|техническ[аи]\s+мерк/i],
    ["employee_monitoring", /наблюдение\s+на\s+служител|мониторинг\s+на\s+служител|видеонаблюдение\s+на\s+работ/i],
    ["health_data", /здравн[аио]\s+данн|медицинск[аио]\s+данн|здравно\s+досие/i],
    ["children", /данни\s+на\s+дец[аи]|непълнолетн|деца\s+под\s+\d/i],
  ];
  for (const [topicId, regex] of topicKeywords) {
    if (regex.test(body)) {
      topics.push(topicId);
    }
  }

  return {
    reference,
    title,
    date,
    body,
    entityName,
    fineAmount,
    decisionType,
    gdprArticles,
    topics,
  };
}

// ---------------------------------------------------------------------------
// Discovery: collect listing entries from both site versions
// ---------------------------------------------------------------------------

/**
 * Discover entries via the WP REST API.
 *
 * The WordPress theme on cpdp.bg (Flavor + Elementor) does not render standard
 * <article> elements on category archive pages — category pages return HTTP 200
 * with an empty "section-empty not-found" div even when posts exist. The REST
 * API at /wp-json/wp/v2/ is the reliable path.
 */
async function discoverWpEntries(
  kind: "decision" | "opinion",
  yearStart: number,
  yearEnd: number,
  verbose: boolean,
): Promise<ListingEntry[]> {
  const all: ListingEntry[] = [];

  // Step 1: discover category IDs matching the year range
  const categoryMap = await discoverWpCategoryIds(kind, yearStart, yearEnd, verbose);

  if (categoryMap.size === 0) {
    if (verbose) console.log(`  [api] No ${kind} categories found for ${yearStart}–${yearEnd}`);
    return all;
  }

  // Step 2: fetch posts from each category
  const catEntries = Array.from(categoryMap.entries());
  for (const [year, { catId }] of catEntries) {
    if (verbose) console.log(`  [api] Fetching ${kind} posts for ${year} (catId=${catId})`);
    const entries = await fetchPostsFromCategory(catId, kind, verbose);
    all.push(...entries);
    if (verbose) console.log(`    ${year}: ${entries.length} entries`);
  }

  return all;
}

async function discoverLegacyEntries(
  yearStart: number,
  yearEnd: number,
  verbose: boolean,
): Promise<ListingEntry[]> {
  const all: ListingEntry[] = [];

  try {
    const rubrics = await discoverLegacyYearRubrics(verbose);
    await sleep(RATE_LIMIT_MS);

    for (const rubric of rubrics) {
      // Filter by year range — try to extract year from rubric label
      const yearMatch = rubric.label.match(/(\d{4})/);
      if (yearMatch) {
        const year = parseInt(yearMatch[1]!, 10);
        if (year < yearStart || year > yearEnd) continue;
      }

      if (verbose) console.log(`  [legacy] Rubric: ${rubric.label}`);

      let currentUrl: string | null = rubric.url;
      while (currentUrl) {
        try {
          const html = await fetchWithRetry(currentUrl);
          const result = parseLegacyRubricPage(html, rubric.kind);

          all.push(...result.entries);
          currentUrl = result.nextUrl;

          if (verbose) console.log(`    Found ${result.entries.length} entries`);
          await sleep(RATE_LIMIT_MS);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(`  [legacy] Error fetching rubric page: ${msg}`);
          currentUrl = null;
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  [legacy] Error discovering rubrics: ${msg}`);
  }

  return all;
}

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

/**
 * Deduplicate listing entries by URL. When the same content appears on both
 * the WordPress and legacy sites, prefer WordPress (better HTML structure).
 */
function deduplicateEntries(entries: ListingEntry[]): ListingEntry[] {
  const seen = new Map<string, ListingEntry>();

  for (const entry of entries) {
    // Normalize URL for dedup — strip trailing slash, lowercase host
    const normalized = entry.url.replace(/\/+$/, "").toLowerCase();

    if (!seen.has(normalized)) {
      seen.set(normalized, entry);
    }
  }

  return Array.from(seen.values());
}

// ---------------------------------------------------------------------------
// Database operations
// ---------------------------------------------------------------------------

function initDb(force: boolean): Database.Database {
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  if (force && existsSync(DB_PATH)) {
    unlinkSync(DB_PATH);
    console.log(`Deleted existing database at ${DB_PATH}`);
  }

  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);

  return db;
}

function insertDecision(
  db: Database.Database,
  detail: ParsedDetail,
  sourceUrl: string,
): boolean {
  const ref = detail.reference ?? sourceUrl;

  // Check if already exists
  const existing = db.prepare("SELECT id FROM decisions WHERE reference = ?").get(ref);
  if (existing) return false;

  db.prepare(`
    INSERT INTO decisions
      (reference, title, date, type, entity_name, fine_amount, summary, full_text, topics, gdpr_articles, status)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'final')
  `).run(
    ref,
    detail.title,
    detail.date,
    detail.decisionType,
    detail.entityName,
    detail.fineAmount,
    detail.body.length > 500 ? detail.body.slice(0, 500) + "..." : detail.body,
    detail.body,
    detail.topics.length > 0 ? JSON.stringify(detail.topics) : null,
    detail.gdprArticles.length > 0 ? JSON.stringify(detail.gdprArticles) : null,
  );

  return true;
}

function insertGuideline(
  db: Database.Database,
  detail: ParsedDetail,
  sourceUrl: string,
): boolean {
  const ref = detail.reference ?? sourceUrl;

  // Check for duplicates by title (guidelines may lack reference numbers)
  const existing = db.prepare(
    "SELECT id FROM guidelines WHERE reference = ? OR title = ?",
  ).get(ref, detail.title);
  if (existing) return false;

  db.prepare(`
    INSERT INTO guidelines
      (reference, title, date, type, summary, full_text, topics, language)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'bg')
  `).run(
    ref,
    detail.title,
    detail.date,
    detail.decisionType ?? "становище",
    detail.body.length > 500 ? detail.body.slice(0, 500) + "..." : detail.body,
    detail.body,
    detail.topics.length > 0 ? JSON.stringify(detail.topics) : null,
  );

  return true;
}

// ---------------------------------------------------------------------------
// Main pipeline
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();

  console.log("=== CPDP Ingestion Crawler ===\n");
  console.log(`Years:     ${opts.yearStart}–${opts.yearEnd}`);
  console.log(`Limit:     ${opts.limit || "none"}`);
  console.log(`Dry run:   ${opts.dryRun}`);
  console.log(`Resume:    ${opts.resume}`);
  console.log(`Force:     ${opts.force}`);
  console.log(`DB:        ${DB_PATH}`);
  console.log("");

  // Load resume state
  const state = opts.resume ? loadState() : { processed: [], lastRun: "" };
  const processedSet = new Set(state.processed);

  if (opts.resume && processedSet.size > 0) {
    console.log(`Resuming — ${processedSet.size} URLs already processed\n`);
  }

  // Phase 1: Discovery
  console.log("--- Phase 1: Discovery ---\n");

  const wpDecisions = await discoverWpEntries("decision", opts.yearStart, opts.yearEnd, opts.verbose);
  await sleep(RATE_LIMIT_MS);
  const wpOpinions = await discoverWpEntries("opinion", opts.yearStart, opts.yearEnd, opts.verbose);
  await sleep(RATE_LIMIT_MS);
  const legacyEntries = await discoverLegacyEntries(opts.yearStart, opts.yearEnd, opts.verbose);

  const allEntries = deduplicateEntries([...wpDecisions, ...wpOpinions, ...legacyEntries]);

  console.log(`\nDiscovery complete:`);
  console.log(`  WP API decisions:    ${wpDecisions.length}`);
  console.log(`  WP API opinions:     ${wpOpinions.length}`);
  console.log(`  Legacy entries:      ${legacyEntries.length}`);
  console.log(`  After dedup:         ${allEntries.length}`);

  // Apply limit
  let toProcess = allEntries.filter((e) => !processedSet.has(e.url));
  if (opts.limit > 0) {
    toProcess = toProcess.slice(0, opts.limit);
  }

  console.log(`  To process:          ${toProcess.length}\n`);

  if (toProcess.length === 0) {
    console.log("Nothing to process. Done.");
    return;
  }

  if (opts.dryRun) {
    console.log("--- Dry Run: would fetch these URLs ---\n");
    for (const entry of toProcess) {
      console.log(`  [${entry.kind}] ${entry.title}`);
      console.log(`          ${entry.url}`);
    }
    console.log(`\n${toProcess.length} entries would be processed. Exiting (dry run).`);
    return;
  }

  // Phase 2: Fetch and parse detail pages, insert into DB
  console.log("--- Phase 2: Fetch & Insert ---\n");

  const db = initDb(opts.force);
  const stats: CrawlStats = { discovered: allEntries.length, fetched: 0, inserted: 0, skipped: 0, failed: 0 };

  for (let i = 0; i < toProcess.length; i++) {
    const entry = toProcess[i]!;
    const progress = `[${i + 1}/${toProcess.length}]`;

    try {
      if (opts.verbose) console.log(`${progress} Fetching: ${entry.url}`);

      const html = await fetchWithRetry(entry.url);
      stats.fetched++;

      const detail = parseDetailPage(html, entry.title);

      // Use date from listing if detail page did not yield one
      if (!detail.date && entry.date) {
        detail.date = entry.date;
      }

      // Minimum content threshold — skip pages with too little text
      if (detail.body.length < 100) {
        if (opts.verbose) console.log(`${progress} Skipped (body too short: ${detail.body.length} chars)`);
        stats.skipped++;
        processedSet.add(entry.url);
        continue;
      }

      let inserted: boolean;
      if (entry.kind === "decision") {
        inserted = insertDecision(db, detail, entry.url);
      } else {
        inserted = insertGuideline(db, detail, entry.url);
      }

      if (inserted) {
        stats.inserted++;
        console.log(`${progress} Inserted ${entry.kind}: ${detail.title.slice(0, 80)}`);
      } else {
        stats.skipped++;
        if (opts.verbose) console.log(`${progress} Skipped (duplicate): ${detail.title.slice(0, 80)}`);
      }

      processedSet.add(entry.url);

      // Save state periodically (every 10 items)
      if ((i + 1) % 10 === 0) {
        state.processed = Array.from(processedSet);
        state.lastRun = new Date().toISOString();
        saveState(state);
      }

      await sleep(RATE_LIMIT_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${progress} FAILED: ${entry.url} — ${msg}`);
      stats.failed++;
      // Still mark as processed to avoid re-fetching on resume
      processedSet.add(entry.url);
    }
  }

  // Final state save
  state.processed = Array.from(processedSet);
  state.lastRun = new Date().toISOString();
  saveState(state);

  // Summary
  const decisionCount = (db.prepare("SELECT count(*) as cnt FROM decisions").get() as { cnt: number }).cnt;
  const guidelineCount = (db.prepare("SELECT count(*) as cnt FROM guidelines").get() as { cnt: number }).cnt;

  console.log("\n=== Ingestion Complete ===\n");
  console.log(`  Discovered:  ${stats.discovered}`);
  console.log(`  Fetched:     ${stats.fetched}`);
  console.log(`  Inserted:    ${stats.inserted}`);
  console.log(`  Skipped:     ${stats.skipped}`);
  console.log(`  Failed:      ${stats.failed}`);
  console.log("");
  console.log(`Database totals (${DB_PATH}):`);
  console.log(`  Decisions:   ${decisionCount}`);
  console.log(`  Guidelines:  ${guidelineCount}`);

  db.close();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
