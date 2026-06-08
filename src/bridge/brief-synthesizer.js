/**
 * Brief synthesizer — calls Claude API to produce a daily trading brief
 * from a YouTube transcript + Discord posts.
 */

import Anthropic from '@anthropic-ai/sdk';

// ── System prompt ──────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are synthesizing a daily trading brief for an AI-assisted crypto futures trading platform (ATP).

## You will output TWO documents separated by the exact line: ===FEED===

---

## DOCUMENT 1: Synthesis Brief (trade cards)

Write a markdown document starting with YAML frontmatter exactly like this:

\`\`\`yaml
---
date: YYYY-MM-DD          # brief date from user message — do NOT change
show: Chart Hackers
episode_title: "exact YouTube video title"
hosts: "host name(s) identified from transcript"
video_id: xxxxxxxxxxx
show_published: "YYYY-MM-DD HH:MM UTC"   # from show_published in user message
tone: one-line macro bias description
---
\`\`\`

Then trade cards using this EXACT table format:

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

## Sections to include in Document 1

- Chart-confirmed levels section (from Discord images)
- All trade cards (##  #N — ...)
- Setups to skip section
- Invalidations to monitor section
- Conviction stack summary table
- Source quality section

---

## DOCUMENT 2: Feed File (narrative analysis)

After all of Document 1, output the separator line on its own line:
===FEED===

Then write a feed document with this YAML frontmatter:

\`\`\`yaml
---
tags: [feed, chart-hackers, atp, daily]
source: youtube
date: YYYY-MM-DD          # same brief date
video_id: xxxxxxxxxxx
video_url: https://www.youtube.com/watch?v=xxxxxxxxxxx
channel: Chart Hackers
host: "host name(s)"
show_type: analysis|live_trading|education   # pick the most accurate
ingest_mode: transcript+discord
duration: "H:MM"          # from metadata in user message
published: "YYYY-MM-DDTHH:MM:SS+00:00"      # ISO format from show_published
transcript_segments: N    # number from metadata in user message
note: |
  2–3 sentences describing what made this episode unique — hosts, format, key theme
---
\`\`\`

Then write these sections:

# Chart Hackers — YYYY-MM-DD brief

## Headline thesis
One tight paragraph summarising the macro framework, who presented, and the core directional bias.

## Specific levels & calls
One subsection per coin discussed (### BTCUSDT, ### ETHUSDT etc.).
Each subsection: a table of levels with Role and exact host quote, then any concrete setup (entry/stop/target) called out.

## Scope rule assessment
Were the hosts actively in trades during this show? Were the setups concrete (specific entry + stop) or vague? Assess each setup against the ATP scope rule: only load setups with a specific entry price AND a stop — no conditional or "manage by structure" setups.

## Cross-check against ATP rules
| ATP rule | Today's signal |
|---|---|
List 4–6 ATP rules and whether today's show aligned or contradicted each.

## Source quality
One paragraph: transcript quality, Discord chart coverage, host agreement level, any caveats.`;

// ── Helpers ────────────────────────────────────────────────────────────────────

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

// ── Content block builder ──────────────────────────────────────────────────────

/**
 * Build an array of Anthropic content blocks from transcript + Discord posts.
 */
export function buildContentBlocks({ videoId, videoTitle, transcript, posts }) {
  const blocks = [];

  const transcriptLines = (transcript ?? [])
    .map(seg => `[${formatTime(Math.floor(seg.start))}] ${seg.text}`)
    .join('\n');

  blocks.push({
    type: 'text',
    text: `# YouTube Transcript\nVideo: ${videoTitle} (${videoId})\n\n${transcriptLines}`,
  });

  blocks.push({
    type: 'text',
    text: '# Discord Posts',
  });

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
 * Call Claude API to synthesize a daily trading brief + feed file.
 *
 * @param {object} opts
 * @param {string} opts.date              NZT date string e.g. "2026-06-09"
 * @param {string} opts.showDatetime      UTC datetime of video publish e.g. "2026-06-08 18:42:36 UTC"
 * @param {string} opts.videoId
 * @param {string} opts.videoTitle
 * @param {number} opts.transcriptCount   Number of transcript segments
 * @param {number} opts.durationSecs      Approx video duration in seconds
 * @param {Array}  opts.transcript
 * @param {Array}  opts.posts
 * @returns {Promise<{briefText: string, feedText: string}>}
 */
export async function synthesizeBrief({ date, showDatetime, videoId, videoTitle, transcriptCount, durationSecs, transcript, posts }) {
  const client = new Anthropic();

  const duration = formatDuration(durationSecs ?? 0);

  const contentBlocks = [
    {
      type: 'text',
      text: [
        `Brief date: ${date}`,
        `Show published: ${showDatetime}`,
        `Video ID: ${videoId}`,
        `Transcript segments: ${transcriptCount}`,
        `Approx duration: ${duration}`,
        '',
        `Use "${date}" as the date field and "${showDatetime}" as show_published in both documents.`,
      ].join('\n'),
    },
    ...buildContentBlocks({ videoId, videoTitle, transcript, posts }),
  ];

  const response = await client.messages.create({
    model: 'claude-opus-4-7',
    max_tokens: 12000,
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

  const raw = response.content[0].text;
  const sep = raw.indexOf('\n===FEED===\n');
  if (sep === -1) {
    return { briefText: raw, feedText: null };
  }

  return {
    briefText: raw.slice(0, sep).trim(),
    feedText: raw.slice(sep + '\n===FEED===\n'.length).trim(),
  };
}
