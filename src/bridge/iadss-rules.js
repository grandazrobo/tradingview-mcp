// IADSS (InvestAnswers Decision Support System) rule engine
// Based on the 4-indicator system: Confluence, Mean Reversion, Optimized Trend, Trend
// Primary timeframe: 4H. Macro context: 1D. Confirmation: 1H. Entry trigger: 15m.
// Reference: 06_Archive/investanswers/01 - IADSS Deep Dive (Solana example).md

const TF_GROUPS = {
  '4h':  ['240', '4h', '4H'],
  '1h':  ['60', '1h', '1H'],
  '15m': ['15', '15m'],
  '1d':  ['D', '1D', '1440', '1d'],
};

function findPane(panes, group) {
  return panes?.find(p => TF_GROUPS[group]?.includes(p.timeframe));
}

function findStudy(studies, substr) {
  return studies?.find(s => s.name.toLowerCase().includes(substr.toLowerCase()));
}

// Fast > Slow = bullish (blue), Fast < Slow = bearish (orange)
function trendDir(study) {
  const fast = study?.values?.['Fast Plot'];
  const slow = study?.values?.['Slow Plot'];
  if (fast == null || slow == null) return null;
  if (fast > slow) return 'bullish';
  if (fast < slow) return 'bearish';
  return 'neutral';
}

// Mean Reversion: plot is standard deviations from mean
// < -1.75 = Pico Buy, < 0 = below mean, 0-1.75 = above mean, > 1.75 = Pico Sell
function mrLevel(plot) {
  const n = Number(plot);
  if (plot == null || isNaN(n)) return null;
  if (n <= -1.75) return 'PICO_BUY';
  if (n < 0)      return 'BELOW_MEAN';
  if (n <= 1.75)  return 'ABOVE_MEAN';
  return 'PICO_SELL';
}

function fmtNum(val) {
  const n = Number(val);
  return isNaN(n) ? String(val) : n.toFixed(2);
}

// Whether the confluence level supports the trade direction
// Confluence Plot appears to be a support/resistance price level
function confluenceDir(study, currentPrice) {
  const level = study?.values?.Plot;
  if (level == null || currentPrice == null) return null;
  return currentPrice > level ? 'bullish' : 'bearish';
}

