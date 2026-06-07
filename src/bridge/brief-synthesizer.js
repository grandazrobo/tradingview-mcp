/**
 * Brief synthesizer — calls Claude API to produce a daily trading brief
 * from a YouTube transcript + Discord posts.
 */

import Anthropic from '@anthropic-ai/sdk';

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are synthesizing a daily trading brief for an AI-assisted crypto futures trading platform (ATP).

## Your output format

Write a markdown document starting with YAML frontmatter. The `date:` field in the frontmatter MUST be the brief date provided in the user message — do NOT infer it from video content or titles. Then trade cards using this EXACT table format:

## #N — SYMBOL direction — HOST call description (CONVICTION conviction)

| Field | Value | Source |
|---|---|---|
| Bias | Long/Short | [TX] or [CHART] or [TX+CHART] |
| Best entry | EXACT PRICE | source |
| Stop | EXACT PRICE | source |
| Hard stop | EXACT PRICE | source |
| TP1 | EXACT PRICE | source |
| TP2 | EXACT PRICE | source |
| ATP instrument | SYMBOLUSDT.P on KuCoin Futures | |
| Suggested leverage | Nx isolated | |
| ATP fit | ✅ or ⚠️ description | |

## Critical parser rules (MUST follow)

1. Entry and stop MUST be different numbers. If a host says "buy at 70K, stop below 70K" — set entry at the top of the zone (e.g. 70,200) and stop at a concrete level below (e.g. 69,500). Never equal.
2. TP1 and TP2 must be explicit numbers. Extrapolate TP2 from R:R or next structure if only one TP given. Note "(estimated)" in Source.
3. Stop must be on correct side: longs stop < entry, shorts stop > entry.
4. Entry must be a single number, not a range. Use midpoint or best-entry within the zone.
5. Conviction labels: exactly HIGH, MEDIUM, or LOW in parentheses before "conviction".
6. Tag levels: [TX] transcript only, [CHART] image only, [TX+CHART] both agree.

## Sections to include

- Chart-confirmed levels section (from Discord images)
- All trade cards (##  #N — ...)
- Setups to skip section
- Invalidations to monitor section
- Conviction stack summary table
- Source quality section`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── Content block builder ──────────────────────────────────────────────────────

/**
 * Build an array of Anthropic content blocks from transcript + Discord posts.
 *
 * @param {object} opts
 * @param {string} opts.videoId
 * @param {string} opts.videoTitle
 * @param {Array<{start: number, text: string}>} opts.transcript
 * @param {Array<{author: string, timestamp: string, content: string, images: Array<{base64: string, mediaType: string}>}>} opts.posts
 * @returns {Array<object>} Anthropic content blocks
 */
export function buildContentBlocks({ videoId, videoTitle, transcript, posts }) {
  const blocks = [];

  // ── Transcript block ───────────────────────────────────────────────────────
  const transcriptLines = (transcript ?? [])
    .map(seg => `[${formatTime(Math.floor(seg.start))}] ${seg.text}`)
    .join('\n');

  blocks.push({
    type: 'text',
    text: `# YouTube Transcript\nVideo: ${videoTitle} (${videoId})\n\n${transcriptLines}`,
  });

  // ── Discord section header ─────────────────────────────────────────────────
  blocks.push({
    type: 'text',
    text: '# Discord Posts',
  });

  // ── Per-post blocks ────────────────────────────────────────────────────────
  for (const post of (posts ?? [])) {
    blocks.push({
      type: 'text',
      text: `**Author:** ${post.author}\n**Timestamp:** ${post.timestamp}\n\n${post.content}`,
    });

    for (const img of (post.images ?? [])) {
      blocks.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: img.mediaType,
          data: img.base64,
        },
      });
    }
  }

  return blocks;
}

// ── Main synthesizer ───────────────────────────────────────────────────────────

/**
 * Call Claude API to synthesize a daily trading brief.
 *
 * @param {object} opts
 * @param {string} opts.date          ISO date string e.g. "2026-06-01"
 * @param {string} opts.showDate      Human-readable date for the brief header
 * @param {string} opts.videoId
 * @param {string} opts.videoTitle
 * @param {Array}  opts.transcript
 * @param {Array}  opts.posts
 * @returns {Promise<string>} Markdown brief text
 */
export async function synthesizeBrief({ date, showDate, videoId, videoTitle, transcript, posts }) {
  const client = new Anthropic();

  const contentBlocks = [
    {
      type: 'text',
      text: `Brief date: ${date}\nShow date: ${showDate}\n\nUse "${date}" as the date field in the YAML frontmatter.`,
    },
    ...buildContentBlocks({ videoId, videoTitle, transcript, posts }),
  ];

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 8192,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content: contentBlocks,
      },
    ],
  });

  return response.content[0].text;
}
