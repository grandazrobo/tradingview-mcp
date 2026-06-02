import { Client, GatewayIntentBits, Events, REST, Routes, SlashCommandBuilder } from 'discord.js';
import Anthropic from '@anthropic-ai/sdk';

const TOKEN      = process.env.DISCORD_BOT_TOKEN;
const APP_ID     = process.env.DISCORD_APP_ID || '1503575804058144808';
const CH_ANALYSIS = process.env.DISCORD_CHANNEL_ANALYSIS;
const CH_ALERTS   = process.env.DISCORD_CHANNEL_TRADE_ALERTS;
const CH_PNL      = process.env.DISCORD_CHANNEL_PNL;

const AI = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an AI trading assistant for a crypto futures trading platform.
You help analyze BTC and SOL (and other crypto) on KuCoin/Binance Futures.
The trader uses 20x-40x leverage, trades intraday setups with TP1/TP2 targets and a stop loss.
Keep responses concise and actionable. Use markdown for Discord.
When asked to analyze a symbol, discuss: trend, key levels, momentum, and a trade recommendation with entry/stop/TP1/TP2.`;

const conversationHistory = {};

function getHistory(userId) {
  if (!conversationHistory[userId]) conversationHistory[userId] = [];
  return conversationHistory[userId];
}

function trimHistory(history) {
  while (history.length > 20) history.splice(0, 2);
}

async function askClaude(userId, userMessage) {
  const history = getHistory(userId);
  history.push({ role: 'user', content: userMessage });
  trimHistory(history);

  const response = await AI.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages: history,
  });

  const reply = response.content[0].text;
  history.push({ role: 'assistant', content: reply });
  return reply;
}

// ── Slash command definitions ──────────────────────────────────────
const commands = [
  new SlashCommandBuilder()
    .setName('analyze')
    .setDescription('Get AI analysis for a symbol')
    .addStringOption(o => o.setName('symbol').setDescription('e.g. BTC, SOL').setRequired(true))
    .addStringOption(o => o.setName('timeframe').setDescription('e.g. 4h, 1h, 15m').setRequired(false)),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Ask the trading AI anything')
    .addStringOption(o => o.setName('question').setDescription('Your question').setRequired(true)),
  new SlashCommandBuilder()
    .setName('clear')
    .setDescription('Clear your conversation history with the AI'),
].map(c => c.toJSON());

async function registerCommands() {
  if (!TOKEN || !APP_ID) return;
  try {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    await rest.put(Routes.applicationCommands(APP_ID), { body: commands });
    console.error('[Discord] Slash commands registered');
  } catch (e) {
    console.error('[Discord] Failed to register commands:', e.message);
  }
}

// ── Bot client ─────────────────────────────────────────────────────
export async function startBot(getState) {
  if (!TOKEN) {
    console.error('[Discord] No DISCORD_BOT_TOKEN — bot disabled');
    return;
  }

  await registerCommands();

  function connect() {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
    });

    client.on('error', err => {
      console.error('[Discord] WebSocket error (will reconnect):', err.message);
    });

    client.on(Events.ShardDisconnect, (_, id) => {
      console.error(`[Discord] Shard ${id} disconnected — reconnecting in 10s`);
      setTimeout(connect, 10_000);
    });

    setupHandlers(client);

    client.login(TOKEN).catch(err => {
      console.error('[Discord] Login failed (will retry in 30s):', err.message);
      setTimeout(connect, 30_000);
    });
  }

  function setupHandlers(client) {

  client.once(Events.ClientReady, () => {
    console.error(`[Discord] Bot ready: ${client.user.tag}`);
    console.error(`[Discord] In ${client.guilds.cache.size} server(s): ${[...client.guilds.cache.values()].map(g => g.name).join(', ')}`);
    console.error(`[Discord] Watching analysis channel: ${CH_ANALYSIS}`);
    console.error(`[Discord] ANTHROPIC_API_KEY set: ${!!process.env.ANTHROPIC_API_KEY}`);
  });

  // ── Slash commands ─────────────────────────────────────────────
  client.on(Events.InteractionCreate, async interaction => {
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply();

    const userId = interaction.user.id;

    try {
      if (interaction.commandName === 'analyze') {
        const symbol    = interaction.options.getString('symbol').toUpperCase();
        const timeframe = interaction.options.getString('timeframe') || '1h';
        const prompt    = `Analyze ${symbol} on the ${timeframe} timeframe. Give me trend, key levels, momentum, and a trade setup with entry, stop, TP1, TP2.`;
        const reply = await askClaude(userId, prompt);
        await interaction.editReply(reply.slice(0, 2000));

      } else if (interaction.commandName === 'ask') {
        const question = interaction.options.getString('question');
        const reply = await askClaude(userId, question);
        await interaction.editReply(reply.slice(0, 2000));

      } else if (interaction.commandName === 'clear') {
        conversationHistory[userId] = [];
        await interaction.editReply('Conversation history cleared.');
      }
    } catch (e) {
      console.error('[Discord] Slash command error:', e.message);
      await interaction.editReply('Error: ' + e.message);
    }
  });

  // ── Free-form chat in #analysis channel ───────────────────────
  client.on(Events.MessageCreate, async message => {
    if (message.author.bot) return;
    console.error(`[Discord] Message in ${message.channelId} (analysis: ${CH_ANALYSIS})`);
    if (message.channelId !== CH_ANALYSIS) return;

    const userId = message.author.id;
    try {
      await message.channel.sendTyping();
      const reply = await askClaude(userId, message.content);
      const chunks = reply.match(/[\s\S]{1,2000}/g) || [reply];
      for (const chunk of chunks) await message.reply(chunk);
    } catch (e) {
      console.error('[Discord] Message handler error:', e.message);
      await message.reply('Sorry, something went wrong: ' + e.message);
    }
  });

  } // end setupHandlers

  connect();
}
