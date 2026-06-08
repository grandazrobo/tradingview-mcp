import { register } from '../router.js';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { execFileSync } from 'child_process';
import { briefPath, feedPath, todayNZT } from '../../bridge/brief-parser.js';
import { findLatestVideo, fetchTranscript } from '../../bridge/youtube-fetcher.js';
import { fetchShowPosts } from '../../bridge/discord-fetcher.js';
import { synthesizeBrief } from '../../bridge/brief-synthesizer.js';

const SHOW_WINDOW_HOURS = 6;

async function fetchData(opts) {
  const ytChannelId = process.env.CHART_HACKERS_YT_CHANNEL_ID;
  const discordChannel = process.env.DISCORD_CHANNEL_LIVE_SHOW_CHARTS;

  // Step 1: Find YouTube video
  let video;
  if (opts['video-id']) {
    video = {
      videoId: opts['video-id'],
      title: `(manual: ${opts['video-id']})`,
      publishedAt: opts['published-at'] ? new Date(opts['published-at']) : new Date(),
    };
  } else {
    if (!ytChannelId) {
      throw new Error('CHART_HACKERS_YT_CHANNEL_ID not set — use --video-id to skip auto-detect');
    }
    console.error('  Searching YouTube channel for latest video...');
    video = await findLatestVideo(ytChannelId, 36);
    if (!video) {
      throw new Error('No video found in the last 36 hours — try again later or use --video-id');
    }
    console.error(`  Found: "${video.title}" (${video.videoId}) published ${video.publishedAt.toISOString()}`);
  }

  // Step 2: Fetch transcript
  let transcript = [];
  let transcriptError = null;
  try {
    console.error(`  Fetching transcript for ${video.videoId}...`);
    transcript = await fetchTranscript(video.videoId);
    console.error(`  Transcript: ${transcript.length} segments`);
  } catch (err) {
    transcriptError = err.message;
    console.error(`  Warning: transcript unavailable — ${err.message}`);
    transcript = [];
  }

  // Step 3: Fetch Discord posts
  let posts = [];
  if (discordChannel) {
    const windowStart = video.publishedAt.getTime() - SHOW_WINDOW_HOURS * 3600 * 1000;
    const windowEnd   = video.publishedAt.getTime() + SHOW_WINDOW_HOURS * 3600 * 1000;
    try {
      console.error(`  Fetching Discord posts from channel ${discordChannel}...`);
      posts = await fetchShowPosts(discordChannel, windowStart, windowEnd);
      console.error(`  Discord: ${posts.length} post(s) in window`);
    } catch (err) {
      console.error(`  Warning: Discord fetch failed — ${err.message}`);
      posts = [];
    }
  } else {
    console.error('  Warning: DISCORD_CHANNEL_LIVE_SHOW_CHARTS not set — skipping Discord');
  }

  return { video, transcript, posts, transcriptError };
}

async function handleFetch(opts) {
  const { video, transcript, posts } = await fetchData(opts);

  return {
    success: true,
    mode: 'fetch-only',
    date: opts.date ?? todayNZT(),
    video: {
      videoId: video.videoId,
      title: video.title,
      publishedAt: video.publishedAt,
    },
    transcript_segments: transcript.length,
    discord_posts: posts.map(p => ({
      author: p.author,
      timestamp: p.timestamp,
      content_preview: p.content.slice(0, 100),
      image_count: p.images.length,
    })),
  };
}

async function handleGenerate(opts) {
  const date = opts.date ?? todayNZT();
  const outPath = briefPath(date);

  // Check if brief already exists
  if (existsSync(outPath) && !opts.force) {
    return {
      success: false,
      date,
      error: `Brief already exists for ${date} at ${outPath} — use --force to overwrite`,
      path: outPath,
    };
  }

  const { video, transcript, posts, transcriptError } = await fetchData(opts);

  // Transcript fetch failed — signal retry so the watcher will try again later
  if (transcriptError && transcript.length === 0) {
    return {
      success: false,
      date,
      error: `Transcript not yet available — ${transcriptError}`,
      retry: true,
    };
  }

  // No data at all (transcript + Discord both empty)
  if (transcript.length === 0 && posts.length === 0) {
    return {
      success: false,
      date,
      error: 'No data available — try again later',
      retry: true,
    };
  }

  const showDatetime = video.publishedAt.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const durationSecs = transcript.length > 0 ? Math.ceil(transcript[transcript.length - 1].start) : 0;
  const generatedAt = (() => {
    const now = new Date();
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Pacific/Auckland',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false, timeZoneName: 'long',
    }).formatToParts(now);
    const get = t => parts.find(p => p.type === t)?.value;
    const tzName = get('timeZoneName')?.includes('Daylight') ? 'NZDT' : 'NZST';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${tzName}`;
  })();

  console.error('  Calling Claude API to synthesize brief...');
  const { briefText, feedText } = await synthesizeBrief({
    date,
    showDatetime,
    generatedAt,
    videoId: video.videoId,
    videoTitle: video.title,
    transcriptCount: transcript.length,
    durationSecs,
    transcript,
    posts,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, briefText);
  console.error(`  Brief written: ${outPath}`);

  if (feedText) {
    const fPath = feedPath(date);
    mkdirSync(dirname(fPath), { recursive: true });
    writeFileSync(fPath, feedText);
    console.error(`  Feed written:  ${fPath}`);
  }

  // Optionally run load-brief
  if (opts.execute) {
    console.error('  Running tv load-brief --execute --force...');
    try {
      execFileSync(process.argv[0], [process.argv[1], 'load-brief', '--execute', '--force'], {
        stdio: 'inherit',
      });
    } catch (err) {
      console.error(`  Warning: load-brief failed — ${err.message}`);
      return {
        success: true,
        date,
        path: outPath,
        transcript_segments: transcript.length,
        discord_posts: posts.length,
        execute_error: err.message,
      };
    }
  }

  return {
    success: true,
    date,
    path: outPath,
    transcript_segments: transcript.length,
    discord_posts: posts.length,
  };
}

register('brief', {
  description: 'Generate or fetch the Chart Hackers daily trading brief',
  subcommands: new Map([
    ['generate', {
      description: 'Full pipeline: fetch transcript + Discord posts, synthesize brief via Claude',
      options: {
        date:           { type: 'string',  description: 'Date to generate for (YYYY-MM-DD, default: today NZT)' },
        'video-id':     { type: 'string',  description: 'Skip auto-detect and use this YouTube video ID directly' },
        'published-at': { type: 'string',  description: 'ISO timestamp for Discord window when using --video-id (default: now)' },
        execute:        { type: 'boolean', description: 'After writing brief, run tv load-brief --execute --force' },
        force:          { type: 'boolean', description: 'Overwrite existing brief file' },
      },
      handler: handleGenerate,
    }],
    ['fetch', {
      description: 'Debug: show what would be fetched (no Claude call, no file write)',
      options: {
        date:       { type: 'string', description: 'Date context for logging (YYYY-MM-DD, default: today NZT)' },
        'video-id': { type: 'string', description: 'Skip auto-detect and use this YouTube video ID directly' },
      },
      handler: handleFetch,
    }],
  ]),
});
