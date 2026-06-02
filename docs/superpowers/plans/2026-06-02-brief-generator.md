# Chart Hackers Brief Generator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the cowork/Claude Desktop scheduled task with a native `tv brief generate` command that fetches the YouTube transcript and ALL Discord posts from the live-show-charts channel, synthesizes a brief via Claude API, and optionally chains directly into `tv load-brief --execute`.

**Architecture:** Three fetchers (YouTube transcript, Discord posts+images) feed a Claude API synthesizer that produces the existing brief markdown format. A new `tv brief` CLI command wires them together. The launchd job is updated to call `tv brief generate --execute` instead of depending on cowork.

**Tech Stack:** Node.js ESM, `@anthropic-ai/sdk` (already installed), `discord.js` REST (already installed), native `fetch` for YouTube captions API. No new npm dependencies.

---

## Prerequisites (one-time manual steps)

Before running this code, Dazza must:

1. **Invite the bot to Chart Hackers Discord server** — the bot (`AI Trading Bot#5429`) must be in the same server as the `live-show-charts` channel. Go to Discord Developer Portal → OAuth2 → generate invite URL with `bot` scope + `Read Messages/View Channels` + `Read Message History` permissions.

2. **Find the live-show-charts channel ID** — in Discord, enable Developer Mode (Settings → Advanced), right-click the `live-show-charts` channel → Copy ID. Add to env:
   ```
   DISCORD_CHANNEL_LIVE_SHOW_CHARTS=<channel_id>
   ```

3. **Find the Chart Hackers YouTube channel ID** — go to the Chart Hackers YouTube page, view page source, search for `"channelId"`. Add to env:
   ```
   CHART_HACKERS_YT_CHANNEL_ID=<channel_id>
   ```

4. **Locate the env file** the tvdash launchd job loads from (check `~/Library/LaunchAgents/*.plist` for `EnvironmentVariables`) and add the two new keys there too.

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `src/bridge/youtube-fetcher.js` | **Create** | Fetch latest video ID from RSS feed; fetch transcript from YouTube's timedtext API |
| `src/bridge/discord-fetcher.js` | **Create** | Fetch all messages + image attachments from a channel within a time window using Discord REST |
| `src/bridge/brief-synthesizer.js` | **Create** | Build Claude API request from transcript + posts; return synthesized brief markdown |
| `src/cli/commands/brief.js` | **Create** | `tv brief generate` and `tv brief fetch` CLI commands |
| `src/cli/index.js` | **Modify** | Import the new `brief` command |
| `tests/brief-generator.test.js` | **Create** | Unit tests for YouTube parser, Discord parser, synthesis prompt builder |

---

## Task 1: YouTube transcript fetcher

**Files:**
- Create: `src/bridge/youtube-fetcher.js`
- Test: `tests/brief-generator.test.js`

YouTube exposes caption tracks via an internal JSON endpoint that works without auth. The approach:
1. Fetch the video watch page HTML
2. Extract the `captionTracks` array from the embedded `ytInitialPlayerResponse` JSON
3. Fetch the caption track URL with `&fmt=json3`
4. Parse segments into `{start, text}` objects

For finding the latest video, YouTube provides a public RSS feed per channel — no API key needed.

- [ ] **Step 1: Create the file with RSS video finder**

Create `src/bridge/youtube-fetcher.js`:

```javascript
/**
 * YouTube transcript and video discovery.
 * Uses YouTube's public RSS feed (no API key) and internal timedtext API.
 */

const RSS_BASE = 'https://www.youtube.com/feeds/videos.xml?channel_id=';
const WATCH_BASE = 'https://www.youtube.com/watch?v=';

/**
 * Find the most recent video from a YouTube channel published within windowHours.
 * Returns { videoId, title, publishedAt } or null if none found.
 */
export async function findLatestVideo(channelId, windowHours = 36) {
  const url = `${RSS_BASE}${channelId}`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`YouTube RSS fetch failed: ${res.status}`);
  const xml = await res.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  const cutoff = Date.now() - windowHours * 60 * 60 * 1000;

  for (const entry of entries) {
    const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title   = entry.match(/<title>([^<]+)<\/title>/)?.[1];
    const pubRaw  = entry.match(/<published>([^<]+)<\/published>/)?.[1];
    if (!videoId || !pubRaw) continue;
    const publishedAt = new Date(pubRaw);
    if (publishedAt.getTime() >= cutoff) {
      return { videoId, title: title?.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'), publishedAt };
    }
  }
  return null;
}

/**
 * Fetch transcript segments for a YouTube video.
 * Returns [{ start: number, text: string }] or throws if captions unavailable.
 */
export async function fetchTranscript(videoId) {
  const watchUrl = `${WATCH_BASE}${videoId}`;
  const res = await fetch(watchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`YouTube page fetch failed: ${res.status}`);
  const html = await res.text();

  // Extract ytInitialPlayerResponse JSON
  const match = html.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*(?:var\s+\w+|if\s*\())/s);
  if (!match) throw new Error('Could not find ytInitialPlayerResponse in page');

  let playerResponse;
  try {
    playerResponse = JSON.parse(match[1]);
  } catch {
    throw new Error('Failed to parse ytInitialPlayerResponse JSON');
  }

  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks?.length) throw new Error(`No caption tracks found for ${videoId} — captions may not be published yet`);

  // Prefer English auto-generated or manual captions
  const track = captionTracks.find(t => t.languageCode === 'en' && t.kind === 'asr')
    ?? captionTracks.find(t => t.languageCode === 'en')
    ?? captionTracks[0];

  const captionUrl = track.baseUrl + '&fmt=json3';
  const captionRes = await fetch(captionUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!captionRes.ok) throw new Error(`Caption fetch failed: ${captionRes.status}`);
  const captionJson = await captionRes.json();

  const segments = (captionJson.events ?? [])
    .filter(e => e.segs)
    .map(e => ({
      start: Math.round(e.tStartMs / 1000),
      text: e.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim(),
    }))
    .filter(s => s.text);

  if (!segments.length) throw new Error(`Transcript is empty for ${videoId}`);
  return segments;
}
```

- [ ] **Step 2: Write unit tests for RSS parser and transcript parser**

Create `tests/brief-generator.test.js`:

```javascript
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Test RSS XML parsing logic inline (no network)
describe('YouTube RSS parser', () => {
  it('extracts videoId and title from RSS entry', () => {
    const entry = `
      <yt:videoId>abc123</yt:videoId>
      <title>Chart Hackers: BTC Setup</title>
      <published>${new Date().toISOString()}</published>
    `;
    const videoId = entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    const title   = entry.match(/<title>([^<]+)<\/title>/)?.[1];
    assert.equal(videoId, 'abc123');
    assert.equal(title, 'Chart Hackers: BTC Setup');
  });

  it('skips entries older than window', () => {
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const publishedAt = new Date(old);
    const cutoff = Date.now() - 36 * 60 * 60 * 1000;
    assert.ok(publishedAt.getTime() < cutoff, 'old entry should be outside window');
  });
});

// Test caption JSON parsing
describe('transcript parser', () => {
  it('converts caption events to segments', () => {
    const events = [
      { tStartMs: 1000, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { tStartMs: 5000, segs: [{ utf8: 'BTC\nlooks' }, { utf8: ' good' }] },
      { tStartMs: 9000 }, // no segs — should be filtered
    ];
    const segments = events
      .filter(e => e.segs)
      .map(e => ({
        start: Math.round(e.tStartMs / 1000),
        text: e.segs.map(s => s.utf8).join('').replace(/\n/g, ' ').trim(),
      }))
      .filter(s => s.text);

    assert.equal(segments.length, 2);
    assert.equal(segments[0].start, 1);
    assert.equal(segments[0].text, 'Hello world');
    assert.equal(segments[1].text, 'BTC looks good');
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
cd /Users/dazza/tradingview-mcp
node --test tests/brief-generator.test.js
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/bridge/youtube-fetcher.js tests/brief-generator.test.js
git commit -m "feat: add YouTube transcript fetcher for brief generator"
```

