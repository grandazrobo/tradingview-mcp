import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

export const BRIEFS_DIR = join(
  homedir(), 'Documents', 'Ai Brain', '05_Memory',
  'ai-trading-platform', 'briefs'
);

export const FEEDS_DIR = join(
  homedir(), 'Documents', 'Ai Brain', '05_Memory',
  'ai-trading-platform', 'feeds', 'chart-hackers'
);

export function todayNZT() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Pacific/Auckland' }));
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

export function briefPath(date) {
  return join(BRIEFS_DIR, `${date}_chart-hackers-synthesis.md`);
}

export function feedPath(date) {
  return join(FEEDS_DIR, `${date}.md`);
}

// Extract the first numeric value from a markdown string (strips bold, commas, $ prefix)
function extractNumber(str) {
  if (!str) return null;
  const clean = str.replace(/\*+/g, '').replace(/,/g, '').replace(/\$/g, '');
  const m = clean.match(/(\d+\.?\d*)/);
  return m ? parseFloat(m[1]) : null;
}

// Extract a price from a stop field — handles "1H close above 79,500" by finding
// the number after "above"/"below" rather than grabbing the "1" from "1H"
function extractStopPrice(str) {
  if (!str) return null;
  const clean = str.replace(/\*+/g, '').replace(/,/g, '').replace(/\$/g, '');
  const aboveBelow = clean.match(/(?:above|below)\s+([\d]+\.?\d*)/i);
  if (aboveBelow) return parseFloat(aboveBelow[1]);
  return extractNumber(str);
}

// Normalise conviction strings including "MEDIUM-HIGH", "LOW-MEDIUM" etc.
function normalizeConviction(raw) {
  const u = raw.toUpperCase();
  if (u.includes('HIGH')) return 'HIGH';
  if (u.includes('MEDIUM') || u.includes('MED')) return 'MEDIUM';
  if (u.includes('LOW')) return 'LOW';
  return u;
}

// Infer exchange:symbol from card title when no ATP instrument field exists
function inferSymbolFromTitle(title) {
  if (/\bBTC\b/i.test(title)) return 'KUCOIN:BTCUSDT';
  const m = title.match(/^#\d+\s*[—\-–]+\s*([A-Z0-9]{2,10})\s+(?:short|long)/i);
  if (m) {
    const t = m[1].toUpperCase();
    return t.endsWith('USDT') ? `KUCOIN:${t}` : `KUCOIN:${t}USDT`;
  }
  return null;
}

// True when the entry is a future conditional, not an actionable limit price
function isConditional(str) {
  if (!str) return false;
  return /1h close (below|above)|pending sweep|wait for|retest from below|breakdown trigger|manage by structure|held position/i.test(str);
}

// Parse a markdown table into a { field_lowercase: value } map (takes col[1] as value)
function parseTable(text) {
  const map = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('|')) continue;
    const cols = line.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length < 2) continue;
    const key = cols[0].toLowerCase();
    if (key === 'field' || /^[-|]+$/.test(key)) continue; // header / separator
    map[key] = cols[1];
  }
  return map;
}

// Case-insensitive partial-key lookup into the table map
function get(map, ...names) {
  for (const name of names) {
    for (const [k, v] of Object.entries(map)) {
      if (k.includes(name.toLowerCase())) return v;
    }
  }
  return null;
}

// "BTCUSDT.P on KuCoin Futures, 20× ..." → "KUCOIN:BTCUSDT"
function mapSymbol(raw) {
  if (!raw) return null;
  const kucoin = raw.match(/([A-Z0-9]+USDT)\.P/i);
  if (kucoin) return `KUCOIN:${kucoin[1].toUpperCase()}`;
  // Bare ticker like "HYPE" or "HYPEUSDT"
  const bare = raw.trim().split(/[\s,]/)[0].replace(/\.P$/i, '').toUpperCase();
  if (!bare) return null;
  return bare.endsWith('USDT') ? `KUCOIN:${bare}` : `KUCOIN:${bare}USDT`;
}

function parseFrontmatter(content) {
  const m = content.match(/^---\s*\n([\s\S]+?)\n---/);
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^(\w[\w_-]*):\s*(.+)/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
}

