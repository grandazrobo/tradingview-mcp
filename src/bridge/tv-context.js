import * as data from '../core/data.js';
import * as chart from '../core/chart.js';
import * as pane from '../core/pane.js';
import { assessIADSS } from './iadss-rules.js';
import { assessChartPrime } from './chartprime-rules.js';

// Fetch current price — Binance spot first, futures fallback (e.g. HYPE is futures-only)
export async function fetchBinancePrice(symbol) {
  const ticker = symbol.includes(':') ? symbol.split(':')[1] : symbol;
  const base = ticker.replace(/(USDT|USDC|USD)$/i, '');
  const pair = `${base}USDT`;
  try {
    const spot = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${pair}`);
    const sj = await spot.json();
    if (sj.price) return parseFloat(sj.price);
    const fut = await fetch(`https://fapi.binance.com/fapi/v1/ticker/price?symbol=${pair}`);
    const fj = await fut.json();
    return fj.price ? parseFloat(fj.price) : null;
  } catch {
    return null;
  }
}

// Read the currently active TV chart — quote, indicator values, key pine levels
export async function fetchTVChartContext() {
  try {
    const [stateResult, quoteResult, studyResult, linesResult, labelsResult] = await Promise.allSettled([
      chart.getState(),
      data.getQuote({}),
      data.getStudyValues(),
      data.getPineLines({}),
      data.getPineLabels({}),
    ]);

    const state   = stateResult.status   === 'fulfilled' ? stateResult.value   : null;
    const quote   = quoteResult.status   === 'fulfilled' ? quoteResult.value   : null;
    const studies = studyResult.status   === 'fulfilled' ? studyResult.value   : null;
    const lines   = linesResult.status   === 'fulfilled' ? linesResult.value   : null;
    const labels  = labelsResult.status  === 'fulfilled' ? labelsResult.value  : null;

    return {
      symbol:     state?.symbol ?? quote?.symbol ?? null,
      timeframe:  state?.timeframe ?? null,
      price:      quote?.last ?? null,
      studies:    studies?.studies ?? [],
      levels:     lines?.lines ?? [],
      labels:     labels?.labels ?? [],
    };
  } catch {
    return null;
  }
}

// Fetch multi-timeframe indicator context for a symbol across all open panes
// Switches each pane to the symbol, reads indicators, returns per-timeframe data
export async function fetchMTFContext(symbol) {
  try {
    const paneList = await pane.list();
    if (!paneList?.panes?.length) return null;

    const mtf = [];

    for (const p of paneList.panes) {
      const tf = p.resolution ?? '?';
      try {
        await pane.setSymbol({ index: p.index, symbol });
        await new Promise(r => setTimeout(r, 3000)); // wait for indicators to reload

        const [studyResult, linesResult, labelsResult] = await Promise.allSettled([
          data.getStudyValues(),
          data.getPineLines({}),
          data.getPineLabels({}),
        ]);

        mtf.push({
          timeframe: tf,
          pane_index: p.index,
          studies: studyResult.status === 'fulfilled' ? studyResult.value?.studies ?? [] : [],
          levels:  linesResult.status  === 'fulfilled' ? linesResult.value?.lines   ?? [] : [],
          labels:  labelsResult.status === 'fulfilled' ? labelsResult.value?.labels  ?? [] : [],
        });
      } catch (e) {
        mtf.push({ timeframe: tf, pane_index: p.index, error: e.message });
      }
    }

    return { symbol, panes: mtf };
  } catch {
    return null;
  }
}