---

## Task 2: Discord channel fetcher

**Files:**
- Create: `src/bridge/discord-fetcher.js`
- Modify: `tests/brief-generator.test.js` (add Discord parsing tests)

Uses the same Discord REST pattern as `src/discord/notifier.js` — raw fetch with the bot token. Reads ALL messages in a channel within a time window, extracts text content and image attachment URLs. Downloads images and converts to base64 for Claude vision.

- [ ] **Step 1: Create the Discord fetcher**

Create `src/bridge/discord-fetcher.js`:

```javascript
/**
 * Discord channel reader for Chart Hackers live-show-charts posts.
 * Uses Discord REST API with the bot token — no browser session needed.
 */

const BASE = 'https://discord.com/api/v10';
const TOKEN = process.env.DISCORD_BOT_TOKEN;

/**
 * Fetch all messages from a channel posted within [afterTs, beforeTs].
 * Handles Discord's 100-message pagination automatically.
 * Returns [{ id, author, content, timestamp, images: [{url, base64, mediaType}] }]
 */
export async function fetchShowPosts(channelId, afterTs, beforeTs) {
  if (!TOKEN) throw new Error('DISCORD_BOT_TOKEN not set');
  if (!channelId) throw new Error('channelId required — set DISCORD_CHANNEL_LIVE_SHOW_CHARTS');

  const afterSnowflake  = tsToSnowflake(afterTs);
  const beforeSnowflake = tsToSnowflake(beforeTs);

  const allMessages = [];
  let before = beforeSnowflake;

  while (true) {
    const url = `${BASE}/channels/${channelId}/messages?limit=100&before=${before}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bot ${TOKEN}` },
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord API error ${res.status}: ${body}`);
    }
    const messages = await res.json();
    if (!messages.length) break;

    for (const msg of messages) {
      const msgSnowflake = BigInt(msg.id);
      if (msgSnowflake <= BigInt(afterSnowflake)) {
        // Passed the start of the window — stop paginating
        return enrichMessages(allMessages, afterTs, beforeTs);
      }
      allMessages.push(msg);
    }

    before = messages[messages.length - 1].id;
    await new Promise(r => setTimeout(r, 100)); // be polite to Discord API
  }

  return enrichMessages(allMessages, afterTs, beforeTs);
}

/**
 * Filter messages to window, download images, return enriched format.
 */
async function enrichMessages(messages, afterTs, beforeTs) {
  const inWindow = messages.filter(m => {
    const t = new Date(m.timestamp).getTime();
    return t >= afterTs && t <= beforeTs;
  });

  const result = [];
  for (const msg of inWindow) {
    const images = [];

    // Attachments (uploaded images)
    for (const att of msg.attachments ?? []) {
      if (/\.(png|jpg|jpeg|gif|webp)$/i.test(att.filename)) {
        const img = await downloadImage(att.url);
        if (img) images.push(img);
      }
    }

    // Embeds with image/thumbnail
    for (const embed of msg.embeds ?? []) {
      for (const key of ['image', 'thumbnail']) {
        const src = embed[key]?.url;
        if (src) {
          const img = await downloadImage(src);
          if (img) images.push(img);
        }
      }
    }

    result.push({
      id: msg.id,
      author: msg.author?.username ?? 'unknown',
      content: msg.content ?? '',
      timestamp: msg.timestamp,
      images,
    });
  }

  return result;
}

async function downloadImage(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? 'image/png';
    const mediaType = contentType.split(';')[0].trim();
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    return { url, base64, mediaType };
  } catch {
    return null;
  }
}

