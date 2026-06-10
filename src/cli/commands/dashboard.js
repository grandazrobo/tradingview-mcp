import { register } from '../router.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import * as data from '../../core/data.js';
import * as chart from '../../core/chart.js';
import {
  loadState, resetState, openTrade, closeTrade, hitTp1,
  calcLivePnl, calcScorecard, saveState,
  queueTrade, removeQueued, updateQueued, activateQueued, invalidateQueued,
} from '../../dashboard/state.js';
import {
  notifyTradeOpen, notifyTp1Hit, notifyTradeClose,
} from '../../discord/notifier.js';
import { startBot } from '../../discord/bot.js';
import {
  findTargetByMode, activateTarget, switchTarget, listTabsWithInfo,
} from '../../connection.js';

const MODES = {
  scalping:      { label: 'Scalping',      resolutions: ['30S', '3', '5', '15'] },
  day_trading:   { label: 'Day Trading',   resolutions: ['15', '30', '60'] },
  swing_trading: { label: 'Swing Trading', resolutions: ['240', 'D', '1D'] },
  accumulation:  { label: 'Accumulation',  resolutions: ['W', '1W', 'M', '1M'] },
};

const __dirname = dirname(fileURLToPath(import.meta.url));

async function startDashboard({ port = 3333, reset = false } = {}) {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());

  let state = reset ? resetState() : loadState();

  if (state.active_mode && MODES[state.active_mode]) {
    findTargetByMode(state.active_mode)
      .then(target => {
        if (target) return switchTarget(target.id);
        state.active_mode = null;
        saveState(state);
      })
      .catch(() => { state.active_mode = null; saveState(state); });
  }

  let currentQuote = null;
  const priceMap = {};  // symbol → last price

  // Normalise to base currency so KUCOIN:SOLUSDT and BINANCE:SOLUSDT both key as "SOL"
  function baseOf(sym) {
    const ticker = sym.includes(':') ? sym.split(':')[1] : sym;
    return ticker.replace(/(USDT|USDC|USD|BUSD|PERP)$/i, '').toUpperCase();
  }

  // ── Price polling ──────────────────────────────────────────────

  // TradingView poll — keeps currentQuote fresh for header display
  async function pollTVPrice() {
    try {
      const q = await data.getQuote({});
      if (q?.last && q?.symbol) {
        currentQuote = q;
        updatePrice(baseOf(q.symbol), q.last);
      }
    } catch { /* TV may be loading */ }
  }

  // Binance REST poll — fetches prices for every open trade symbol simultaneously
  async function pollAllPrices() {
    const bases = [...new Set(state.open_trades.map(t => baseOf(t.symbol)))];
    if (bases.length === 0) return;
    const symbols = bases.map(b => b + 'USDT');
    try {
      const url = `https://api.binance.com/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
      const resp = await fetch(url);
      const prices = await resp.json();
      if (Array.isArray(prices)) {
        for (const { symbol, price } of prices) {
          updatePrice(symbol.replace(/USDT$/i, ''), parseFloat(price));
        }
      } else {
        // Batch failed (likely one invalid symbol) — fall back to individual requests
        await Promise.all(symbols.map(async sym => {
          try {
            const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}`);
            const d = await r.json();
            if (d.price) updatePrice(sym.replace(/USDT$/i, ''), parseFloat(d.price));
          } catch { /* symbol not on Binance */ }
        }));
      }
    } catch { /* external API unavailable */ }
  }

  function updatePrice(base, price) {
    priceMap[base] = price;
    checkAutoClose(base, price);
  }

  function checkAutoClose(base, price) {
    for (const trade of [...state.open_trades]) {
      if (baseOf(trade.symbol) !== base) continue;
      const isLong = trade.direction === 'long';

      // TP1 check
      if (!trade.tp1_hit) {
        const tp1Hit = isLong ? price >= trade.tp1_price : price <= trade.tp1_price;
        if (tp1Hit) { const t = hitTp1(state, trade.id, trade.tp1_price); if (t) notifyTp1Hit(t); }
      }

      // TP2 check (after TP1 hit)
      if (trade.tp1_hit) {
        const tp2Hit = isLong ? price >= trade.tp2_price : price <= trade.tp2_price;
        if (tp2Hit) { const t = closeTrade(state, trade.id, trade.tp2_price, 'tp2'); if (t) notifyTradeClose(t); continue; }
      }

      // Stop check
      const stopHit = isLong ? price <= trade.stop_price : price >= trade.stop_price;
      if (stopHit) { const t = closeTrade(state, trade.id, trade.stop_price, 'stop'); if (t) notifyTradeClose(t); }
    }
  }

  // Fetch a single price from Binance (with individual fallback already built in)
  async function fetchPrice(base) {
    try {
      const r = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${base}USDT`);
      const d = await r.json();
      return d.price ? parseFloat(d.price) : null;
    } catch { return null; }
  }

  // Queued trade monitor — runs every 5 minutes
  async function checkQueuedTrades() {
    const active = (state.queued_trades ?? []).filter(q => q.status === 'monitoring');
    if (active.length === 0) return;
    const now = new Date().toISOString();
    for (const q of active) {
      const base = baseOf(q.symbol);
      const price = priceMap[base] ?? await fetchPrice(base);
      if (price == null) continue;
      q.current_price = price;
      q.last_checked = now;

      // Invalidation check
      const invalidated = q.invalidation_price != null && (
        (q.invalidation_direction === 'below' && price < q.invalidation_price) ||
        (q.invalidation_direction === 'above' && price > q.invalidation_price)
      );
      if (invalidated) {
        invalidateQueued(state, q.id);
        console.error(`  [Queue] ${q.symbol} invalidated — price ${price} breached ${q.invalidation_direction} ${q.invalidation_price}`);
        continue;
      }

      // Entry zone check — within 0.5% of entry_zone → auto-load
      const distPct = Math.abs((price - q.entry_zone) / q.entry_zone) * 100;
      if (distPct <= 0.5) {
        const trade = activateQueued(state, q.id, q.entry_zone);
        if (trade) {
          notifyTradeOpen(trade);
          console.error(`  [Queue] ${q.symbol} AUTO-LOADED — price ${price} entered zone ${q.entry_zone}`);
        }
      }
    }
    saveState(state);
  }

  setInterval(pollTVPrice, 3000);
  setInterval(pollAllPrices, 3000);
  setInterval(checkQueuedTrades, 300_000);
  await Promise.all([pollTVPrice(), pollAllPrices()]);

  // ── Static ─────────────────────────────────────────────────────
  app.get('/', (_req, res) =>
    res.sendFile(join(__dirname, '../../dashboard/index.html'))
  );

  // ── API ────────────────────────────────────────────────────────
  app.get('/api/quote', (_req, res) => {
    if (!currentQuote) return res.status(503).json({ error: 'No quote yet' });
    res.json(currentQuote);
  });

  app.get('/api/state', (_req, res) => {
    const open = state.open_trades.map(t => ({
      ...t,
      current_price: priceMap[baseOf(t.symbol)] ?? null,
      pnl: priceMap[baseOf(t.symbol)] ? calcLivePnl(t, priceMap[baseOf(t.symbol)]) : 0,
    }));
    res.json({ ...state, open_trades: open, scorecard: calcScorecard(state) });
  });

  app.get('/api/tabs', async (_req, res) => {
    try {
      const tabs = await listTabsWithInfo();
      const modeTabs = tabs.map(tab => ({
        ...tab,
        mode: Object.entries(MODES).find(([, { resolutions }]) =>
          tab.resolution && resolutions.includes(tab.resolution)
        )?.[0] ?? null,
      }));
      res.json({ tabs: modeTabs });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/mode', async (req, res) => {
    const { mode } = req.body;
    if (!mode || !MODES[mode]) {
      return res.status(400).json({ error: `Unknown mode. Valid: ${Object.keys(MODES).join(', ')}` });
    }
    const target = await findTargetByMode(mode);
    if (!target) {
      return res.json({ success: false, mode, tab_found: false });
    }
    try {
      await activateTarget(target.id);
      await switchTarget(target.id);
      if (target.symbol && !state.pairs.includes(target.symbol)) {
        state.pairs.push(target.symbol);
      }
      state.active_mode = mode;
      saveState(state);
      await pollTVPrice();
      res.json({ success: true, mode, tab_found: true, resolution: target.resolution, symbol: target.symbol });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post('/api/trade/open', (req, res) => {
    const { symbol, direction, entry_price, stop_price, tp1_price, tp1_split,
            tp2_price, tp2_split, margin_usd, leverage,
            conviction, source, card_title } = req.body;
    if (!symbol || !direction || !entry_price || !stop_price || !tp1_price || !tp2_price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if ((tp1_split + tp2_split) !== 100) {
      return res.status(400).json({ error: 'TP splits must sum to 100' });
    }
    const price = entry_price === 'market'
      ? (priceMap[baseOf(symbol)] ?? currentQuote?.last ?? entry_price)
      : Number(entry_price);
    const trade = openTrade(state, {
      symbol, direction,
      entry_price: price,
      stop_price: Number(stop_price),
      tp1_price: Number(tp1_price),
      tp1_split: Number(tp1_split),
      tp2_price: Number(tp2_price),
      tp2_split: Number(tp2_split),
      margin_usd: Number(margin_usd),
      leverage: Number(leverage),
      conviction: conviction ?? null,
      source: source ?? null,
      card_title: card_title ?? null,
    });
    notifyTradeOpen(trade);
    res.json({ success: true, trade });
  });

  app.post('/api/trade/close', (req, res) => {
    const { id, price } = req.body;
    const exit = price ?? currentQuote?.last;
    if (!exit) return res.status(400).json({ error: 'No price available' });
    const closed = closeTrade(state, id, Number(exit), 'manual');
    if (!closed) return res.status(404).json({ error: 'Trade not found' });
    notifyTradeClose(closed);
    res.json({ success: true, trade: closed });
  });

  app.get('/api/queue', (_req, res) => {
    const q = (state.queued_trades ?? []).map(q => ({
      ...q,
      current_price: priceMap[baseOf(q.symbol)] ?? q.current_price ?? null,
    }));
    res.json({ queued_trades: q });
  });

  app.post('/api/queue/add', (req, res) => {
    const {
      symbol, direction, entry_zone, entry_condition,
      invalidation_price, invalidation_direction,
      stop_price, tp1_price, tp1_split, tp2_price, tp2_split,
      margin_usd, leverage, conviction, source, card_title,
    } = req.body;
    if (!symbol || !direction || !entry_zone || !stop_price || !tp1_price || !tp2_price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!state.queued_trades) state.queued_trades = [];
    const queued = queueTrade(state, {
      symbol, direction, entry_zone: Number(entry_zone), entry_condition,
      invalidation_price: invalidation_price ? Number(invalidation_price) : null,
      invalidation_direction,
      stop_price: Number(stop_price),
      tp1_price: Number(tp1_price), tp1_split: Number(tp1_split ?? 30),
      tp2_price: Number(tp2_price), tp2_split: Number(tp2_split ?? 70),
      margin_usd: Number(margin_usd), leverage: Number(leverage),
      conviction, source, card_title,
    });
    res.json({ success: true, queued });
  });

  app.post('/api/queue/load/:id', (req, res) => {
    const { id } = req.params;
    const { price } = req.body;
    const entryPrice = price ? Number(price) : null;
    const trade = activateQueued(state, id, entryPrice);
    if (!trade) return res.status(404).json({ error: 'Queued trade not found' });
    notifyTradeOpen(trade);
    res.json({ success: true, trade });
  });

  app.delete('/api/queue/:id', (req, res) => {
    const removed = removeQueued(state, req.params.id);
    if (!removed) return res.status(404).json({ error: 'Queued trade not found' });
    res.json({ success: true, removed });
  });

  app.patch('/api/queue/:id', (req, res) => {
    const updated = updateQueued(state, req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Queued trade not found' });
    res.json({ success: true, queued: updated });
  });

  app.post('/api/symbol', async (req, res) => {
    const { symbol } = req.body;
    if (!symbol) return res.status(400).json({ error: 'symbol required' });
    try {
      await chart.setSymbol({ symbol });
      if (!state.pairs.includes(symbol)) {
        state.pairs.push(symbol);
        saveState(state);
      }
      await pollPrice();
      res.json({ success: true, symbol });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // Prevent Discord WebSocket errors (ECONNRESET, handshake timeouts) from crashing the process.
  // These are transient network issues — the bot's own reconnect logic handles recovery.
  process.on('uncaughtException', err => {
    const isDiscordNetworkError = (
      err.code === 'ECONNRESET' ||
      err.message?.includes('handshake') ||
      err.message?.includes('WebSocket') ||
      err.message?.includes('ECONNREFUSED') ||
      err.message?.includes('ETIMEDOUT')
    );
    if (isDiscordNetworkError) {
      console.error('[Discord] Network error (will reconnect):', err.message);
    } else {
      throw err;
    }
  });

  // ── Discord bot ────────────────────────────────────────────────
  startBot(() => state).catch(e => console.error('[Discord] Bot error:', e.message));

  // ── Start ──────────────────────────────────────────────────────
  app.listen(port, () => {
    const url = `http://localhost:${port}`;
    console.error(`\n  Paper Trading Dashboard\n  ${url}\n`);
    exec(`open "${url}" 2>/dev/null || xdg-open "${url}" 2>/dev/null || start "${url}"`, () => {});
  });

  // Keep process alive
  await new Promise(() => {});
}

register('dashboard', {
  description: 'Launch paper trading dashboard',
  options: {
    port: { type: 'string', short: 'p', description: 'Port (default: 3333)' },
    reset: { type: 'boolean', description: 'Reset paper trading state' },
  },
  handler: (opts) => startDashboard({
    port: opts.port ? Number(opts.port) : 3333,
    reset: opts.reset ?? false,
  }),
});
