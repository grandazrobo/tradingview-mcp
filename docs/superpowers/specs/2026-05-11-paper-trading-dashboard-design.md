# Paper Trading Dashboard — Design Spec
_2026-05-11_

## Overview

A live paper trading dashboard served by a new `tv dashboard` CLI command. Connects to TradingView Desktop via the existing CDP/MCP connection to poll real-time prices. Trades are simulated locally with a $10,000 starting balance. State persists to a JSON file between sessions.

---

## Architecture

```
Browser (dashboard.html)
    ↕ HTTP polling (every 3s) + REST API
Local Express server (src/cli/commands/dashboard.js)
    ↕ existing connection.js
TradingView Desktop via CDP (port 9222)
```

- **Entry point:** `node src/cli/index.js dashboard` (or `tv dashboard`)
- **Server:** Express on `localhost:3333` (configurable), serves `dashboard.html` and a JSON API
- **State:** persisted to `~/.tv-paper-trades.json` (balance, open trades, history)
- **Price feed:** server polls `quote_get` every 3 seconds, exposes via `/api/quote`

---

## CLI Command

```bash
tv dashboard
# Starts server on port 3333, opens browser automatically
# Prints: Dashboard running at http://localhost:3333
```

Options: `--port <n>`, `--reset` (wipe state, start fresh at $10k)

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/quote` | Current price, symbol, change% from TradingView |
| GET | `/api/state` | Full state: balance, open trades, history, scorecard |
| POST | `/api/trade/open` | Open a new paper trade |
| POST | `/api/trade/close` | Close a trade (by id, at current price or specified price) |
| POST | `/api/symbol` | Switch chart symbol (calls `chart_set_symbol`) |

---

## Trade Model

```json
{
  "id": "uuid",
  "symbol": "KUCOIN:SOLUSDT",
  "direction": "long",
  "entry_price": 96.09,
  "stop_price": 95.25,
  "tp1_price": 97.20,
  "tp1_split": 30,
  "tp2_price": 98.50,
  "tp2_split": 70,
  "margin_usd": 1000,
  "leverage": 10,
  "position_size": 10000,
  "opened_at": "2026-05-11T01:30:00Z",
  "status": "open",
  "pnl": 0,
  "exit_price": null,
  "exit_reason": null,
  "closed_at": null
}
```

---

## Dashboard UI (approved layout v4)

### Header
- Pair selector dropdown (switches TradingView chart + price feed)
- Live price + change % (polled every 3s)
- Paper balance + total P&L

### Order Entry Panel (left, 320px)
- Long / Short tabs
- Quick entry button (market price, current margin + leverage)
- Entry price + stop loss (price field + % field, bidirectional)
- TP section: TP1 and TP2 each have price, %, split % input, visual bar, payout preview
- Split validation: warns if TP1% + TP2% ≠ 100
- Margin block: USD amount, % of balance, leverage selector (5×/10×/20×/40×), shows position size / max loss / liquidation price
- R:R preview: Risk $, TP1 R:R, TP2 R:R, Blended R:R
- Submit button

### Right Column
- **Scorecard:** Balance, Win Rate, Avg R:R, Win Streak
- **Active Trades:** live P&L updating every 3s, Close button
- **Trade History:** symbol, direction, entry, exit (with TP1/TP2/Stop tag), leverage, margin, P&L, R:R, result

---

## State File Schema

```json
{
  "starting_balance": 10000,
  "balance": 10427.50,
  "open_trades": [],
  "history": [],
  "pairs": ["KUCOIN:SOLUSDT", "KUCOIN:BTCUSDT", "BINANCE:ETHUSDT"]
}
```

Stored at `~/.tv-paper-trades.json`. `--reset` flag rewrites it with defaults.

---

## Scorecard Calculations

- **Win Rate:** `wins / total_closed * 100`
- **Avg R:R:** average of `|pnl_won / risk_per_trade|` across winning trades
- **Streak:** consecutive wins (positive) or losses (negative) from most recent trade
- **Balance:** starting balance + sum of all closed trade P&L

---

## P&L Calculation

```
pnl = (exit_price - entry_price) / entry_price * position_size   [long]
pnl = (entry_price - exit_price) / entry_price * position_size   [short]
```

For partial closes (TP1 hit, 30%): `pnl_partial = pnl * 0.30`

---

## Auto-close Logic

The server checks open trades on every price poll. A trade auto-closes when:
- Live price crosses stop → close at stop, mark as STOP
- Live price crosses TP1 → close 30% (or configured split) of position, mark TP1 partial
- Live price crosses TP2 → close remaining 70%, mark as WIN

---

## Files to Create

```
src/cli/commands/dashboard.js     — CLI command, Express server, price polling, trade logic
src/dashboard/index.html          — Single-file dashboard (HTML/CSS/JS)
src/dashboard/state.js            — State read/write helpers
```

Add `dashboard` to `src/cli/index.js` command registry.
