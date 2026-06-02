/**
 * YouTube transcript fetcher for brief generator.
 * Fetches the latest video from a channel RSS feed and retrieves its captions.
 *
 * Uses yt-dlp for transcript fetching (handles bot protection).
 * Falls back to native timedtext API if yt-dlp is unavailable.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * HTML-decode common XML/HTML entities in a string.
 * @param {string} str
 * @returns {string}
 */
function htmlDecode(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

/**
 * Parse a single RSS <entry> block and return { videoId, title, publishedAt }
 * or null if required fields are missing or date is invalid.
 * @param {string} entryXml
 * @returns {{videoId: string, title: string, publishedAt: Date}|null}
 */
export function parseRssEntry(entryXml) {
  const videoIdMatch = entryXml.match(/<yt:videoId>([^<]+)<\/yt:videoId>/);
  if (!videoIdMatch) return null;
  const videoId = videoIdMatch[1].trim();

  const titleMatch = entryXml.match(/<title>([^<]*)<\/title>/);
  if (!titleMatch) return null;
  const title = htmlDecode(titleMatch[1].trim());

  const pubMatch = entryXml.match(/<published>([^<]+)<\/published>/);
  if (!pubMatch) return null;
  const publishedAt = new Date(pubMatch[1].trim());
  if (isNaN(publishedAt.getTime())) return null;

  return { videoId, title, publishedAt };
}

/**
 * Filter a list of parsed entries to those within the given time window.
 * @param {Array<{videoId: string, title: string, publishedAt: Date}>} entries
 * @param {number} windowHours
 * @param {Date} [now] - injectable "now" for testing
 * @returns {Array<{videoId: string, title: string, publishedAt: Date}>}
 */
export function filterByWindow(entries, windowHours, now = new Date()) {
  const cutoff = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
  return entries.filter(e => e.publishedAt >= cutoff);
}

/**
 * Convert ytInitialPlayerResponse caption events into transcript segments.
 * @param {Array} events - captionJson.events
 * @returns {Array<{start: number, text: string}>}
 */
export function parseCaptionEvents(events) {
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

/**
 * Find the most recent video published within the given time window.
 *
 * @param {string} channelId - YouTube channel ID (e.g. "UCxxxxxx")
 * @param {number} [windowHours=36] - How many hours back to look
 * @returns {Promise<{videoId: string, title: string, publishedAt: Date}|null>}
 */
export async function findLatestVideo(channelId, windowHours = 36) {
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`RSS fetch failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();

  // Find all <entry> blocks and parse them
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  const entries = [];

  let match;
  while ((match = entryRe.exec(xml)) !== null) {
    const parsed = parseRssEntry(match[1]);
    if (parsed) entries.push(parsed);
  }

  // Filter to the time window and pick the most recent
  const recent = filterByWindow(entries, windowHours);
  if (recent.length === 0) return null;

  return recent.reduce((best, e) => (!best || e.publishedAt > best.publishedAt ? e : best), null);
}

/**
 * Fetch the transcript/captions for a YouTube video.
 *
 * @param {string} videoId
 * @returns {Promise<Array<{start: number, text: string}>>}
 */
/**
 * Find yt-dlp binary — checks PATH locations including pip user install.
 */
function findYtDlp() {
  const candidates = [
    'yt-dlp',
    `${process.env.HOME}/Library/Python/3.9/bin/yt-dlp`,
    `${process.env.HOME}/Library/Python/3.11/bin/yt-dlp`,
    `${process.env.HOME}/Library/Python/3.12/bin/yt-dlp`,
    `${process.env.HOME}/.local/bin/yt-dlp`,
    '/usr/local/bin/yt-dlp',
  ];
  for (const bin of candidates) {
    try { execFileSync(bin, ['--version'], { stdio: 'pipe' }); return bin; } catch {}
  }
  return null;
}

/**
 * Parse a WebVTT subtitle file into {start, text} segments.
 */
function parseVtt(vttText) {
  const segments = [];
  const blocks = vttText.split(/\n\n+/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    // Find the timestamp line: 00:00:00.000 --> 00:00:00.000
    const tsIdx = lines.findIndex(l => /\d+:\d+:\d+\.\d+\s+-->\s+\d+:\d+:\d+\.\d+/.test(l));
    if (tsIdx === -1) continue;
    const tsMatch = lines[tsIdx].match(/^(\d+):(\d+):(\d+\.\d+)/);
    if (!tsMatch) continue;
    const start = parseInt(tsMatch[1]) * 3600 + parseInt(tsMatch[2]) * 60 + parseFloat(tsMatch[3]);
    const text = lines.slice(tsIdx + 1).join(' ')
      .replace(/<[^>]+>/g, '') // strip HTML tags
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
      .trim();
    if (text) segments.push({ start, text });
  }
  return segments;
}

/**
 * Fetch transcript via yt-dlp (handles YouTube bot protection).
 */
function fetchTranscriptYtDlp(videoId, ytDlpBin) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'yt-transcript-'));
  try {
    execFileSync(ytDlpBin, [
      '--cookies-from-browser', 'chrome',
      '--write-auto-sub',
      '--sub-lang', 'en',
      '--sub-format', 'vtt',
      '--skip-download',
      '--output', join(tmpDir, '%(id)s'),
      `https://www.youtube.com/watch?v=${videoId}`,
    ], { stdio: 'pipe' });

    // Pick the English original (en.vtt), not translated variants (en-de.vtt etc.)
    const files = readdirSync(tmpDir).filter(f => /\.en\.vtt$|\.en-US\.vtt$/.test(f));
    if (files.length === 0) throw new Error('yt-dlp produced no English subtitle file');

    const vttText = readFileSync(join(tmpDir, files[0]), 'utf8');
    return parseVtt(vttText);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function fetchTranscript(videoId) {
  // Primary: yt-dlp (robust against YouTube bot protection)
  const ytDlpBin = findYtDlp();
  if (ytDlpBin) {
    return fetchTranscriptYtDlp(videoId, ytDlpBin);
  }

  // Fallback: native timedtext API
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const res = await fetch(watchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) throw new Error(`YouTube page fetch failed: ${res.status} ${res.statusText}`);

  const html = await res.text();
  const playerRe = /ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*(?:var\s+\w+|if\s*\())/s;
  const playerMatch = html.match(playerRe);
  if (!playerMatch) throw new Error(`Could not find ytInitialPlayerResponse in YouTube page for video ${videoId}`);

  let playerResponse;
  try { playerResponse = JSON.parse(playerMatch[1]); }
  catch (err) { throw new Error(`Failed to parse ytInitialPlayerResponse JSON: ${err.message}`); }

  const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!captionTracks || captionTracks.length === 0) {
    throw new Error(`No captions available for video ${videoId} — captions may not be published yet`);
  }

  const track =
    captionTracks.find(t => t.languageCode === 'en' && t.kind === 'asr') ??
    captionTracks.find(t => t.languageCode === 'en') ??
    captionTracks[0];

  if (!track.baseUrl) throw new Error(`Caption track for ${videoId} has no baseUrl`);

  const captionRes = await fetch(track.baseUrl + '&fmt=json3', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' },
  });
  if (!captionRes.ok) throw new Error(`Caption fetch failed: ${captionRes.status}`);

  const captionJson = await captionRes.json();
  return parseCaptionEvents(captionJson.events ?? []);
}