export function assessIADSS(card, mtfContext, currentPrice) {
  if (!mtfContext?.panes?.length) {
    return { available: false, note: 'TradingView not available — IADSS skipped' };
  }

  const { direction } = card;
  const isLong = direction === 'long';

  const pane4h  = findPane(mtfContext.panes, '4h');
  const pane1h  = findPane(mtfContext.panes, '1h');
  const pane15m = findPane(mtfContext.panes, '15m');
  const pane1d  = findPane(mtfContext.panes, '1d');

  const signals  = [];
  const warnings = [];
  let score = 0;

  // ── 4H PRIMARY (Optimized Trend ×2, Trend Model ×1, Mean Reversion ×3) ──

  if (pane4h) {
    const ot4h = findStudy(pane4h.studies, 'IA-Optimized-Trend');
    const tm4h = findStudy(pane4h.studies, 'IA-Trend-Model');
    const mr4h = findStudy(pane4h.studies, 'IA-Mean-Reversion');
    const cf4h = findStudy(pane4h.studies, 'IA-Confluence-Model');

    // Optimized Trend (weight ×2 — primary signal on 4H)
    const otDir = trendDir(ot4h);
    if (otDir) {
      const aligned = isLong ? otDir === 'bullish' : otDir === 'bearish';
      if (aligned) { score += 2; signals.push(`4H OT: ✅ ${otDir}`); }
      else          { score -= 2; warnings.push(`4H OT: ❌ ${otDir} (against ${direction})`); }
    }

    // Trend Model (weight ×1)
    const tmDir = trendDir(tm4h);
    if (tmDir) {
      const aligned = isLong ? tmDir === 'bullish' : tmDir === 'bearish';
      if (aligned) { score += 1; signals.push(`4H Trend: ✅ ${tmDir}`); }
      else          { score -= 1; warnings.push(`4H Trend: ⚠️ ${tmDir}`); }
    }

    // Mean Reversion (weight ×3 — Pico moments are highest conviction)
    const mrPlot = mr4h?.values?.Plot;
    const mrSig  = mrLevel(mrPlot);
    if (mrSig) {
      const label = mrPlot != null ? `(${fmtNum(mrPlot)})` : '';
      if (isLong) {
        if      (mrSig === 'PICO_BUY')   { score += 3; signals.push(`4H MR: 🔥 PICO BUY — extreme oversold ${label}`); }
        else if (mrSig === 'BELOW_MEAN') { score += 1; signals.push(`4H MR: ✅ below mean ${label}`); }
        else if (mrSig === 'ABOVE_MEAN') {             signals.push(`4H MR: ⚠️ above mean ${label} — stretched`); }
        else if (mrSig === 'PICO_SELL')  { score -= 3; warnings.push(`4H MR: ❌ PICO SELL — extreme overbought ${label} — avoid long`); }
      } else {
        if      (mrSig === 'PICO_SELL')  { score += 3; signals.push(`4H MR: 🔥 PICO SELL — extreme overbought ${label}`); }
        else if (mrSig === 'ABOVE_MEAN') { score += 1; signals.push(`4H MR: ✅ above mean ${label}`); }
        else if (mrSig === 'BELOW_MEAN') {             signals.push(`4H MR: ⚠️ below mean ${label} — stretched`); }
        else if (mrSig === 'PICO_BUY')   { score -= 3; warnings.push(`4H MR: ❌ PICO BUY — extreme oversold ${label} — avoid short`); }
      }
    }

    // Confluence level vs current price
    const cfDir = confluenceDir(cf4h, currentPrice);
    if (cfDir) {
      const aligned = isLong ? cfDir === 'bullish' : cfDir === 'bearish';
      if (aligned) { score += 1; signals.push(`4H Confluence: ✅ price above support`); }
      else          {             warnings.push(`4H Confluence: ⚠️ price below confluence level`); }
    }
  }

  // ── 1D MACRO (Optimized Trend ×2, Mean Reversion ×2) ──

  if (pane1d) {
    const ot1d = findStudy(pane1d.studies, 'IA-Optimized-Trend');
    const mr1d = findStudy(pane1d.studies, 'IA-Mean-Reversion');

    const otDir = trendDir(ot1d);
    if (otDir) {
      const aligned = isLong ? otDir === 'bullish' : otDir === 'bearish';
      if (aligned) { score += 2; signals.push(`1D OT: ✅ macro ${otDir}`); }
      else          { score -= 1; warnings.push(`1D OT: ⚠️ macro ${otDir} — against ${direction}`); }
    }

    const mrPlot = mr1d?.values?.Plot;
    const mrSig  = mrLevel(mrPlot);
    if (mrSig) {
      const label = mrPlot != null ? `(${fmtNum(mrPlot)})` : '';
      if (isLong) {
        if      (mrSig === 'PICO_BUY')  { score += 2; signals.push(`1D MR: 🔥 PICO BUY on daily ${label}`); }
        else if (mrSig === 'PICO_SELL') { score -= 2; warnings.push(`1D MR: ❌ daily overbought ${label}`); }
      } else {
        if      (mrSig === 'PICO_SELL') { score += 2; signals.push(`1D MR: 🔥 PICO SELL on daily ${label}`); }
        else if (mrSig === 'PICO_BUY')  { score -= 2; warnings.push(`1D MR: ❌ daily oversold ${label}`); }
      }
    }
  }

  // ── 1H CONFIRMATION (Optimized Trend ×1) ──

  if (pane1h) {
    const ot1h = findStudy(pane1h.studies, 'IA-Optimized-Trend');
    const otDir = trendDir(ot1h);
    if (otDir) {
      const aligned = isLong ? otDir === 'bullish' : otDir === 'bearish';
      if (aligned) { score += 1; signals.push(`1H OT: ✅ ${otDir}`); }
      else          {             warnings.push(`1H OT: ⚠️ ${otDir}`); }
    }
  }

  // ── 15m ENTRY TRIGGER (Optimized Trend ×1) ──

  if (pane15m) {
    const ot15m = findStudy(pane15m.studies, 'IA-Optimized-Trend');
    const otDir = trendDir(ot15m);
    if (otDir) {
      const aligned = isLong ? otDir === 'bullish' : otDir === 'bearish';
      if (aligned) { score += 1; signals.push(`15m OT: ✅ ${otDir}`); }
      else          {             warnings.push(`15m OT: ⚠️ ${otDir} — entry TF against`); }
    }
  }

  // ── RATING ──
  // Max possible: 2+1+3+1 (4H) + 2+2 (1D) + 1 (1H) + 1 (15m) = 13
  let rating, emoji;
  const picoAgainst = warnings.some(w => w.includes('PICO SELL') && isLong) ||
                      warnings.some(w => w.includes('PICO BUY') && !isLong);

  if (picoAgainst)   { rating = 'IADSS: AVOID';     emoji = '🚫'; }
  else if (score >= 7) { rating = 'IADSS: CONFIRMED'; emoji = '🟢'; }
  else if (score >= 4) { rating = 'IADSS: PARTIAL';   emoji = '🟡'; }
  else if (score >= 1) { rating = 'IADSS: NEUTRAL';   emoji = '⚪'; }
  else                 { rating = 'IADSS: AGAINST';   emoji = '🔴'; }

  return {
    available: true,
    score,
    rating,
    emoji,
    signals,
    warnings,
    picoAgainst,
  };
}