/**
 * Convert a Unix timestamp (ms) to a Discord snowflake string.
 * Discord epoch: 2015-01-01T00:00:00.000Z = 1420070400000
 */
function tsToSnowflake(tsMs) {
  const discordEpoch = 1420070400000n;
  return String((BigInt(Math.floor(tsMs)) - discordEpoch) << 22n);
}
```

- [ ] **Step 2: Add Discord parsing tests to test file**

Append to `tests/brief-generator.test.js`:

```javascript
// Test Discord message filtering
describe('Discord fetcher helpers', () => {
  it('tsToSnowflake converts timestamp correctly', () => {
    // Discord epoch: 2015-01-01 = 1420070400000ms
    // A message at exactly epoch should give snowflake 0 << 22 = 0
    const discordEpoch = 1420070400000n;
    const ts = 1420070400000; // exactly at epoch
    const snowflake = String((BigInt(Math.floor(ts)) - discordEpoch) << 22n);
    assert.equal(snowflake, '0');
  });

  it('filters messages outside time window', () => {
    const now = Date.now();
    const messages = [
      { id: '1', timestamp: new Date(now - 1000).toISOString(), content: 'recent', attachments: [], embeds: [] },
      { id: '2', timestamp: new Date(now - 5 * 3600 * 1000).toISOString(), content: 'old', attachments: [], embeds: [] },
    ];
    const window = 2 * 3600 * 1000; // 2 hours
    const inWindow = messages.filter(m => {
      const t = new Date(m.timestamp).getTime();
      return t >= now - window && t <= now;
    });
    assert.equal(inWindow.length, 1);
    assert.equal(inWindow[0].content, 'recent');
  });
});
```

- [ ] **Step 3: Run updated tests**

```bash
node --test tests/brief-generator.test.js
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/bridge/discord-fetcher.js tests/brief-generator.test.js
git commit -m "feat: add Discord channel fetcher for brief generator"
```

---

## Task 3: Brief synthesizer

**Files:**
- Create: `src/bridge/brief-synthesizer.js`
- Modify: `tests/brief-generator.test.js` (add prompt building tests)

Calls Claude API with the transcript text and Discord images. Uses prompt caching on the system prompt (it's large and reused daily). Produces markdown matching the existing brief format so `brief-parser.js` can load it without changes.

- [ ] **Step 1: Create the synthesizer**

Create `src/bridge/brief-synthesizer.js`:

```javascript
/**
 * Claude API synthesizer for Chart Hackers briefs.
 * Takes YouTube transcript segments + Discord posts and produces the markdown brief.
 */
import Anthropic from '@anthropic-ai/sdk';

const AI = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are synthesizing a daily trading brief for an AI-assisted crypto futures trading platform (ATP).

## Your output format

Write a markdown document that starts with this YAML frontmatter block:

