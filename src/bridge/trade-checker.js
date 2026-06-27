import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are a pre-trade sanity checker for a crypto futures paper trading system.

Review the trade card and all provided context. Flag trades that are GENUINELY anomalous:
- Strong IADSS or ChartPrime signals directly against the trade direction (score <= -3)
- Entering a duplicate position when the same base/direction is already open
- Stop price on the wrong side of entry
- Entry price so far from current price that the setup has clearly run without you

Do NOT flag most trades. Most setups should pass. Only hold when you see a clear, specific problem.
Do NOT flag trades just because IADSS is neutral or CP is neutral.
Do NOT flag trades because leverage seems high or conviction is MEDIUM — those are by design.

Respond with a single line of JSON only:
{"pass":true}
or
{"hold":true,"reason":"concise one-sentence explanation of the specific problem"}`;

export async function checkTrade(card, assessment, iadss, cp, mtfContext, openTrades) {
  const context = buildContext(card, assessment, iadss, cp, mtfContext, openTrades);
  let text;
  try {
    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 128,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(context) }],
    });
    text = msg.content[0]?.text?.trim();
    const parsed = JSON.parse(text);
    if (parsed.hold === true && typeof parsed.reason === 'string') {
      return { hold: true, reason: parsed.reason };
    }
    return { pass: true };
  } catch (e) {
    if (e instanceof SyntaxError) console.error('[trade-checker] unexpected model response:', text);
    return { pass: true };
  }
}

function buildContext(card, assessment, iadss, cp, mtfContext, openTrades) {
  return {
    card: {
      title: card.card_title,
      symbol: card.symbol,
      direction: card.direction,
      entry_price: card.entry_price,
      stop_price: card.stop_price,
      tp1_price: card.tp1_price,
      tp2_price: card.tp2_price,
      leverage: card.leverage,
      margin_usd: card.margin_usd,
      conviction: card.conviction,
    },
    assessment: {
      status: assessment?.status,
      current_price: assessment?.current_price,
      distance_pct: assessment?.distance_pct,
      note: assessment?.note,
    },
    iadss: iadss?.available ? {
      rating: iadss.rating,
      score: iadss.score,
      signals: iadss.signals,
      warnings: iadss.warnings,
    } : null,
    chartprime: cp?.available ? {
      rating: cp.rating,
      score: cp.score,
      signals: cp.signals,
      warnings: cp.warnings,
    } : null,
    mtf_summary: mtfContext?.panes?.length ? summarizeMTF(mtfContext) : null,
    open_positions: (openTrades ?? []).map(t => ({
      symbol: t.symbol,
      direction: t.direction,
      entry_price: t.entry_price,
    })),
  };
}

function summarizeMTF(mtfContext) {
  return mtfContext.panes.map(p => ({
    timeframe: p.timeframe,
    indicators: (p.studies ?? []).map(s => ({
      name: s.name,
      values: Object.fromEntries(
        Object.entries(s.values ?? {})
          .filter(([k, v]) => v !== null && v !== 0 && !k.startsWith('Nivel'))
          .slice(0, 5)
      ),
    })).filter(s => Object.keys(s.values).length > 0),
  }));
}
