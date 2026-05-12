const BASE = 'https://discord.com/api/v10';

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CH = {
  alerts:   process.env.DISCORD_CHANNEL_TRADE_ALERTS,
  analysis: process.env.DISCORD_CHANNEL_ANALYSIS,
  pnl:      process.env.DISCORD_CHANNEL_PNL,
};

async function send(channelId, payload) {
  if (!TOKEN || !channelId) return;
  try {
    await fetch(`${BASE}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* Discord unavailable */ }
}

function fmt(n, dec = 2) {
  if (!n && n !== 0) return '—';
  return n >= 1000
    ? '$' + n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec })
    : '$' + Number(n).toFixed(dec);
}
function fmtPnl(n) { return (n >= 0 ? '+' : '') + fmt(n); }
function dirEmoji(d) { return d === 'long' ? '🟢' : '🔴'; }

export function notifyTradeOpen(trade) {
  const d = trade.direction;
  const embed = {
    color: d === 'long' ? 0x00d084 : 0xff4444,
    title: `${dirEmoji(d)} ${d.toUpperCase()} — ${trade.symbol.split(':').pop()}`,
    fields: [
      { name: 'Entry',    value: fmt(trade.entry_price),  inline: true },
      { name: 'Leverage', value: `${trade.leverage}×`,    inline: true },
      { name: 'Margin',   value: fmt(trade.margin_usd),   inline: true },
      { name: 'Stop',     value: fmt(trade.stop_price),   inline: true },
      { name: `TP1 (${trade.tp1_split}%)`, value: fmt(trade.tp1_price), inline: true },
      { name: `TP2 (${trade.tp2_split}%)`, value: fmt(trade.tp2_price), inline: true },
      { name: 'Position', value: fmt(trade.position_size, 0), inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'AI Trading Bot' },
  };
  return send(CH.alerts, { embeds: [embed] });
}

export function notifyTp1Hit(trade) {
  const embed = {
    color: 0x00d084,
    title: `✅ TP1 HIT — ${trade.symbol.split(':').pop()}`,
    description: `**${trade.tp1_split}% closed** at ${fmt(trade.tp1_price)}\nStop moved to breakeven: ${fmt(trade.entry_price)}`,
    fields: [
      { name: 'Realized P&L', value: fmtPnl(trade.tp1_pnl), inline: true },
      { name: 'Running to TP2', value: fmt(trade.tp2_price), inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'AI Trading Bot' },
  };
  return send(CH.alerts, { embeds: [embed] });
}

export function notifyTradeClose(trade) {
  const isWin = trade.pnl >= 0;
  const reasonMap = { tp2: '🏆 TP2 HIT', stop: '🛑 STOPPED OUT', manual: '👋 CLOSED MANUALLY' };
  const title = `${reasonMap[trade.exit_reason] || '📤 CLOSED'} — ${trade.symbol.split(':').pop()}`;
  const embed = {
    color: isWin ? 0x00d084 : 0xff4444,
    title,
    fields: [
      { name: 'Direction',  value: trade.direction.toUpperCase(), inline: true },
      { name: 'Leverage',   value: `${trade.leverage}×`,          inline: true },
      { name: 'Margin',     value: fmt(trade.margin_usd),          inline: true },
      { name: 'Entry',      value: fmt(trade.entry_price),         inline: true },
      { name: 'Exit',       value: fmt(trade.exit_price),          inline: true },
      { name: 'Total P&L',  value: fmtPnl(trade.pnl),             inline: true },
    ],
    timestamp: new Date().toISOString(),
    footer: { text: 'AI Trading Bot' },
  };
  // Send close alert to #trade-alerts and P&L summary to #pnl
  send(CH.alerts, { embeds: [embed] });

  const pnlEmbed = {
    color: isWin ? 0x00d084 : 0xff4444,
    title: `${isWin ? '💰 WIN' : '❌ LOSS'} — ${trade.symbol.split(':').pop()} ${trade.leverage}×`,
    description: `**${fmtPnl(trade.pnl)}** on ${fmt(trade.margin_usd)} margin`,
    fields: trade.tp1_pnl > 0
      ? [
          { name: 'TP1 Realized', value: fmtPnl(trade.tp1_pnl), inline: true },
          { name: 'TP2 Realized', value: fmtPnl(trade.pnl - trade.tp1_pnl), inline: true },
        ]
      : [],
    timestamp: new Date().toISOString(),
    footer: { text: 'AI Trading Bot' },
  };
  return send(CH.pnl, { embeds: [pnlEmbed] });
}

export function notifyAnalysis(symbol, timeframe, content) {
  const embed = {
    color: 0x7b9fff,
    title: `📊 Analysis — ${symbol} (${timeframe})`,
    description: content.slice(0, 4000),
    timestamp: new Date().toISOString(),
    footer: { text: 'AI Trading Bot' },
  };
  return send(CH.analysis, { embeds: [embed] });
}
