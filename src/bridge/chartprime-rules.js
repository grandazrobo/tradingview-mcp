// ChartPrime rule engine
// Covers two indicators we run on TradingView:
//   1. Prime Oscillators Pro — momentum ribbon (0-100 base, extends to OB/OS zones)
//   2. Market Dynamics Pro   — market structure (BOS/CHoCH), order blocks, pattern signals
//
// Reference: 06_Archive/ChartPrime/ChartPrime Indicators.md
// Docs: https://docs.chartprime.com

// ── PRIME OSCILLATOR ────────────────────────────────────────────────────────
//
// Scale: normally 0–100, extends beyond into OB/OS extremes
//   > 110  — Nivel 3+ overbought (strong OB zone, buyers exhausted)
//   > 100  — Entering OB zone
//   > 50   — Bullish momentum
//   ≈ 50   — Neutral midline
//   < 50   — Bearish momentum
//   < 0    — Entering OS zone (sellers exhausted)
//   < -110 — Nivel 3+ oversold (strong OS zone)
//
// OS = sellers exhausted → avoid shorting, good for long entries
// OB = buyers exhausted  → avoid buying, take profits on longs

function primeOscZone(plot) {
  const n = Number(plot);
  if (plot == null || isNaN(n)) return null;
  if (n >= 110)  return 'EXTREME_OB';
  if (n > 100)   return 'OB';
  if (n > 50)    return 'BULLISH';
  if (n >= 45)   return 'NEUTRAL';
  if (n >= 0)    return 'BEARISH';
  if (n > -110)  return 'OS';
  return 'EXTREME_OS';
}

// ── MARKET DYNAMICS PRO ──────────────────────────────────────────────────────
//
// PlotCandle — MSC candle coloring reference price
//   If price > PlotCandle: candle coloring is bullish structure (price above reference)
//   If price < PlotCandle: candle coloring is bearish structure
//
// Shapes — active signal flag from MDP (BOS, CHoCH, pattern detection)
//   0      = no signal currently firing
//   non-zero = signal active (positive = bullish BOS/breakout, negative = CHoCH/reversal)

// ── HELPERS ──────────────────────────────────────────────────────────────────

// Extract the current Prime Oscillator value from pine lines data.
// The indicator draws non-horizontal lines between bars — the y2 of the line
// with the highest x2 is the current bar's value.
function getPOValueFromLines(poLines) {
  const study = poLines?.find(s => s.name?.toLowerCase().includes('prime oscillators'));
  if (!study?.all_lines?.length) return null;
  const mostRecent = study.all_lines.reduce((best, line) =>
    (line.x2 ?? -Infinity) > (best?.x2 ?? -Infinity) ? line : best, null);
  const val = mostRecent?.y2;
  return (val != null && !isNaN(Number(val))) ? Number(val) : null;
}

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

function fmtNum(val, dp = 2) {
  const n = Number(val);
  return isNaN(n) ? String(val) : n.toFixed(dp);
}

// ── MAIN ASSESSMENT ──────────────────────────────────────────────────────────

