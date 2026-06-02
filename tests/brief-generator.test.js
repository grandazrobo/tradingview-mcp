/**
 * Unit tests for YouTube transcript fetcher parsing logic.
 * No real network calls — tests parsing functions only.
 *
 * Run: node --test tests/brief-generator.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Inline helpers that mirror the logic in youtube-fetcher.js so we can test
// them in isolation without making any network calls.
// ---------------------------------------------------------------------------

function htmlDecode(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Parse a single RSS <entry> block and return { videoId, title, publishedAt }
 * or null if required fields are missing.
 */
function parseRssEntry(entryXml) {
  const videoIdMatch = entryXml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
  if (!videoIdMatch) return null;
  const videoId = videoIdMatch[1].trim();

  const titleMatch = entryXml.match(/<title>([^<]*)<\/title>/);
  if (!titleMatch) return null;
  const title = htmlDecode(titleMatch[1].trim());

  const pubMatch = entryXml.match(/<published>([^<]+)<\/published>/);
  if (!pubMatch) return null;
  const publishedAt = new Date(pubMatch[1].trim());

  return { videoId, title, publishedAt };
}

/**
 * Filter a list of parsed entries to those within the given window.
 * @param {Array<{videoId, title, publishedAt}>} entries
 * @param {number} windowHours
 * @param {Date} [now] - injectable "now" for testing
 */
function filterByWindow(entries, windowHours, now = new Date()) {
  const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  return entries.filter(e => e.publishedAt >= cutoff);
}

/**
 * Convert ytInitialPlayerResponse caption events into transcript segments.
 * @param {Array} events - captionJson.events
 * @returns {Array<{start: number, text: string}>}
 */
function parseCaptionEvents(events) {
  const segments = [];
  for (const event of (events ?? [])) {
    if (!event.segs || event.segs.length === 0) continue;

    const text = event.segs
      .map(seg => (seg.utf8 ?? '').replace(/\n/g, ' '))
      .join('')
      .trim();

    if (!text) continue;

    segments.push({
      start: (event.tStartMs ?? 0) / 1000,
      text,
    });
  }
  return segments;
}

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
