/**
 * Discord channel fetcher for the brief generator.
 * Reads messages from a Discord channel within a time window and downloads image attachments.
 *
 * No new npm dependencies — uses native fetch (Node 18+).
 */

const BASE = 'https://discord.com/api/v10';
const DISCORD_EPOCH = 1420070400000n;

// ---------------------------------------------------------------------------
// Pure helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Convert a Unix millisecond timestamp to a Discord snowflake string.
 * Formula: (tsMs - discordEpoch) << 22
 *
 * @param {number} tsMs  Unix timestamp in milliseconds
 * @returns {string}     Discord snowflake string
 */
export function tsToSnowflake(tsMs) {
  return String((BigInt(Math.floor(tsMs)) - DISCORD_EPOCH) << 22n);
}

/**
 * Filter raw Discord message objects to those within [afterTs, beforeTs].
 *
 * @param {Array<object>} messages  Raw Discord message objects (must have .timestamp ISO string)
 * @param {number}        afterTs   Start of window — Unix ms (inclusive)
 * @param {number}        beforeTs  End of window — Unix ms (inclusive)
 * @returns {Array<object>}
 */
export function filterMessages(messages, afterTs, beforeTs) {
  if (!messages || messages.length === 0) return [];
  return messages.filter(msg => {
    const t = new Date(msg.timestamp).getTime();
    return t >= afterTs && t <= beforeTs;
  });
}

/**
 * Extract image URLs from a message's attachments and embeds.
 *
 * @param {object} message  Raw Discord message object
 * @returns {string[]}      Array of image URL strings
 */
export function extractImageUrls(message) {
  const urls = [];
  const imageExt = /\.(png|jpg|jpeg|gif|webp)$/i;

  // Attachments
  for (const attachment of message.attachments ?? []) {
    if (attachment.filename && imageExt.test(attachment.filename)) {
      urls.push(attachment.url);
    }
  }

  // Embeds
  for (const embed of message.embeds ?? []) {
    if (embed.image?.url) urls.push(embed.image.url);
    if (embed.thumbnail?.url) urls.push(embed.thumbnail.url);
  }

  return urls;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function downloadImageAsBase64(url) {
  const res = await fetch(url);
  if (!res.ok) return null;
  const contentType = res.headers.get('content-type') ?? 'image/png';
  const mediaType = contentType.split(';')[0].trim();
  const arrayBuffer = await res.arrayBuffer();
  const base64 = Buffer.from(arrayBuffer).toString('base64');
  return { url, base64, mediaType };
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Fetch Discord messages from a channel within a time window,
 * downloading any image attachments/embeds.
 *
 * @param {string} channelId  Discord channel ID
 * @param {number} afterTs    Start of window — Unix ms (inclusive)
 * @param {number} beforeTs   End of window — Unix ms (inclusive)
 * @returns {Promise<Array<{id, author, content, timestamp, images}>>}
 */
export async function fetchShowPosts(channelId, afterTs, beforeTs) {
  const botToken  = process.env.DISCORD_BOT_TOKEN;
  const userToken = process.env.DISCORD_USER_TOKEN;
  if (!botToken && !userToken) throw new Error('Neither DISCORD_BOT_TOKEN nor DISCORD_USER_TOKEN is set');
  if (!channelId) throw new Error('channelId required — set DISCORD_CHANNEL_LIVE_SHOW_CHARTS');

  // User token takes priority (works on channels where bot lacks access)
  const headers = userToken
    ? { Authorization: userToken }
    : { Authorization: `Bot ${botToken}` };

  const collected = [];
  let beforeSnowflake = tsToSnowflake(beforeTs + 1); // start just after the window end
  let reachedBefore = false;

  while (!reachedBefore) {
    const url = `${BASE}/channels/${channelId}/messages?limit=100&before=${beforeSnowflake}`;
    const res = await fetch(url, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Discord API error ${res.status}: ${body}`);
    }

    const page = await res.json();

    if (!page || page.length === 0) break;

    for (const msg of page) {
      const t = new Date(msg.timestamp).getTime();
      if (t < afterTs) {
        reachedBefore = true;
        break;
      }
      if (t <= beforeTs) {
        collected.push(msg);
      }
    }

    if (!reachedBefore) {
      // Paginate: use the ID of the oldest message in this page as the next `before`
      beforeSnowflake = page[page.length - 1].id;
      await sleep(100);
    }
  }

  // Build output — download images for each message in window
  const results = [];
  for (const msg of collected) {
    const imageUrls = extractImageUrls(msg);
    const images = [];
    for (const imgUrl of imageUrls) {
      try {
        const img = await downloadImageAsBase64(imgUrl);
        if (img) images.push(img);
      } catch {
        // skip failed image downloads
      }
    }

    results.push({
      id: msg.id,
      author: msg.author?.username ?? 'unknown',
      content: msg.content ?? '',
      timestamp: msg.timestamp,
      images,
    });
  }

  return results;
}
