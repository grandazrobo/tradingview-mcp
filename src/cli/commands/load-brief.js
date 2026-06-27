import { register } from '../router.js';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';
import { parseBrief, briefPath, todayNZT } from '../../bridge/brief-parser.js';
import { fetchBinancePrice, fetchMTFContext, assessSetup, buildExecutionPlan } from '../../bridge/tv-context.js';
import { switchTabByName } from '../../core/tab.js';
import { assessIADSS } from '../../bridge/iadss-rules.js';
import { assessChartPrime } from '../../bridge/chartprime-rules.js';
import { notifyBriefLoaded } from '../../discord/notifier.js';
import { checkTrade } from '../../bridge/trade-checker.js';

const LOADED_LOG = join(homedir(), '.tv-atp-loaded-briefs.json');
const DASH_URL = 'http://localhost:3333';

function loadLog() {
  if (!existsSync(LOADED_LOG)) return {};
  try { return JSON.parse(readFileSync(LOADED_LOG, 'utf8')); } catch { return {}; }
}

function saveLog(log) {
  writeFileSync(LOADED_LOG, JSON.stringify(log, null, 2));
}

function baseOf(symbol) {
  const ticker = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  return ticker.replace(/(USDT|USDC|USD|BUSD|PERP)$/i, '').toUpperCase();
}

async function fetchOpenTrades() {
  try {
    const res = await fetch(`${DASH_URL}/api/state`);
    const state = await res.json();
    return state.open_trades ?? [];
  } catch {
    return null; // null = server not reachable
  }
}

async function postTrade(card) {
  const res = await fetch(`${DASH_URL}/api/trade/open`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  });
  return res.json();
}