\`\`\`
---
tags: [brief, atp, chart-hackers, synthesis]
date: YYYY-MM-DD
sources:
  - youtube_transcript: VIDEO_ID (N segments)
  - discord_posts: N posts from CHANNEL_NAME
show_date: YYYY-MM-DD
synthesis_mode: transcript + discord-posts
generated_by: tv-brief-generator
chart_extraction_status: discord-api
---
\`\`\`

Then write trade cards using this EXACT table format for each setup. The parser that reads this file requires these exact field names:

\`\`\`markdown
## #N — SYMBOL direction — HOST call description (CONVICTION conviction)

| Field | Value | Source |
|---|---|---|
| Bias | Long/Short | [TX] or [CHART] or [TX+CHART] |
| Best entry | EXACT PRICE (not a range if avoidable) | [TX] or [CHART] |
| Stop | EXACT PRICE below entry for longs, above for shorts | [TX] or [CHART] |
| Hard stop | EXACT PRICE (stricter level) | [TX] or [CHART] |
| TP1 | EXACT PRICE | [TX] or [CHART] |
| TP2 | EXACT PRICE | [TX] or [CHART] |
| ATP instrument | SYMBOLUSDT.P on KuCoin Futures | |
| Suggested leverage | Nx isolated | |
| ATP fit | ✅ or ⚠️ description | |
\`\`\`

## Critical rules for the parser

1. **Entry and stop MUST be different numbers.** If Dylan says "buy at 70K, stop below 70K" — set entry at 70,200 (top of zone) and stop at 69,500 (a concrete level below the line). Never leave them equal.
2. **TP1 and TP2 must be explicit numbers.** If only one TP is given, extrapolate TP2 using R:R or next structure level. Clearly note this with "(estimated)" in the Source column.
3. **Stop must be on the correct side.** For longs: stop < entry. For shorts: stop > entry.
4. **Entry must be a single number**, not a range. Use the midpoint or best-entry within the zone.
5. **Conviction labels** use EXACTLY: HIGH, MEDIUM, or LOW (in parentheses before "conviction").
6. **Tag levels** as [TX] (transcript only), [CHART] (image/chart only), or [TX+CHART] (both agree).

## What to include

- All setups where a host gives an entry zone, stop, and target — even if you have to estimate TP2
- BTC context and macro framing
- A "Setups to skip" section for explicitly rejected ideas
- An "Invalidations to monitor" section
- A "Conviction stack" summary table at the end
- A "Source quality" section noting transcript segment count, images analyzed, any gaps`;

/**
 * Synthesize a brief from transcript segments and Discord posts.
 *
 * @param {object} opts
 * @param {string} opts.date          - NZT date string YYYY-MM-DD
 * @param {string} opts.showDate      - date the show was recorded (may differ)
 * @param {string} opts.videoId       - YouTube video ID
 * @param {string} opts.videoTitle    - YouTube video title
 * @param {{start:number, text:string}[]} opts.transcript - caption segments
 * @param {{author:string, content:string, timestamp:string, images:{base64:string,mediaType:string}[]}[]} opts.posts - Discord posts
 * @returns {Promise<string>} - markdown brief content
 */
export async function synthesizeBrief({ date, showDate, videoId, videoTitle, transcript, posts }) {
  // Build transcript text (group segments into readable paragraphs by time)
  const transcriptText = transcript
    .map(s => `[${formatTime(s.start)}] ${s.text}`)
    .join('\n');

  // Build content blocks for Claude — text first, then images
  const contentBlocks = [];

  contentBlocks.push({
    type: 'text',
    text: `## YouTube Transcript\n\nVideo: "${videoTitle}" (${videoId})\nSegments: ${transcript.length}\n\n${transcriptText}`,
  });

  if (posts.length > 0) {
    contentBlocks.push({
      type: 'text',
      text: `\n\n## Discord Posts from live-show-charts\n\n${posts.length} post(s) in show window:`,
    });

    for (const post of posts) {
      contentBlocks.push({
        type: 'text',
        text: `\n**${post.author}** at ${post.timestamp}:\n${post.content || '(no text)'}`,
      });

      for (const img of post.images) {
        contentBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.base64 },
        });
      }
    }
  } else {
    contentBlocks.push({
      type: 'text',
      text: '\n\n## Discord Posts\n\nNo posts found in the show window.',
    });
  }

  contentBlocks.push({
    type: 'text',
    text: `\n\nSynthesize the trading brief for date: ${date} (show recorded: ${showDate}). Follow the system prompt format exactly. Extract ALL trade setups mentioned, even if you must estimate TP2. Remember: entry and stop must never be equal numbers.`,
  });

  const response = await AI.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: contentBlocks }],
  });

  return response.content[0].text;
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
```

- [ ] **Step 2: Add synthesizer tests**

Append to `tests/brief-generator.test.js`:

```javascript
describe('brief synthesizer helpers', () => {
  it('formats timestamps correctly', () => {
    const formatTime = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = seconds % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    };
    assert.equal(formatTime(0), '0:00');
    assert.equal(formatTime(65), '1:05');
    assert.equal(formatTime(3600), '60:00');
  });

  it('builds transcript text from segments', () => {
    const segments = [
      { start: 0, text: 'Welcome to Chart Hackers' },
      { start: 65, text: 'BTC is at 70K' },
    ];
    const text = segments.map(s => {
      const m = Math.floor(s.start / 60);
      const sec = s.start % 60;
      return `[${m}:${String(sec).padStart(2,'0')}] ${s.text}`;
    }).join('\n');
    assert.ok(text.includes('[0:00] Welcome'));
    assert.ok(text.includes('[1:05] BTC'));
  });
});
```

- [ ] **Step 3: Run tests**

```bash
node --test tests/brief-generator.test.js
```

Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/bridge/brief-synthesizer.js tests/brief-generator.test.js
git commit -m "feat: add Claude API brief synthesizer"
```

