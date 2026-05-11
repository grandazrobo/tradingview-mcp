import { register } from '../router.js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { exec } from 'child_process';
import * as data from '../../core/data.js';
import * as chart from '../../core/chart.js';
import {
  loadState, resetState, openTrade, closeTrade, hitTp1,
  calcLivePnl, calcScorecard, saveState,
} from '../../dashboard/state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function startDashboard({ port = 3333, reset = false } = {}) {
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());

  let state = reset ? resetState() : loadState();
  let currentQuote = null;
  const priceMap = {};  // symbol → last price

  // ── Price polling ──────────────────────────────────────────────
  async function pollPrice() {
    try {
      const q = await data.getQuote({});
      if (q?.last && q?.symbol) {
        currentQuote = q;
        priceMap[q.symbol] = q.last;
        checkAutoClose(q.symbol, q.last);
      }
    } catch { /* TV may be loading */ }
  }

  function checkAutoClose(symbol, price) {
    for (const trade of [...state.open_trades]) {
      if (trade.symbol !== symbol) continue;
      const isLong = trade.direction === 'long';

      // TP1 check
      if (!trade.tp1_hit) {
        const tp1Hit = isLong ? price >= trade.tp1_price : price <= trade.tp1_price;
        if (tp1Hit) hitTp1(state, trade.id, trade.tp1_price);
      }

      // TP2 check (after TP1 hit)
      if (trade.tp1_hit) {
        const tp2Hit = isLong ? price >= trade.tp2_price : price <= trade.tp2_price;
        if (tp2Hit) { closeTrade(state, trade.id, trade.tp2_price, 'tp2'); continue; }
      }

      // Stop check
      const stopHit = isLong ? price <= trade.stop_price : price >= trade.stop_price;
      if (stopHit) closeTrade(state, trade.id, trade.stop_price, 'stop');
    }
  }

  setInterval(pollPrice, 3000);
  await pollPrice();

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
      pnl: priceMap[t.symbol] ? calcLivePnl(t, priceMap[t.symbol]) : 0,
    }));
    res.json({ ...state, open_trades: open, scorecard: calcScorecard(state) });
  });

  app.post('/api/trade/open', (req, res) => {
    const { symbol, direction, entry_price, stop_price, tp1_price, tp1_split,
            tp2_price, tp2_split, margin_usd, leverage } = req.body;
    if (!symbol || !direction || !entry_price || !stop_price || !tp1_price || !tp2_price) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if ((tp1_split + tp2_split) !== 100) {
      return res.status(400).json({ error: 'TP splits must sum to 100' });
    }
    const price = entry_price === 'market'
      ? (priceMap[symbol] ?? currentQuote?.last ?? entry_price)
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
    });
    res.json({ success: true, trade });
  });

  app.post('/api/trade/close', (req, res) => {
    const { id, price } = req.body;
    const exit = price ?? currentQuote?.last;
    if (!exit) return res.status(400).json({ error: 'No price available' });
    const closed = closeTrade(state, id, Number(exit), 'manual');
    if (!closed) return res.status(404).json({ error: 'Trade not found' });
    res.json({ success: true, trade: closed });
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
