/**
 * YouTube transcript fetcher for brief generator.
 * Fetches the latest video from a channel RSS feed and retrieves its captions.
 *
 * No npm dependencies — uses native fetch and Node built-ins only.
 */

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
export async function fetchTranscript(videoId) {
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;

  const res = await fetch(watchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
  });

  if (!res.ok) {
    throw new Error(`YouTube page fetch failed: ${res.status} ${res.statusText}`);
  }

  const html = await res.text();

  // Extract ytInitialPlayerResponse JSON
  const playerRe = /ytInitialPlayerResponse\s*=\s*(\{.+?\});(?:\s*(?:var\s+\w+|if\s*\())/s;
  const playerMatch = html.match(playerRe);
  if (!playerMatch) {
    throw new Error(`Could not find ytInitialPlayerResponse in YouTube page for video ${videoId}`);
  }

  let playerResponse;
  try {
    playerResponse = JSON.parse(playerMatch[1]);
  } catch (err) {
    throw new Error(`Failed to parse ytInitialPlayerResponse JSON: ${err.message}`);
  }

  // Navigate to caption tracks
  const captionTracks =
    playerResponse?.captions
      ?.playerCaptionsTracklistRenderer
      ?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error(`No captions available for video ${videoId} — captions may not be published yet`);
  }

  // Select track: prefer English ASR, then any English, then first available
  let track =
    captionTracks.find(t => t.languageCode === 'en' && t.kind === 'asr') ??
    captionTracks.find(t => t.languageCode === 'en') ??
    captionTracks[0];

  if (!track.baseUrl) throw new Error(`Caption track for ${videoId} has no baseUrl — malformed player response`);
  const captionUrl = track.baseUrl + '&fmt=json3';

  const captionRes = await fetch(captionUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });

  if (!captionRes.ok) {
    throw new Error(`Caption fetch failed: ${captionRes.status} ${captionRes.statusText}`);
  }

  const captionJson = await captionRes.json();

  // Parse caption events
  const segments = [];
  for (const event of (captionJson.events ?? [])) {
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