export function parseBrief(filePath) {
  if (!existsSync(filePath)) return null;

  const content = readFileSync(filePath, 'utf8');
  const fm = parseFrontmatter(content);
  const date = fm.date || null;
  const chartStatus = fm.chart_extraction_status || '';
  const chartUnconfirmed = /discord-login-needed|transcript.only/i.test(chartStatus);

  // Locate all trade card headings: ## #N — ...
  const headingRe = /^## (#\d+[^\n]+)/gm;
  const headings = [];
  let m;
  while ((m = headingRe.exec(content)) !== null) {
    headings.push({ title: m[1].trim(), index: m.index });
  }

  const cards = [];
  const skipped = [];

  for (let i = 0; i < headings.length; i++) {
    const { title, index } = headings[i];
    const end = i + 1 < headings.length ? headings[i + 1].index : content.length;
    const section = content.slice(index, end);

    // Extract conviction — handles "(HIGH conviction)", "(MEDIUM-HIGH conviction)", "— MEDIUM-HIGH conviction"
    const convMatch = title.match(/\(([\w-]+)\s+conviction[^)]*\)/i)
      ?? title.match(/[—\-–]\s*([\w-]+)\s+conviction/i);
    const conviction = convMatch ? normalizeConviction(convMatch[1]) : null;

    if (!conviction || conviction === 'LOW') {
      skipped.push(`${title} — skipped (conviction: ${conviction || 'none'})`);
      continue;
    }

    const fields = parseTable(section);

    // Direction
    const biasRaw = get(fields, 'bias');
    const direction = /long/i.test(biasRaw ?? '') ? 'long'
      : /short/i.test(biasRaw ?? '') ? 'short' : null;
    if (!direction) {
      skipped.push(`${title} — skipped (no direction in bias: "${biasRaw}")`);
      continue;
    }

    // Entry — priority order
    const entryRaw = get(fields, 'best entry', 'entry zone', 'entry trigger', 'retest', 'entry');
    if (!entryRaw) {
      skipped.push(`${title} — skipped (no entry field)`);
      continue;
    }
    if (isConditional(entryRaw)) {
      skipped.push(`${title} — skipped (conditional entry: "${entryRaw.slice(0, 60)}")`);
      continue;
    }
    const entry_price = extractNumber(entryRaw);
    if (!entry_price) {
      skipped.push(`${title} — skipped (unparseable entry: "${entryRaw.slice(0, 60)}")`);
      continue;
    }

    // Stop — hard stop is a plain price, soft stop may be "1H close above X" (use extractStopPrice)
    const hardStopRaw = get(fields, 'hard stop');
    const softStopRaw = get(fields, 'stop');
    let stop_price = hardStopRaw ? extractNumber(hardStopRaw) : null;
    if (!stop_price) stop_price = softStopRaw ? extractStopPrice(softStopRaw) : null;
    if (!stop_price) {
      skipped.push(`${title} — skipped (no parseable stop)`);
      continue;
    }

    // Stop must be on the correct side of entry
    const stopOk = direction === 'long' ? stop_price < entry_price : stop_price > entry_price;
    if (!stopOk) {
      skipped.push(`${title} — skipped (stop ${stop_price} wrong side of entry ${entry_price} for ${direction})`);
      continue;
    }

    // TPs
    const tp1Raw = get(fields, 'tp1');
    const tp2Raw = get(fields, 'tp2') ?? get(fields, 'tp3'); // use TP3 as TP2 if TP2 absent
    const tp1_price = tp1Raw ? extractNumber(tp1Raw) : null;
    const tp2_price = tp2Raw ? extractNumber(tp2Raw) : null;
    if (!tp1_price || !tp2_price) {
      skipped.push(`${title} — skipped (missing TP1 or TP2)`);
      continue;
    }

    // Symbol — try ATP instrument field first, fall back to inferring from card title
    const atpRaw = get(fields, 'atp instrument');
    const symbol = mapSymbol(atpRaw) ?? inferSymbolFromTitle(title);
    if (!symbol) {
      skipped.push(`${title} — skipped (can't parse symbol from: "${atpRaw}")`);
      continue;
    }

    // Leverage
    const leverageRaw = get(fields, 'suggested leverage', 'leverage');
    const leverage = leverageRaw ? (extractNumber(leverageRaw) || 20) : 20;

    // Margin: BTC = $1000, alts = $500
    const margin_usd = symbol.includes('BTC') ? 1000 : 500;

    cards.push({
      card_title: title,
      symbol,
      direction,
      entry_price,
      stop_price,
      tp1_price,
      tp1_split: 30,
      tp2_price,
      tp2_split: 70,
      margin_usd,
      leverage,
      conviction,
      source: `chart-hackers-dylan-${date}`,
      chart_unconfirmed: chartUnconfirmed,
    });
  }

  return { date, cards, skipped, chart_unconfirmed: chartUnconfirmed };
}