export function assessChartPrime(card, mtfContext, currentPrice) {
  if (!mtfContext?.panes?.length) {
    return { available: false, note: 'TradingView not available — ChartPrime skipped' };
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

  // ── 4H PRIMARY ──────────────────────────────────────────────────────────────

  if (pane4h) {
    const po4h  = findStudy(pane4h.studies, 'Prime Oscillators');
    const mdp4h = findStudy(pane4h.studies, 'Market Dynamics');

    // Prime Oscillator momentum (weight ×2 — primary momentum signal)
    // Pine lines give the real bar value; Data Window only exposes the static midline (50).
    const poPlot = getPOValueFromLines(pane4h.poLines) ?? po4h?.values?.Plot;
    const poZone = primeOscZone(poPlot);
    if (poZone) {
      const label = `(${fmtNum(poPlot)})`;
      if (isLong) {
        switch (poZone) {
          case 'EXTREME_OS': score += 3; signals.push(`4H PO: 🔥 EXTREME oversold ${label} — sellers exhausted, ideal long`); break;
          case 'OS':         score += 2; signals.push(`4H PO: ✅ oversold zone ${label} — sellers exhausted`); break;
          case 'BULLISH':    score += 1; signals.push(`4H PO: ✅ bullish momentum ${label}`); break;
          case 'NEUTRAL':               signals.push(`4H PO: ⚪ neutral ${label}`); break;
          case 'BEARISH':    score -= 1; warnings.push(`4H PO: ⚠️ bearish momentum ${label}`); break;
          case 'OB':         score -= 1; warnings.push(`4H PO: ⚠️ overbought zone ${label} — buyers stretched`); break;
          case 'EXTREME_OB': score -= 2; warnings.push(`4H PO: ❌ EXTREME overbought ${label} — avoid long entry`); break;
        }
      } else {
        switch (poZone) {
          case 'EXTREME_OB': score += 3; signals.push(`4H PO: 🔥 EXTREME overbought ${label} — buyers exhausted, ideal short`); break;
          case 'OB':         score += 2; signals.push(`4H PO: ✅ overbought zone ${label} — buyers exhausted`); break;
          case 'BEARISH':    score += 1; signals.push(`4H PO: ✅ bearish momentum ${label}`); break;
          case 'NEUTRAL':               signals.push(`4H PO: ⚪ neutral ${label}`); break;
          case 'BULLISH':    score -= 1; warnings.push(`4H PO: ⚠️ bullish momentum ${label}`); break;
          case 'OS':         score -= 1; warnings.push(`4H PO: ⚠️ oversold zone ${label} — sellers stretched`); break;
          case 'EXTREME_OS': score -= 2; warnings.push(`4H PO: ❌ EXTREME oversold ${label} — avoid short entry`); break;
        }
      }
    }

    // Market Dynamics Pro structure
    if (mdp4h) {
      const shapes    = Number(mdp4h.values?.Shapes ?? 0);
      const plotCandle = Number(mdp4h.values?.PlotCandle);

      // Shapes: non-zero = active BOS/CHoCH/pattern signal
      if (!isNaN(shapes) && shapes !== 0) {
        const bullishSignal = shapes > 0;
        if (bullishSignal === isLong) {
          score += 1;
          signals.push(`4H MDP: ✅ ${bullishSignal ? 'BOS/breakout signal' : 'CHoCH/reversal signal'} active`);
        } else {
          warnings.push(`4H MDP: ⚠️ ${bullishSignal ? 'bullish' : 'bearish'} signal against ${direction}`);
        }
      }

      // PlotCandle vs current price: structural position
      if (!isNaN(plotCandle) && currentPrice != null && plotCandle > 0) {
        const aboveRef = currentPrice > plotCandle;
        if (aboveRef === isLong) {
          score += 1;
          signals.push(`4H MDP: ✅ price ${aboveRef ? 'above' : 'below'} structure reference (${fmtNum(plotCandle)})`);
        } else {
          warnings.push(`4H MDP: ⚠️ price ${aboveRef ? 'above' : 'below'} structure reference (${fmtNum(plotCandle)})`);
        }
      }
    }
  }

  // ── 1D MACRO ──────────────────────────────────────────────────────────────

  if (pane1d) {
    const po1d = findStudy(pane1d.studies, 'Prime Oscillators');
    const poPlot = getPOValueFromLines(pane1d.poLines) ?? po1d?.values?.Plot;
    const poZone = primeOscZone(poPlot);

    if (poZone) {
      const label = `(${fmtNum(poPlot)})`;
      const aligned = isLong
        ? ['BULLISH', 'OS', 'EXTREME_OS'].includes(poZone)
        : ['BEARISH', 'OB', 'EXTREME_OB'].includes(poZone);
      const against = isLong
        ? ['OB', 'EXTREME_OB'].includes(poZone)
        : ['OS', 'EXTREME_OS'].includes(poZone);

      if (poZone === (isLong ? 'EXTREME_OS' : 'EXTREME_OB')) {
        score += 2; signals.push(`1D PO: 🔥 extreme ${isLong ? 'oversold' : 'overbought'} on daily ${label}`);
      } else if (aligned) {
        score += 1; signals.push(`1D PO: ✅ ${poZone.toLowerCase()} on daily ${label}`);
      } else if (against) {
        score -= 1; warnings.push(`1D PO: ❌ ${poZone.toLowerCase()} on daily ${label} — against ${direction}`);
      } else if (poZone !== 'NEUTRAL') {
        warnings.push(`1D PO: ⚠️ ${poZone.toLowerCase()} on daily ${label}`);
      }
    }
  }

  // ── 1H CONFIRMATION ──────────────────────────────────────────────────────

  if (pane1h) {
    const po1h = findStudy(pane1h.studies, 'Prime Oscillators');
    const poPlot = getPOValueFromLines(pane1h.poLines) ?? po1h?.values?.Plot;
    const poZone = primeOscZone(poPlot);

    if (poZone && poZone !== 'NEUTRAL') {
      const label = `(${fmtNum(poPlot)})`;
      const aligned = isLong
        ? ['BULLISH', 'OS', 'EXTREME_OS'].includes(poZone)
        : ['BEARISH', 'OB', 'EXTREME_OB'].includes(poZone);
      if (aligned) {
        score += 1; signals.push(`1H PO: ✅ ${poZone.toLowerCase()} ${label}`);
      } else {
        warnings.push(`1H PO: ⚠️ ${poZone.toLowerCase()} ${label}`);
      }
    }
  }

  // ── 15m ENTRY TRIGGER ────────────────────────────────────────────────────

  if (pane15m) {
    const po15m = findStudy(pane15m.studies, 'Prime Oscillators');
    const poPlot = getPOValueFromLines(pane15m.poLines) ?? po15m?.values?.Plot;
    const poZone = primeOscZone(poPlot);

    if (poZone && poZone !== 'NEUTRAL') {
      const label = `(${fmtNum(poPlot)})`;
      const aligned = isLong
        ? ['BULLISH', 'OS', 'EXTREME_OS'].includes(poZone)
        : ['BEARISH', 'OB', 'EXTREME_OB'].includes(poZone);
      if (aligned) {
        score += 1; signals.push(`15m PO: ✅ ${poZone.toLowerCase()} ${label}`);
      } else {
        warnings.push(`15m PO: ⚠️ ${poZone.toLowerCase()} ${label} — entry TF against`);
      }
    }
  }

  // ── RATING ───────────────────────────────────────────────────────────────
  // Max possible: 3+1+1 (4H PO+MDP) + 2 (1D) + 1 (1H) + 1 (15m) = 9
  const extremeAgainst = warnings.some(w => w.includes('EXTREME') && w.includes('avoid'));

  let rating, emoji;
  if (extremeAgainst)   { rating = 'CP: AVOID';     emoji = '🚫'; }
  else if (score >= 5)  { rating = 'CP: CONFIRMED'; emoji = '🟢'; }
  else if (score >= 2)  { rating = 'CP: PARTIAL';   emoji = '🟡'; }
  else if (score >= 0)  { rating = 'CP: NEUTRAL';   emoji = '⚪'; }
  else                  { rating = 'CP: AGAINST';   emoji = '🔴'; }

  return {
    available: true,
    score,
    rating,
    emoji,
    signals,
    warnings,
    extremeAgainst,
  };
}
