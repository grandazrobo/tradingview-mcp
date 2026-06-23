#!/bin/zsh
# chart-hackers-watcher.sh
# Scheduled daily runner — starts tvdash, runs tv brief generate --execute (fetch + synthesize + load)
# Retries every 30 minutes (up to 8 times = 4 hours) if the transcript isn't available yet.

LOG="$HOME/Library/Logs/chart-hackers-watcher.log"
NODE="$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node | tail -1)/bin/node"
TV_CLI="$HOME/tradingview-mcp/src/cli/index.js"

RETRY_INTERVAL=1800   # 30 minutes
MAX_RETRIES=8         # give up after 4 hours total

# Load env vars (launchd doesn't source ~/.zshenv)
[ -f "$HOME/.zshenv" ] && source "$HOME/.zshenv"

log() {
  echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"
}

export CHART_HACKERS_YT_CHANNEL_ID="${CHART_HACKERS_YT_CHANNEL_ID:-}"
export DISCORD_CHANNEL_LIVE_SHOW_CHARTS="${DISCORD_CHANNEL_LIVE_SHOW_CHARTS:-}"
export DISCORD_BOT_TOKEN="${DISCORD_BOT_TOKEN:-}"
export DISCORD_USER_TOKEN="${DISCORD_USER_TOKEN:-}"
export ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"

log "=== Daily chart-hackers run starting ==="

# Start tvdash in background if not already running
if ! curl -s http://localhost:3333/health > /dev/null 2>&1; then
  log "Starting tvdash..."
  "$NODE" "$TV_CLI" dashboard >> "$LOG" 2>&1 &
  TVDASH_PID=$!
  sleep 6
  log "TVDash started (PID $TVDASH_PID)"
else
  log "TVDash already running"
  TVDASH_PID=""
fi

# Run brief generate with retry loop
ATTEMPT=0
FORCE_FLAG=""
while [ $ATTEMPT -lt $MAX_RETRIES ]; do
  ATTEMPT=$((ATTEMPT + 1))
  log "Running tv brief generate --execute${FORCE_FLAG:+ --force} (attempt $ATTEMPT/$MAX_RETRIES)..."

  # Capture JSON output (stdout) separately from progress logs (stderr → log file)
  OUTPUT=$("$NODE" "$TV_CLI" brief generate --execute $FORCE_FLAG 2>> "$LOG")
  EXIT_CODE=$?
  echo "$OUTPUT" >> "$LOG"

  # Transcript not yet available — wait and retry
  if echo "$OUTPUT" | grep -q '"retry"[[:space:]]*:[[:space:]]*true'; then
    if [ $ATTEMPT -lt $MAX_RETRIES ]; then
      log "Transcript not yet available — waiting 30 minutes before retry..."
      sleep $RETRY_INTERVAL
      continue
    else
      log "Transcript still unavailable after $MAX_RETRIES attempts — giving up"
    fi
  fi

  # Brief was written by another process (possibly without transcript) — force regenerate
  if echo "$OUTPUT" | grep -q '"Brief already exists'; then
    if [ $ATTEMPT -lt $MAX_RETRIES ]; then
      log "Brief exists but may lack transcript — waiting 30 minutes then forcing regenerate..."
      sleep $RETRY_INTERVAL
      FORCE_FLAG="--force"
      continue
    else
      log "Brief exists and retries exhausted — giving up"
    fi
  fi

  log "brief generate finished (exit $EXIT_CODE)"
  break
done

log "=== Done ==="