// Assess whether a parsed card's setup is still valid given current price
export function assessSetup(card, currentPrice) {
  if (currentPrice === null || currentPrice === undefined) {
    return { status: 'UNKNOWN', note: 'Could not fetch current price' };
  }

  const { direction, entry_price, stop_price, tp1_price, tp2_price } = card;
  const isLong = direction === 'long';
  const price = currentPrice;

  // Stop already hit?
  if (isLong ? price <= stop_price : price >= stop_price) {
    return {
      status: 'STOP HIT',
      current_price: price,
      note: `Price ${price.toLocaleString()} already through stop ${stop_price.toLocaleString()} — setup cancelled`,
    };
  }

  // TP2 already hit?
  if (isLong ? price >= tp2_price : price <= tp2_price) {
    return {
      status: 'TARGET REACHED',
      current_price: price,
      note: `Price ${price.toLocaleString()} already past TP2 ${tp2_price.toLocaleString()} — setup expired`,
    };
  }

  // TP1 already hit?
  if (isLong ? price >= tp1_price : price <= tp1_price) {
    return {
      status: 'TP1 HIT',
      current_price: price,
      note: `Price ${price.toLocaleString()} already past TP1 ${tp1_price.toLocaleString()} — would be managing remainder to TP2`,
    };
  }

  // How far is price from the entry zone?
  const distancePct = ((price - entry_price) / entry_price) * 100;
  const absPct = Math.abs(distancePct);

  // Is price on the wrong side of entry (moved away in the wrong direction)?
  // Long pullback: we buy when price drops to entry. Wrong side = price fell BELOW entry (missed the bounce).
  // Short retest: we sell when price rises to entry. Wrong side = price pumped ABOVE entry (missed the top).
  const wrongSide = isLong ? distancePct < -2 : distancePct > 2;

  if (absPct <= 0.5) {
    return {
      status: 'AT ENTRY',
      current_price: price,
      distance_pct: absPct,
      note: `Price ${price.toLocaleString()} is within the entry zone — execute now`,
      action: `Place ${direction.toUpperCase()} at market or limit ${entry_price.toLocaleString()}`,
    };
  }

  if (absPct <= 2.5 && !wrongSide) {
    return {
      status: 'APPROACHING',
      current_price: price,
      distance_pct: absPct,
      note: `Price ${price.toLocaleString()} is ${absPct.toFixed(1)}% from entry zone`,
      action: `Set limit ${direction.toUpperCase()} at ${entry_price.toLocaleString()} — watch for confirmation`,
    };
  }

  if (wrongSide) {
    return {
      status: 'MISSED',
      current_price: price,
      distance_pct: absPct,
      note: `Price ${price.toLocaleString()} has moved ${absPct.toFixed(1)}% past entry — setup no longer at entry zone`,
    };
  }

  // Price hasn't reached the entry zone yet (on the right side)
  return {
    status: 'PENDING',
    current_price: price,
    distance_pct: absPct,
    note: `Price ${price.toLocaleString()} is ${absPct.toFixed(1)}% away from entry zone ${entry_price.toLocaleString()}`,
    action: `Set price alert at ${entry_price.toLocaleString()} — not at entry yet`,
  };
}

