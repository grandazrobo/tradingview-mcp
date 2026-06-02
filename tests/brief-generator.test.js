/**
 * Unit tests for YouTube transcript fetcher parsing logic.
 * No real network calls — tests parsing functions only.
 *
 * Run: node --test tests/brief-generator.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRssEntry, filterByWindow, parseCaptionEvents } from '../src/bridge/youtube-fetcher.js';
import { tsToSnowflake, filterMessages, extractImageUrls } from '../src/bridge/discord-fetcher.js';
import { buildContentBlocks } from '../src/bridge/brief-synthesizer.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RSS XML parser', () => {
  it('extracts videoId and title from a valid entry', () => {
    const entry = `
      <yt:videoId>dQw4w9WgXcQ</yt:videoId>
      <title>Never Gonna Give You Up</title>
      <published>2024-01-15T10:30:00+00:00</published>
    `;
    const result = parseRssEntry(entry);
    assert.ok(result !== null);
    assert.equal(result.videoId, 'dQw4w9WgXcQ');
    assert.equal(result.title, 'Never Gonna Give You Up');
    assert.ok(result.publishedAt instanceof Date);
    assert.equal(result.publishedAt.toISOString(), '2024-01-15T10:30:00.000Z');
  });

  it('HTML-decodes &amp; &lt; &gt; in titles', () => {
    const entry = `
      <yt:videoId>abc123</yt:videoId>
      <title>BTC &amp; ETH &lt;Analysis&gt; — Q1</title>
      <published>2024-03-01T08:00:00+00:00</published>
    `;
    const result = parseRssEntry(entry);
    assert.ok(result !== null);
    assert.equal(result.title, 'BTC & ETH <Analysis> — Q1');
  });

  it('returns null when videoId is missing', () => {
    const entry = `
      <title>Some Video</title>
      <published>2024-01-15T10:30:00+00:00</published>
    `;
    assert.equal(parseRssEntry(entry), null);
  });

  it('returns null when title is missing', () => {
    const entry = `
      <yt:videoId>dQw4w9WgXcQ</yt:videoId>
      <published>2024-01-15T10:30:00+00:00</published>
    `;
    assert.equal(parseRssEntry(entry), null);
  });
});

describe('RSS time window filter', () => {
  const now = new Date('2024-06-01T12:00:00Z');

  const entries = [
    {
      videoId: 'recent1',
      title: 'Recent Video',
      publishedAt: new Date('2024-06-01T00:00:00Z'), // 12h ago — within 36h
    },
    {
      videoId: 'old1',
      title: 'Old Video',
      publishedAt: new Date('2024-05-30T00:00:00Z'), // 60h ago — outside 36h
    },
    {
      videoId: 'borderline',
      title: 'Borderline Video',
      publishedAt: new Date('2024-05-31T00:00:00Z'), // exactly 36h ago — on the cutoff boundary (included)
    },
    {
      videoId: 'recent2',
      title: 'Another Recent',
      publishedAt: new Date('2024-06-01T06:00:00Z'), // 6h ago — within 36h
    },
  ];

  it('includes entries within the window', () => {
    const result = filterByWindow(entries, 36, now);
    const ids = result.map(e => e.videoId);
    assert.ok(ids.includes('recent1'));
    assert.ok(ids.includes('recent2'));
  });

  it('excludes entries older than the window', () => {
    const result = filterByWindow(entries, 36, now);
    const ids = result.map(e => e.videoId);
    // old1 is 60h ago — outside the 36h window
    assert.ok(!ids.includes('old1'));
    // borderline is exactly on the cutoff boundary — included (>= cutoff)
    assert.ok(ids.includes('borderline'));
  });

  it('returns empty array when all entries are too old', () => {
    const oldEntries = [
      { videoId: 'x', title: 'X', publishedAt: new Date('2024-05-25T00:00:00Z') },
    ];
    const result = filterByWindow(oldEntries, 36, now);
    assert.equal(result.length, 0);
  });

  it('respects custom window hours', () => {
    // With 24h window, only recent2 (6h ago) and recent1 (12h ago) pass
    const result = filterByWindow(entries, 24, now);
    const ids = result.map(e => e.videoId);
    assert.ok(ids.includes('recent1'));
    assert.ok(ids.includes('recent2'));
    assert.ok(!ids.includes('old1'));
  });
});

describe('Caption event parser', () => {
  it('converts events with segs to {start, text} segments', () => {
    const events = [
      { tStartMs: 0, segs: [{ utf8: 'Hello' }, { utf8: ' world' }] },
      { tStartMs: 5000, segs: [{ utf8: 'How are you' }] },
    ];
    const result = parseCaptionEvents(events);
    assert.equal(result.length, 2);
    assert.equal(result[0].start, 0);
    assert.equal(result[0].text, 'Hello world');
    assert.equal(result[1].start, 5);
    assert.equal(result[1].text, 'How are you');
  });

  it('filters out events with no segs array', () => {
    const events = [
      { tStartMs: 0 }, // no segs
      { tStartMs: 1000, segs: [{ utf8: 'Good text' }] },
      { tStartMs: 2000, segs: [] }, // empty segs
    ];
    const result = parseCaptionEvents(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Good text');
  });

  it('collapses newlines in seg utf8 text to spaces', () => {
    const events = [
      { tStartMs: 3000, segs: [{ utf8: 'line one\nline two' }, { utf8: '\nline three' }] },
    ];
    const result = parseCaptionEvents(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'line one line two line three');
    assert.equal(result[0].start, 3);
  });

  it('filters out events where all segs produce empty text', () => {
    const events = [
      { tStartMs: 0, segs: [{ utf8: '  ' }, { utf8: '\n' }] },
      { tStartMs: 1000, segs: [{ utf8: 'Real content' }] },
    ];
    const result = parseCaptionEvents(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Real content');
  });

  it('handles missing utf8 field in seg gracefully', () => {
    const events = [
      { tStartMs: 500, segs: [{ utf8: 'Good' }, {}, { utf8: ' stuff' }] },
    ];
    const result = parseCaptionEvents(events);
    assert.equal(result.length, 1);
    assert.equal(result[0].text, 'Good stuff');
  });

  it('converts tStartMs to seconds', () => {
    const events = [
      { tStartMs: 65432, segs: [{ utf8: 'Test' }] },
    ];
    const result = parseCaptionEvents(events);
    assert.equal(result[0].start, 65.432);
  });

  it('returns empty array for empty events list', () => {
    assert.deepEqual(parseCaptionEvents([]), []);
  });

  it('returns empty array when events is undefined', () => {
    assert.deepEqual(parseCaptionEvents(undefined), []);
  });
});

// ---------------------------------------------------------------------------
// Discord fetcher helpers
// ---------------------------------------------------------------------------

describe('tsToSnowflake', () => {
  it('returns "0" for the Discord epoch timestamp', () => {
    assert.equal(tsToSnowflake(1420070400000), '0');
  });

  it('returns a larger snowflake for a later timestamp', () => {
    const earlier = BigInt(tsToSnowflake(1420070400000));
    const later   = BigInt(tsToSnowflake(1420070401000)); // 1 second later
    assert.ok(later > earlier, 'later timestamp should produce a larger snowflake');
  });
});

describe('filterMessages', () => {
  const afterTs  = new Date('2024-06-01T08:00:00Z').getTime();
  const beforeTs = new Date('2024-06-01T10:00:00Z').getTime();

  const messages = [
    { id: '1', timestamp: '2024-06-01T09:00:00.000Z' }, // inside window
    { id: '2', timestamp: '2024-06-01T07:59:59.000Z' }, // before window
    { id: '3', timestamp: '2024-06-01T10:00:00.000Z' }, // exactly at beforeTs — included
    { id: '4', timestamp: '2024-06-01T10:00:01.000Z' }, // after window
    { id: '5', timestamp: '2024-06-01T08:00:00.000Z' }, // exactly at afterTs — included
  ];

  it('keeps messages within the window and excludes those outside', () => {
    const result = filterMessages(messages, afterTs, beforeTs);
    const ids = result.map(m => m.id);
    assert.ok(ids.includes('1'), 'message inside window should be included');
    assert.ok(ids.includes('3'), 'message at beforeTs boundary should be included');
    assert.ok(ids.includes('5'), 'message at afterTs boundary should be included');
    assert.ok(!ids.includes('2'), 'message before window should be excluded');
    assert.ok(!ids.includes('4'), 'message after window should be excluded');
  });

  it('returns empty array for empty input', () => {
    assert.deepEqual(filterMessages([], afterTs, beforeTs), []);
  });
});

describe('extractImageUrls', () => {
  it('returns attachment URLs for image files (.png, .jpg)', () => {
    const message = {
      attachments: [
        { filename: 'chart.png', url: 'https://cdn.discordapp.com/chart.png' },
        { filename: 'setup.jpg', url: 'https://cdn.discordapp.com/setup.jpg' },
      ],
      embeds: [],
    };
    const urls = extractImageUrls(message);
    assert.ok(urls.includes('https://cdn.discordapp.com/chart.png'));
    assert.ok(urls.includes('https://cdn.discordapp.com/setup.jpg'));
    assert.equal(urls.length, 2);
  });

  it('skips non-image attachments (.pdf, .txt)', () => {
    const message = {
      attachments: [
        { filename: 'report.pdf', url: 'https://cdn.discordapp.com/report.pdf' },
        { filename: 'notes.txt',  url: 'https://cdn.discordapp.com/notes.txt' },
        { filename: 'image.webp', url: 'https://cdn.discordapp.com/image.webp' },
      ],
      embeds: [],
    };
    const urls = extractImageUrls(message);
    assert.ok(!urls.includes('https://cdn.discordapp.com/report.pdf'), '.pdf should be skipped');
    assert.ok(!urls.includes('https://cdn.discordapp.com/notes.txt'),  '.txt should be skipped');
    assert.ok(urls.includes('https://cdn.discordapp.com/image.webp'),  '.webp should be included');
    assert.equal(urls.length, 1);
  });

  it('returns embed image and thumbnail URLs', () => {
    const message = {
      attachments: [],
      embeds: [
        {
          image:     { url: 'https://example.com/embed-image.png' },
          thumbnail: { url: 'https://example.com/embed-thumb.jpg' },
        },
      ],
    };
    const urls = extractImageUrls(message);
    assert.ok(urls.includes('https://example.com/embed-image.png'));
    assert.ok(urls.includes('https://example.com/embed-thumb.jpg'));
    assert.equal(urls.length, 2);
  });

  it('returns empty array when there are no attachments or embeds', () => {
    const message = { attachments: [], embeds: [] };
    assert.deepEqual(extractImageUrls(message), []);
  });
});

// ---------------------------------------------------------------------------
// Brief synthesizer — buildContentBlocks
// ---------------------------------------------------------------------------

describe('buildContentBlocks', () => {
  it('with a transcript and no posts: returns at least 2 blocks, first is text with [0:00] timestamp', () => {
    const transcript = [
      { start: 0,  text: 'Welcome to the show' },
      { start: 65, text: 'Today we look at BTC' },
    ];
    const blocks = buildContentBlocks({
      videoId: 'abc123',
      videoTitle: 'Chart Hackers Daily',
      transcript,
      posts: [],
    });
    assert.ok(blocks.length >= 2, 'should have at least 2 blocks');
    assert.equal(blocks[0].type, 'text', 'first block should be text type');
    assert.ok(blocks[0].text.includes('[0:00]'), 'first block should contain [0:00] timestamp');
  });

  it('with no transcript: still returns blocks (empty transcript section)', () => {
    const blocks = buildContentBlocks({
      videoId: 'xyz',
      videoTitle: 'Empty Show',
      transcript: [],
      posts: [],
    });
    assert.ok(blocks.length >= 1, 'should still return at least one block');
    assert.equal(blocks[0].type, 'text');
  });

  it('with posts that have images: includes image blocks with type "image" and source.type "base64"', () => {
    const posts = [
      {
        author: 'Dylan',
        timestamp: '2026-06-01T08:00:00Z',
        content: 'BTC chart setup',
        images: [
          { base64: 'iVBORw0KGgo=', mediaType: 'image/png' },
        ],
      },
    ];
    const blocks = buildContentBlocks({
      videoId: 'v1',
      videoTitle: 'Test Show',
      transcript: [],
      posts,
    });
    const imageBlocks = blocks.filter(b => b.type === 'image');
    assert.ok(imageBlocks.length > 0, 'should have at least one image block');
    assert.equal(imageBlocks[0].source.type, 'base64');
    assert.equal(imageBlocks[0].source.media_type, 'image/png');
    assert.equal(imageBlocks[0].source.data, 'iVBORw0KGgo=');
  });

  it('with posts that have no images: no image blocks in output', () => {
    const posts = [
      {
        author: 'Dylan',
        timestamp: '2026-06-01T08:00:00Z',
        content: 'Text-only post',
        images: [],
      },
    ];
    const blocks = buildContentBlocks({
      videoId: 'v2',
      videoTitle: 'Test Show',
      transcript: [],
      posts,
    });
    const imageBlocks = blocks.filter(b => b.type === 'image');
    assert.equal(imageBlocks.length, 0, 'should have no image blocks');
  });

  it('formatTime behaviour: 0s → "0:00", 65s → "1:05", 3661s → "61:01" — verified via transcript block content', () => {
    const transcript = [
      { start: 0,    text: 'zero seconds' },
      { start: 65,   text: 'sixty five seconds' },
      { start: 3661, text: 'three thousand six sixty one seconds' },
    ];
    const blocks = buildContentBlocks({
      videoId: 'time-test',
      videoTitle: 'Timing Test',
      transcript,
      posts: [],
    });
    const transcriptText = blocks[0].text;
    assert.ok(transcriptText.includes('[0:00]'),  'should format 0 seconds as [0:00]');
    assert.ok(transcriptText.includes('[1:05]'),  'should format 65 seconds as [1:05]');
    assert.ok(transcriptText.includes('[61:01]'), 'should format 3661 seconds as [61:01]');
  });
});