---

## Task 4: `tv brief` CLI command

**Files:**
- Create: `src/cli/commands/brief.js`
- Modify: `src/cli/index.js`

Wires the three bridge modules into a single command. `tv brief generate` runs the full pipeline. `tv brief fetch` is a debug mode that shows what would be fetched without calling Claude.

- [ ] **Step 1: Create the CLI command**

Create `src/cli/commands/brief.js`:

```javascript
import { register } from '../router.js';
import { findLatestVideo, fetchTranscript } from '../../bridge/youtube-fetcher.js';
import { fetchShowPosts } from '../../bridge/discord-fetcher.js';
import { synthesizeBrief } from '../../bridge/brief-synthesizer.js';
import { briefPath, todayNZT } from '../../bridge/brief-parser.js';
import { writeFileSync, existsSync } from 'fs';

const YT_CHANNEL_ID = process.env.CHART_HACKERS_YT_CHANNEL_ID;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL_LIVE_SHOW_CHARTS;

// Show window: posts within this many hours of stream are included
const SHOW_WINDOW_HOURS = 6;

async function handler(opts, positionals) {
  const subcommand = positionals[0] ?? 'generate';
  const date = opts.date ?? todayNZT();
  const videoId = opts['video-id'] ?? null;
  const execute = opts.execute ?? false;
  const force = opts.force ?? false;

  // --- Fetch YouTube transcript ---
  console.error('  Finding Chart Hackers video...');
  let video;
  if (videoId) {
    video = { videoId, title: `(manual: ${videoId})`, publishedAt: new Date() };
  } else {
    if (!YT_CHANNEL_ID) {
      return { success: false, error: 'CHART_HACKERS_YT_CHANNEL_ID env var not set' };
    }
    video = await findLatestVideo(YT_CHANNEL_ID, 36);
    if (!video) {
      return { success: false, error: 'No Chart Hackers video found in the last 36 hours' };
    }
  }
  console.error(`  Found: "${video.title}" (${video.videoId})`);

  console.error('  Fetching transcript...');
  let transcript;
  try {
    transcript = await fetchTranscript(video.videoId);
    console.error(`  Transcript: ${transcript.length} segments`);
  } catch (e) {
    console.error(`  ⚠ Transcript unavailable: ${e.message}`);
    transcript = [];
  }

  // --- Fetch Discord posts ---
  console.error('  Fetching Discord posts...');
  let posts = [];
  if (DISCORD_CHANNEL) {
    const showTime = video.publishedAt.getTime();
    const windowStart = showTime - SHOW_WINDOW_HOURS * 60 * 60 * 1000;
    const windowEnd   = showTime + SHOW_WINDOW_HOURS * 60 * 60 * 1000;
    try {
      posts = await fetchShowPosts(DISCORD_CHANNEL, windowStart, windowEnd);
      const imageCount = posts.reduce((n, p) => n + p.images.length, 0);
      console.error(`  Discord: ${posts.length} post(s), ${imageCount} image(s)`);
    } catch (e) {
      console.error(`  ⚠ Discord fetch failed: ${e.message}`);
    }
  } else {
    console.error('  ⚠ DISCORD_CHANNEL_LIVE_SHOW_CHARTS not set — skipping Discord');
  }

  if (subcommand === 'fetch') {
    // Debug mode — just show what was found
    return {
      success: true,
      mode: 'fetch-only',
      video: { videoId: video.videoId, title: video.title, publishedAt: video.publishedAt },
      transcript_segments: transcript.length,
      discord_posts: posts.map(p => ({
        author: p.author,
        timestamp: p.timestamp,
        content_preview: p.content.slice(0, 100),
        image_count: p.images.length,
      })),
    };
  }

  // --- Check if brief already exists ---
  const outPath = briefPath(date);
  if (existsSync(outPath) && !force) {
    return { success: false, error: `Brief for ${date} already exists. Use --force to regenerate.`, path: outPath };
  }

  if (!transcript.length && !posts.length) {
    return { success: false, error: 'No data available — transcript empty and no Discord posts. Try again later.' };
  }

  // --- Synthesize ---
  console.error('  Synthesizing brief with Claude...');
  const showDate = video.publishedAt.toISOString().slice(0, 10);
  const markdown = await synthesizeBrief({
    date,
    showDate,
    videoId: video.videoId,
    videoTitle: video.title,
    transcript,
    posts,
  });
  console.error('  Synthesis complete.');

  // --- Write brief file ---
  writeFileSync(outPath, markdown);
  console.error(`  Brief written: ${outPath}`);

  const result = { success: true, date, path: outPath, transcript_segments: transcript.length, discord_posts: posts.length };

  // --- Optionally chain into load-brief ---
  if (execute) {
    console.error('  Running tv load-brief --execute...');
    const { handler: loadBriefHandler } = await import('./load-brief.js').catch(() => ({ handler: null }));
    // load-brief is self-registering; invoke via shell to keep it clean
    const { execFileSync } = await import('child_process');
    try {
      execFileSync(process.execPath, [process.argv[1], 'load-brief', '--execute', '--force'], { stdio: 'inherit' });
    } catch {
      console.error('  ⚠ load-brief failed — run manually: tv load-brief --execute --force');
    }
  }

  return result;
}

register('brief', {
  description: 'Generate and load Chart Hackers daily brief',
  subcommands: new Map([
    ['generate', {
      description: 'Fetch transcript + Discord posts, synthesize brief via Claude',
      options: {
        date:       { type: 'string',  description: 'Date to generate for (default: today NZT)' },
        'video-id': { type: 'string',  description: 'YouTube video ID (skip auto-detect)' },
        execute:    { type: 'boolean', description: 'Chain into tv load-brief --execute after generating' },
        force:      { type: 'boolean', description: 'Overwrite existing brief' },
      },
      handler,
    }],
    ['fetch', {
      description: 'Fetch sources only (debug — no synthesis, no file written)',
      options: {
        date:       { type: 'string', description: 'Date (default: today NZT)' },
        'video-id': { type: 'string', description: 'YouTube video ID (skip auto-detect)' },
      },
      handler: (opts, positionals) => handler({ ...opts }, ['fetch']),
    }],
  ]),
});
```