// Build a plain-English execution plan for a card given its setup assessment
export function buildExecutionPlan(card, assessment, mtfContext, iadss, cp) {
  const lines = [];
  const { direction, entry_price, stop_price, tp1_price, tp1_split, tp2_price, tp2_split, leverage, margin_usd, symbol } = card;
  const ticker = symbol.split(':').pop();
  const posSize = margin_usd * leverage;
  const riskAmt = Math.abs((entry_price - stop_price) / entry_price * posSize).toFixed(0);
  const rrRatio = Math.abs((tp1_price - entry_price) / (entry_price - stop_price)).toFixed(2);

  const statusEmoji = {
    'AT ENTRY':      '🟢',
    'APPROACHING':   '🟡',
    'PENDING':       '⏳',
    'MISSED':        '⚠️',
    'STOP HIT':      '🔴',
    'TP1 HIT':       '✅',
    'TARGET REACHED':'✅',
    'UNKNOWN':       '❓',
  }[assessment.status] ?? '❓';

  lines.push(`**Status:** ${statusEmoji} ${assessment.status}`);
  lines.push(`**Current price:** ${assessment.current_price?.toLocaleString() ?? '—'}`);
  lines.push(`**Assessment:** ${assessment.note}`);
  lines.push('');

  if (['STOP HIT', 'TARGET REACHED', 'MISSED'].includes(assessment.status)) {
    lines.push(`> Setup is no longer actionable at current price. Do not enter.`);
  } else if (assessment.status === 'TP1 HIT') {
    lines.push(`> TP1 already reached. If in trade, manage remainder to TP2 at ${tp2_price.toLocaleString()}.`);
  } else {
    lines.push(`**Action:** ${assessment.action ?? '—'}`);
    lines.push('');
    lines.push(`| Parameter | Value |`);
    lines.push(`|---|---|`);
    lines.push(`| Direction | ${direction.toUpperCase()} ${ticker} |`);
    lines.push(`| Entry | ${entry_price.toLocaleString()} |`);
    lines.push(`| Stop | ${stop_price.toLocaleString()} |`);
    lines.push(`| TP1 (${tp1_split}%) | ${tp1_price.toLocaleString()} |`);
    lines.push(`| TP2 (${tp2_split}%) | ${tp2_price.toLocaleString()} |`);
    lines.push(`| Leverage | ${leverage}× isolated |`);
    lines.push(`| Margin | $${margin_usd.toLocaleString()} |`);
    lines.push(`| Position size | $${posSize.toLocaleString()} |`);
    lines.push(`| Max risk | $${riskAmt} |`);
    lines.push(`| R:R to TP1 | ${rrRatio}R |`);
  }

  // IADSS assessment
  if (iadss?.available) {
    lines.push('');
    lines.push(`**IADSS Score:** ${iadss.emoji} ${iadss.rating} (${iadss.score > 0 ? '+' : ''}${iadss.score})`);
    if (iadss.signals.length > 0) {
      for (const s of iadss.signals)  lines.push(`- ${s}`);
    }
    if (iadss.warnings.length > 0) {
      for (const w of iadss.warnings) lines.push(`- ${w}`);
    }
    if (iadss.picoAgainst) {
      lines.push('');
      lines.push(`> ⚠️ **IADSS CAUTION**: Mean Reversion at extreme — price is overbought/oversold against trade direction. Wait for MR to reset.`);
    }
  }

  // ChartPrime assessment
  if (cp?.available) {
    lines.push('');
    lines.push(`**ChartPrime Score:** ${cp.emoji} ${cp.rating} (${cp.score > 0 ? '+' : ''}${cp.score})`);
    if (cp.signals.length > 0) {
      for (const s of cp.signals)  lines.push(`- ${s}`);
    }
    if (cp.warnings.length > 0) {
      for (const w of cp.warnings) lines.push(`- ${w}`);
    }
    if (cp.extremeAgainst) {
      lines.push('');
      lines.push(`> ⚠️ **CP CAUTION**: Prime Oscillator at extreme against trade direction. Sellers/buyers not yet exhausted.`);
    }
  }

  // Add multi-timeframe indicator context
  if (mtfContext?.panes?.length > 0) {
    lines.push('');
    lines.push(`**Multi-Timeframe Context (${ticker}):**`);
    lines.push('');

    for (const p of mtfContext.panes) {
      if (p.error) {
        lines.push(`- **${p.timeframe}** — read error: ${p.error}`);
        continue;
      }

      const tfLabel = {
        '15': '15m', '60': '1h', '240': '4h', 'D': '1D', '1D': '1D',
        '1': '1m', '5': '5m', '30': '30m', 'W': '1W',
      }[p.timeframe] ?? p.timeframe;

      lines.push(`**${tfLabel}**`);

      // Key indicator values
      if (p.studies?.length > 0) {
        for (const s of p.studies) {
          const vals = Object.entries(s.values ?? {})
            .filter(([k, v]) => v !== null && v !== 0 && !k.startsWith('Nivel'))
            .map(([k, v]) => typeof v === 'number' ? `${k}: ${v.toFixed(2)}` : `${k}: ${v}`)
            .join(', ');
          if (vals) lines.push(`- ${s.name}: ${vals}`);
        }
      }

      // Key price levels within 5% of current price
      if (p.levels?.length > 0 && assessment.current_price) {
        const nearby = p.levels
          .filter(l => Math.abs((l.price - assessment.current_price) / assessment.current_price) < 0.05)
          .slice(0, 4);
        if (nearby.length > 0) {
          lines.push(`- Levels: ${nearby.map(l => `${l.price.toLocaleString()}${l.label ? ' (' + l.label + ')' : ''}`).join(' | ')}`);
        }
      }

      // Pine labels (named levels like PDH, PDL, etc.)
      if (p.labels?.length > 0 && assessment.current_price) {
        const nearbyLabels = p.labels
          .filter(l => l.price && Math.abs((l.price - assessment.current_price) / assessment.current_price) < 0.05)
          .slice(0, 4);
        if (nearbyLabels.length > 0) {
          lines.push(`- Labels: ${nearbyLabels.map(l => `${l.text ?? ''} ${l.price?.toLocaleString() ?? ''}`).join(' | ')}`);
        }
      }

      lines.push('');
    }
  }

  return lines.join('\n');
}