async function postQueuedTrade(card) {
  const res = await fetch(`${DASH_URL}/api/queue/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(card),
  });
  return res.json();
}

async function postHeld(card, reason) {
  const res = await fetch(`${DASH_URL}/api/held`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ card, reason }),
  });
  return res.json();
}

function fmt(n) {
  if (n === null || n === undefined) return '—';
  return n >= 1000 ? n.toLocaleString('en-US') : String(n);
}

// Leverage scaling based on IADSS score — only for tiers validated in historical analysis.
// BTC (20×) and 10× alts are not in the table — they stay unchanged.
const LEVERAGE_SCALE_TABLE = { 3: 10, 4: 15, 5: 20 };

function applyIADSSLeverage(leverage, iadss) {
  if (!iadss?.available || iadss.score < 2) return leverage; // NEUTRAL or AGAINST — no change
  return LEVERAGE_SCALE_TABLE[leverage] ?? leverage;
}

function writeReport({ date, filePath, cards, queued, skipped, loaded, queued_loaded, conflicts, errors, held = [], mode, assessments, mtfContexts, iadssResults, cpResults }) {
  const now = new Date().toLocaleString('en-NZ', { timeZone: 'Pacific/Auckland', hour12: false });
  const reportPath = join(dirname(filePath), `${date}_chart-hackers-load-report.md`);

  // Build a lookup of what happened to each card by title
  const loadedTitles = new Set(loaded.map(l => l.card_title));
  const conflictMap = new Map(conflicts.map(c => [c.card_title, c.reason]));
  const errorMap = new Map(errors.map(e => [e.card_title, e.error]));
  const heldMap = new Map(held.map(h => [h.card_title, h.reason]));

  // All cards that passed parsing
  const allParsed = [...cards];
  // All cards that were skipped during parsing (with reason)
  const allSkipped = skipped;

  const lines = [
    `---`,
    `tags: [load-report, atp, chart-hackers]`,
    `date: ${date}`,
    `generated: ${now} NZT`,
    `mode: ${mode}`,
    `---`,
    ``,
    `# Chart Hackers — TVDash Load Report — ${date}`,
    ``,
    `**Generated:** ${now} NZT  `,
    `**Mode:** ${mode === 'execute' ? '✅ Executed' : '🔍 Dry run'}  `,
    `**Loaded:** ${loaded.length} trade(s)  `,
    `**Queued:** ${(queued ?? []).length} setup(s)  `,
    `**Held (checker):** ${held.length}  `,
    `**Skipped (rules):** ${allSkipped.length}  `,
    `**Conflicts (already open):** ${conflicts.length}  `,
    ``,
    `---`,
    ``,
    `## All Cards Considered`,
    ``,
    `| Card | Conviction | Price Now | Status | IADSS | CP | Rules | Action |`,
    `|---|---|---|---|---|---|---|---|`,
  ];

  // Cards that passed parsing
  for (const card of allParsed) {
    const conviction = card.conviction;
    const assessment = assessments?.get(card.card_title);
    const iadss = iadssResults?.get(card.card_title);
    const cp    = cpResults?.get(card.card_title);
    const priceCol  = assessment?.current_price ? assessment.current_price.toLocaleString() : '—';
    const statusCol = assessment?.status ?? '—';
    const iadssCol  = iadss?.available ? `${iadss.emoji} ${iadss.score > 0 ? '+' : ''}${iadss.score}` : '—';
    const cpCol     = cp?.available    ? `${cp.emoji} ${cp.score > 0 ? '+' : ''}${cp.score}`         : '—';
    if (loadedTitles.has(card.card_title)) {
      lines.push(`| ${card.card_title} | **${conviction}** | ${priceCol} | ${statusCol} | ${iadssCol} | ${cpCol} | ✅ Pass | **Loaded** — ${card.direction.toUpperCase()} ${card.symbol.split(':').pop()} |`);
    } else if (conflictMap.has(card.card_title)) {
      lines.push(`| ${card.card_title} | ${conviction} | ${priceCol} | ${statusCol} | ${iadssCol} | ${cpCol} | ✅ Pass | ⚠️ ${conflictMap.get(card.card_title)} |`);
    } else if (errorMap.has(card.card_title)) {
      lines.push(`| ${card.card_title} | ${conviction} | ${priceCol} | ${statusCol} | ${iadssCol} | ${cpCol} | ✅ Pass | ❌ Error: ${errorMap.get(card.card_title)} |`);
    } else if (heldMap.has(card.card_title)) {
      lines.push(`| ${card.card_title} | ${conviction} | ${priceCol} | ${statusCol} | ${iadssCol} | ${cpCol} | ⏸ Held | ${heldMap.get(card.card_title)} |`);
    } else {
      lines.push(`| ${card.card_title} | ${conviction} | ${priceCol} | ${statusCol} | ${iadssCol} | ${cpCol} | ✅ Pass | — (dry run) |`);
    }
  }

  // Queued setups in main cards table
  for (const q of (queued ?? [])) {
    const assessment = assessments?.get(q.card_title);
    const iadss = iadssResults?.get(q.card_title);
    const cp    = cpResults?.get(q.card_title);
    const priceCol  = assessment?.current_price ? assessment.current_price.toLocaleString() : '—';
    const statusCol = assessment?.status ?? '—';
    const iadssCol  = iadss?.available ? `${iadss.emoji} ${iadss.score > 0 ? '+' : ''}${iadss.score}` : '—';
    const cpCol     = cp?.available    ? `${cp.emoji} ${cp.score > 0 ? '+' : ''}${cp.score}`         : '—';
    const isQueued  = (queued_loaded ?? []).some(ql => ql.card_title === q.card_title);
    const action    = isQueued ? '⏳ Queued' : mode === 'dry_run' ? '⏳ (dry run)' : '⏳ Queued';
    lines.push(`| ${q.card_title} | ${q.conviction ?? '—'} | ${priceCol} | ${statusCol} | ${iadssCol} | ${cpCol} | ✅ Queued | ${action} |`);
  }

  // Cards skipped during parsing (failed rules)
  for (const s of allSkipped) {
    const dashIdx = s.indexOf(' — skipped');
    const title = dashIdx > -1 ? s.slice(0, dashIdx) : s;
    const reason = dashIdx > -1 ? s.slice(dashIdx + 11) : '';
    lines.push(`| ${title} | — | — | — | — | — | ❌ ${reason.replace(/^\(|\)$/g, '')} | Skipped |`);
  }

  if ((queued ?? []).length > 0) {
    lines.push(``);
    lines.push(`---`);
    lines.push(``);
    lines.push(`## Queued Setups (conditional entry — monitoring)`);
    lines.push(``);
    lines.push(`| Card | Entry Zone | Distance | Invalidation | Condition | Action |`);
    lines.push(`|---|---|---|---|---|---|`);
    for (const q of queued) {
      const queued_result = (queued_loaded ?? []).find(ql => ql.card_title === q.card_title);
      const action = queued_result ? '⏳ Queued' : mode === 'dry_run' ? '⏳ (dry run)' : '⏳ Queued';
      const inval = q.invalidation_price ? `${q.invalidation_direction ?? ''} ${q.invalidation_price}`.trim() : '—';
      const assessment = assessments?.get(q.card_title);
      const distCol = assessment?.distance_pct != null ? `${assessment.distance_pct.toFixed(1)}%` : '—';
      lines.push(`| ${q.card_title} | ${q.entry_zone} | ${distCol} | ${inval} | ${(q.entry_condition ?? '').slice(0, 60)} | ${action} |`);
    }
  }

  lines.push(``);
  lines.push(`---`);
  lines.push(``);
  lines.push(`## Execution Plan`);
  lines.push(``);

  // All actionable cards = loaded + conflict + dry-run pass
  const actionableCards = allParsed.filter(c =>
    loadedTitles.has(c.card_title) || conflictMap.has(c.card_title) || mode === 'dry_run'
  );

  if (actionableCards.length === 0) {
    lines.push(`_No cards passed rules check._`);
  } else {
    for (const card of actionableCards) {
      const assessment = assessments?.get(card.card_title) ?? { status: 'UNKNOWN', note: 'No price data' };
      lines.push(`### ${card.card_title}`);
      lines.push(``);
      lines.push(buildExecutionPlan(card, assessment, mtfContexts?.get(card.card_title), iadssResults?.get(card.card_title), cpResults?.get(card.card_title)));
      lines.push(``);
    }
  }

  if (conflicts.length > 0) {
    lines.push(`## Conflicts (already open — not loaded)`);
    lines.push(``);
    for (const c of conflicts) {
      lines.push(`- **${c.card_title}** — ${c.reason}`);
    }
    lines.push(``);
  }

  writeFileSync(reportPath, lines.join('\n'));
  return reportPath;
}