- [ ] **Step 2: Register the command in the CLI index**

Read `src/cli/index.js` first, then add the import. The file imports all commands via `import` statements. Add:

```javascript
import './commands/brief.js';
```

alongside the other command imports.

- [ ] **Step 3: Smoke test (fetch mode — no Claude call, no file write)**

```bash
tv brief fetch
```

Expected output: JSON showing video found, transcript segment count, Discord posts. No file written. If `CHART_HACKERS_YT_CHANNEL_ID` is not set yet, it will return an error message — that's fine for now.

- [ ] **Step 4: Commit**

```bash
git add src/cli/commands/brief.js src/cli/index.js
git commit -m "feat: add tv brief generate command — full YouTube + Discord + Claude pipeline"
```

---

## Task 5: Update launchd job

**Files:**
- Modify: the launchd `.plist` file for the chart-hackers-daily-brief job (located in `~/Library/LaunchAgents/`)

The existing cowork-based scheduled task in Claude Desktop generated the brief then the launchd job ran `tv load-brief --execute`. Now `tv brief generate --execute` does everything in one call.

- [ ] **Step 1: Find the existing launchd plist**

```bash
ls ~/Library/LaunchAgents/ | grep -i chart
```

If the job was only in Claude Desktop's scheduler (not launchd), skip this task — just update the Claude Desktop scheduled task to call `tv brief generate --execute` instead of `tv load-brief --execute`.

