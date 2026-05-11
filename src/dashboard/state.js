import { readFileSync, writeFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';

const STATE_FILE = join(homedir(), '.tv-paper-trades.json');

const DEFAULT_STATE = {
  starting_balance: 10000,
  balance: 10000,
  open_trades: [],
  history: [],
  pairs: ['KUCOIN:SOLUSDT', 'KUCOIN:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:AVAXUSDT'],
};

export function loadState() {
  if (!existsSync(STATE_FILE)) return structuredClone(DEFAULT_STATE);
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}

export function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function resetState() {
  const state = structuredClone(DEFAULT_STATE);
  saveState(state);
  return state;
}

export function openTrade(state, params) {
  const {
    symbol, direction, entry_price, stop_price,
    tp1_price, tp1_split, tp2_price, tp2_split,
    margin_usd, leverage,
  } = params;
  const position_size = margin_usd * leverage;
  const trade = {
    id: randomUUID(),
    symbol,
    direction,
    entry_price,
    stop_price,
    tp1_price,
    tp1_split,
    tp2_price,
    tp2_split,
    margin_usd,
    leverage,
    position_size,
    opened_at: new Date().toISOString(),
    status: 'open',
    tp1_hit: false,
    tp1_pnl: 0,
    pnl: 0,
    exit_price: null,
    exit_reason: null,
    closed_at: null,
  };
  state.open_trades.push(trade);
  saveState(state);
  return trade;
}

export function hitTp1(state, id, tp1_price) {
  const trade = state.open_trades.find(t => t.id === id);
  if (!trade || trade.tp1_hit) return null;
  const sign = trade.direction === 'long' ? 1 : -1;
  const partial_size = trade.position_size * (trade.tp1_split / 100);
  const tp1_pnl = parseFloat((sign * ((tp1_price - trade.entry_price) / trade.entry_price) * partial_size).toFixed(2));
  trade.tp1_hit = true;
  trade.tp1_pnl = tp1_pnl;
  trade.status = 'tp1_hit';
  state.balance = parseFloat((state.balance + tp1_pnl).toFixed(2));
  saveState(state);
  return trade;
}

export function closeTrade(state, id, exit_price, exit_reason) {
  const idx = state.open_trades.findIndex(t => t.id === id);
  if (idx === -1) return null;
  const trade = state.open_trades[idx];
  const sign = trade.direction === 'long' ? 1 : -1;
  const remaining_size = trade.tp1_hit
    ? trade.position_size * (trade.tp2_split / 100)
    : trade.position_size;
  const close_pnl = parseFloat((sign * ((exit_price - trade.entry_price) / trade.entry_price) * remaining_size).toFixed(2));
  const total_pnl = parseFloat((trade.tp1_pnl + close_pnl).toFixed(2));
  const closed = {
    ...trade,
    status: 'closed',
    exit_price,
    exit_reason,
    pnl: total_pnl,
    closed_at: new Date().toISOString(),
  };
  state.open_trades.splice(idx, 1);
  state.history.unshift(closed);
  if (!trade.tp1_hit) {
    state.balance = parseFloat((state.balance + total_pnl).toFixed(2));
  } else {
    state.balance = parseFloat((state.balance + close_pnl).toFixed(2));
  }
  saveState(state);
  return closed;
}

export function calcLivePnl(trade, current_price) {
  const sign = trade.direction === 'long' ? 1 : -1;
  if (trade.tp1_hit) {
    const remaining = trade.position_size * (trade.tp2_split / 100);
    const unrealized = sign * ((current_price - trade.entry_price) / trade.entry_price) * remaining;
    return parseFloat((trade.tp1_pnl + unrealized).toFixed(2));
  }
  return parseFloat((sign * ((current_price - trade.entry_price) / trade.entry_price) * trade.position_size).toFixed(2));
}

export function calcScorecard(state) {
  const closed = state.history;
  const wins = closed.filter(t => t.pnl > 0);
  const win_rate = closed.length > 0 ? Math.round(wins.length / closed.length * 100) : 0;
  const avg_rr = wins.length > 0
    ? parseFloat((wins.reduce((sum, t) => {
        const risk = Math.abs((t.stop_price - t.entry_price) / t.entry_price * t.position_size);
        return sum + (risk > 0 ? t.pnl / risk : 0);
      }, 0) / wins.length).toFixed(2))
    : 0;
  let streak = 0;
  for (const t of closed) {
    if (streak === 0) { streak = t.pnl > 0 ? 1 : -1; continue; }
    if (t.pnl > 0 && streak > 0) streak++;
    else if (t.pnl <= 0 && streak < 0) streak--;
    else break;
  }
  return {
    balance: state.balance,
    starting_balance: state.starting_balance,
    pnl_total: parseFloat((state.balance - state.starting_balance).toFixed(2)),
    pnl_pct: parseFloat(((state.balance - state.starting_balance) / state.starting_balance * 100).toFixed(2)),
    win_rate,
    wins: wins.length,
    total: closed.length,
    avg_rr,
    streak,
  };
}