async function handler(opts, positionals) {
  const date = positionals[0] ?? todayNZT();
  const execute = opts.execute ?? false;

  const filePath = briefPath(date);

  if (!existsSync(filePath)) {
    return { success: false, date, error: `No synthesis brief found for ${date}`, path: filePath };
  }

  let { cards, queued: queuedCards = [], skipped, chart_unconfirmed } = parseBrief(filePath) ?? {};

  if (!cards) {
    return { success: false, date, error: 'Failed to parse brief' };
  }

  // Deduplication check
  const log = loadLog();
  if (log[date] && !opts.force) {
    return {
      success: false,
      date,
      error: `Brief for ${date} already loaded. Use --force to reload.`,
      previous_load: log[date],
    };
  }

  // Fetch current prices for all cards
  console.error('  Fetching current prices...');
  const assessments = new Map();
  const mtfContexts = new Map();
  const iadssResults = new Map();
  const cpResults    = new Map();

  for (const card of cards) {
    const price = await fetchBinancePrice(card.symbol);
    assessments.set(card.card_title, assessSetup(card, price));
  }

  // Also fetch prices for parser-queued cards (for distance display in report/dashboard)
  for (const card of queuedCards) {
    const price = await fetchBinancePrice(card.symbol);
    assessments.set(card.card_title, assessSetup({ ...card, entry_price: card.entry_zone }, price));
  }

  // Reroute all PENDING active cards to queue — price hasn't reached entry yet
  const pendingFarAsQueued = [];
  cards = cards.filter(card => {
    const a = assessments.get(card.card_title);
    if (a?.status === 'PENDING') {
      pendingFarAsQueued.push({
        ...card,
        entry_zone: card.entry_price,
        entry_condition: `${a.distance_pct?.toFixed(1) ?? '?'}% from entry — waiting for pullback to ${card.entry_price}`,
      });
      return false;
    }
    return true;
  });
  queuedCards = [...queuedCards, ...pendingFarAsQueued];

  // Skip any card whose stop is already hit — don't load it at all
  cards = cards.filter(card => {
    const a = assessments.get(card.card_title);
    if (a?.status === 'STOP HIT') {
      skipped.push(`${card.card_title} — skipped (stop already hit at load time)`);
      console.error(`  ✗ ${card.card_title} — stop already hit at load time, skipping`);
      return false;
    }
    return true;
  });

  // Ensure the 4-pane layout tab is active before reading indicator context
  try {
    const switched = await switchTabByName({ name: '4-pane' });
    console.error(`  Switched to tab: "${switched.title}"`);
    await new Promise(r => setTimeout(r, 1000));
  } catch {
    console.error('  ⚠ Could not switch to "4-pane" tab — using active tab');
  }

  // Fetch MTF indicator context per card (switches each pane to the card's symbol)
  console.error(`  Fetching multi-timeframe context for ${cards.length} card(s)...`);
  for (const card of cards) {
    console.error(`    ${card.symbol.split(':').pop()}...`);
    const mtf = await fetchMTFContext(card.symbol).catch(() => null);
    if (mtf) {
      const tfLabels = mtf.panes.map(p => p.timeframe).join('/');
      console.error(`      ✓ ${mtf.panes.length} pane(s): ${tfLabels}`);
      mtfContexts.set(card.card_title, mtf);
      // IADSS + ChartPrime assessments using MTF context
      const assessment = assessments.get(card.card_title);
      const iadss = assessIADSS(card, mtf, assessment?.current_price);
      iadssResults.set(card.card_title, iadss);
      const cp = assessChartPrime(card, mtf, assessment?.current_price);
      cpResults.set(card.card_title, cp);
      console.error(`      IADSS: ${iadss.emoji} ${iadss.rating} (${iadss.score > 0 ? '+' : ''}${iadss.score})`);
      console.error(`      CP:    ${cp.emoji} ${cp.rating} (${cp.score > 0 ? '+' : ''}${cp.score})`);
    } else {
      console.error(`      — TV not available, skipping MTF context`);
    }
  }

  // Apply IADSS-based leverage scaling (CONFIRMED/PARTIAL score ≥ 2 only)
  for (const card of cards) {
    const iadss = iadssResults.get(card.card_title);
    const scaled = applyIADSSLeverage(card.leverage, iadss);
    if (scaled !== card.leverage) {
      const label = card.card_title.split('—')[0].trim();
      console.error(`  ↑ ${label}: leverage ${card.leverage}× → ${scaled}× (IADSS ${iadss.rating} +${iadss.score})`);
      card.leverage = scaled;
    }
  }

  // Print what was parsed
  const summary = {
    date,
    file: filePath,
    chart_unconfirmed,
    cards_found: cards.length,
    queued_found: queuedCards.length,
    cards_skipped: skipped.length,
    skipped_reasons: skipped,
    cards,
  };

  if (!execute) {
    console.error('\n  DRY RUN — pass --execute to load into TVDash\n');
    console.error(`  Parsed ${cards.length} tradeable card(s), ${queuedCards.length} queued, skipped ${skipped.length}\n`);
    for (const c of cards) {
      const a = assessments.get(c.card_title);
      console.error(`  [${c.conviction}] ${c.card_title}`);
      console.error(`    ${c.symbol} ${c.direction.toUpperCase()} | Entry ${c.entry_price} | Stop ${c.stop_price} | TP1 ${c.tp1_price} | TP2 ${c.tp2_price} | ${c.leverage}× | $${c.margin_usd} margin`);
      if (a) console.error(`    Market: ${a.status} — ${a.note}`);
      const ia = iadssResults.get(c.card_title);
      const cp = cpResults.get(c.card_title);
      if (ia?.available) console.error(`    IADSS: ${ia.emoji} ${ia.rating} (${ia.score > 0 ? '+' : ''}${ia.score})`);
      if (cp?.available) console.error(`    CP:    ${cp.emoji} ${cp.rating} (${cp.score > 0 ? '+' : ''}${cp.score})`);
    }
    if (queuedCards.length > 0) {
      console.error('\n  Queued (conditional entry):');
      for (const q of queuedCards) {
        const inval = q.invalidation_price ? ` | Inval ${q.invalidation_direction ?? ''} ${q.invalidation_price}`.trim() : '';
        console.error(`    ⏳ [${q.conviction}] ${q.card_title}`);
        console.error(`       Zone ${q.entry_zone} | Stop ${q.stop_price}${inval}`);
        console.error(`       Condition: ${q.entry_condition}`);
      }
    }
    if (skipped.length > 0) {
      console.error('\n  Skipped:');
      for (const s of skipped) console.error(`    ✗ ${s}`);
    }
    console.error('');
    const reportPath = writeReport({ date, filePath, cards, queued: queuedCards, skipped, loaded: [], queued_loaded: [], conflicts: [], errors: [], held: [], mode: 'dry_run', assessments, mtfContexts, iadssResults, cpResults });
    console.error(`  Report written: ${reportPath}\n`);
    return { ...summary, mode: 'dry_run', queued: queuedCards.length, report: reportPath };
  }

  // Execute: check TVDash is up
  const openTrades = await fetchOpenTrades();
  if (openTrades === null) {
    return { success: false, error: 'TVDash not running at localhost:3333 — start it first with `tvdash`' };
  }

  // Track open positions as "BASE:direction" — same direction = conflict, opposite = fine
  const openPositions = new Set(openTrades.map(t => `${baseOf(t.symbol)}:${t.direction}`));
  const loaded = [];
  const conflicts = [];
  const errors = [];
  const held = [];

  for (const card of cards) {
    const base = baseOf(card.symbol);
    const key = `${base}:${card.direction}`;
    if (openPositions.has(key)) {
      conflicts.push({ card_title: card.card_title, symbol: card.symbol, reason: `${base} ${card.direction} already open — skipped` });
      console.error(`  ⚠ ${card.card_title} — ${base} ${card.direction} already open, skipping`);
      continue;
    }

    // Pre-trade sanity check
    const checkResult = await checkTrade(
      card,
      assessments.get(card.card_title),
      iadssResults.get(card.card_title),
      cpResults.get(card.card_title),
      mtfContexts.get(card.card_title) ?? null,
      openTrades,
    );
    if (checkResult.hold) {
      try {
        const result = await postHeld(card, checkResult.reason);
        if (result.success) {
          held.push({ card_title: card.card_title, symbol: card.symbol, held_id: result.held?.id, reason: checkResult.reason });
          console.error(`  ⏸ ${card.card_title} — held: ${checkResult.reason}`);
        } else {
          errors.push({ card_title: card.card_title, error: `hold failed: ${result.error}` });
          console.error(`  ✗ ${card.card_title} — hold POST failed: ${result.error}`);
        }
      } catch (e) {
        errors.push({ card_title: card.card_title, error: `hold request failed: ${e.message}` });
        console.error(`  ✗ ${card.card_title} — hold request failed: ${e.message}`);
      }
      continue;
    }

    try {
      const a = assessments.get(card.card_title);
      const isLong = card.direction === 'long';
      const atOrBetter = a?.current_price != null && (
        (isLong && a.current_price <= card.entry_price) ||
        (!isLong && a.current_price >= card.entry_price)
      );
      const tradeCard = atOrBetter
        ? { ...card, entry_price: a.current_price }
        : card;

      const result = await postTrade(tradeCard);
      if (result.success) {
        loaded.push({ card_title: card.card_title, symbol: card.symbol, trade_id: result.trade?.id });
        openPositions.add(key);
        if (atOrBetter && a.current_price !== card.entry_price) {
          console.error(`  ✓ ${card.card_title} — loaded at market ${a.current_price} (better than limit ${card.entry_price}, ${card.symbol} ${card.direction})`);
        } else {
          console.error(`  ✓ ${card.card_title} — loaded (${card.symbol} ${card.direction})`);
        }
      } else {
        errors.push({ card_title: card.card_title, error: result.error });
        console.error(`  ✗ ${card.card_title} — API error: ${result.error}`);
      }
    } catch (e) {
      errors.push({ card_title: card.card_title, error: e.message });
      console.error(`  ✗ ${card.card_title} — ${e.message}`);
    }
  }

  // Queue conditional cards
  const queued_loaded = [];
  const queue_errors = [];
  for (const card of queuedCards) {
    const base = baseOf(card.symbol);
    const key = `${base}:${card.direction}`;
    if (openPositions.has(key)) {
      console.error(`  ⏭ ${card.card_title} — ${base} ${card.direction} already open, skipping queue`);
      continue;
    }
    try {
      const result = await postQueuedTrade(card);
      if (result.success && result.action === 'immediate_load') {
        loaded.push({ card_title: card.card_title, symbol: card.symbol, trade_id: result.trade?.id });
        openPositions.add(`${baseOf(card.symbol)}:${card.direction}`);
        console.error(`  ✓ ${card.card_title} — loaded at market (pullback already ran, zone ${card.entry_zone} → market ${result.trade?.entry_price})`);
      } else if (result.success) {
        queued_loaded.push({ card_title: card.card_title, symbol: card.symbol, queued_id: result.queued?.id });
        console.error(`  ⏳ ${card.card_title} — queued (${card.symbol} ${card.direction} @ ${card.entry_zone})`);
      } else if (result.action === 'invalidated') {
        console.error(`  ✗ ${card.card_title} — invalidated at load time: ${result.reason}`);
      } else {
        queue_errors.push({ card_title: card.card_title, error: result.error });
        console.error(`  ✗ ${card.card_title} — queue error: ${result.error}`);
      }
    } catch (e) {
      queue_errors.push({ card_title: card.card_title, error: e.message });
      console.error(`  ✗ ${card.card_title} — ${e.message}`);
    }
  }

  // Persist deduplication log
  log[date] = {
    loaded_at: new Date().toISOString(),
    file: filePath,
    trade_ids: loaded.map(l => l.trade_id),
    trade_count: loaded.length,
    queued_count: queued_loaded.length,
    conflicts: conflicts.length,
    held_count: held.length,
    errors: errors.length,
  };
  saveLog(log);

  // Discord notification
  const topCard = cards[0];
  const topDesc = topCard
    ? `${topCard.symbol.split(':').pop()} ${topCard.direction.toUpperCase()} at ${topCard.entry_price} [${topCard.conviction}]`
    : 'none';
  await notifyBriefLoaded({
    date,
    loaded: loaded.length,
    skipped_parse: skipped.length,
    conflicts: conflicts.length,
    held: held.length,
    top_trade: topDesc,
    chart_unconfirmed,
  });

  const reportPath = writeReport({ date, filePath, cards, queued: queuedCards, skipped, loaded, queued_loaded, conflicts, errors, held, mode: 'execute', assessments, mtfContexts, iadssResults, cpResults });
  console.error(`\n  Report written: ${reportPath}`);

  return {
    success: true,
    date,
    mode: 'execute',
    loaded,
    queued: queued_loaded,
    held,
    conflicts,
    errors,
    skipped_parse: skipped,
    report: reportPath,
  };
}

register('load-brief', {
  description: 'Load today\'s Chart Hackers synthesis brief into TVDash paper trades',
  options: {
    execute: { type: 'boolean', description: 'Actually insert trades (default: dry run)' },
    force:   { type: 'boolean', description: 'Re-load even if already loaded today' },
  },
  handler,
});