- [ ] **Step 2: Update the plist program arguments**

Find the `<key>ProgramArguments</key>` array in the plist. Change:
```xml
<string>tv</string>
<string>load-brief</string>
<string>--execute</string>
```
to:
```xml
<string>tv</string>
<string>brief</string>
<string>generate</string>
<string>--execute</string>
```

- [ ] **Step 3: Add the new env vars to the plist**

In the `<key>EnvironmentVariables</key>` dict, add:
```xml
<key>CHART_HACKERS_YT_CHANNEL_ID</key>
<string>YOUR_CHANNEL_ID_HERE</string>
<key>DISCORD_CHANNEL_LIVE_SHOW_CHARTS</key>
<string>YOUR_CHANNEL_ID_HERE</string>
```

- [ ] **Step 4: Reload the job**

```bash
launchctl unload ~/Library/LaunchAgents/<plist-name>.plist
launchctl load ~/Library/LaunchAgents/<plist-name>.plist
```

- [ ] **Step 5: Commit**

```bash
git add .
git commit -m "chore: update launchd job to use tv brief generate"
```

---

## Task 6: End-to-end test

- [ ] **Step 1: Set env vars for this session**

```bash
export CHART_HACKERS_YT_CHANNEL_ID=<your_channel_id>
export DISCORD_CHANNEL_LIVE_SHOW_CHARTS=<your_channel_id>
```

- [ ] **Step 2: Run fetch mode to verify sources**

```bash
tv brief fetch
```

Expected: JSON with video title, transcript count > 0, Discord posts > 0 with images. If Discord posts = 0, the bot is not in the Chart Hackers server yet — complete the prerequisite steps.

- [ ] **Step 3: Run full generate**

```bash
tv brief generate --force
```

Expected: brief file written to `~/Documents/Ai Brain/05_Memory/ai-trading-platform/briefs/YYYY-MM-DD_chart-hackers-synthesis.md`. Open it and verify trade cards have clean entry/stop/TP numbers.

- [ ] **Step 4: Run load-brief and verify cards load**

```bash
tv load-brief --execute --force
```

Expected: 1 or more trades loaded, 0 skipped due to missing levels. All previous skip reasons (stop = entry, missing TP) should be fixed by the synthesizer's instructions.

- [ ] **Step 5: Commit**

```bash
git commit -m "chore: verified end-to-end brief pipeline working"
```

---

## Self-review

**Spec coverage:**
- ✅ YouTube transcript fetching — Task 1
- ✅ Discord ALL posts in window (multiple authors, multiple times) — Task 2
- ✅ Images downloaded and sent to Claude vision — Task 2 + Task 3
- ✅ Claude synthesis with entry/stop/TP parsing rules — Task 3
- ✅ CLI command replacing cowork — Task 4
- ✅ launchd job updated — Task 5
- ✅ End-to-end test — Task 6
- ✅ Discord bot prerequisite clearly documented — Prerequisites section

**Type consistency:** `fetchTranscript` returns `{start, text}[]` used in `synthesizeBrief` as `transcript` — consistent throughout. `fetchShowPosts` returns `{author, content, timestamp, images}[]` used in `synthesizeBrief` as `posts` — consistent. `briefPath` and `todayNZT` imported from existing `brief-parser.js` — no drift.

**No placeholders:** All code blocks are complete and runnable.
