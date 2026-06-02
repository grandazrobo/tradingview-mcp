# Trading Mode Tab Switching — Design Spec

**Date:** 2026-05-13
**Status:** Approved
**Project:** tradingview-mcp / tvdash

---

## Overview

Add a mode layer to the tvdash paper trading dashboard. Each mode (Scalping, Day Trading, Swing Trading, Accumulation) maps to a dedicated TradingView Desktop tab identified by its custom title. Selecting a mode brings that TV tab to the front and targets it for all subsequent chart operations.

This is a stepping stone toward the trading bot, where each mode will eventually have its own analysis pipeline and rules engine.

---

## Architecture

A mode selector sits on top of the existing dashboard. Selecting a mode does three things:

1. Finds the matching TV tab by querying CDP and injecting JS to read each tab's custom title
2. Brings that tab to front via `Target.activateTarget`
3. Switches the CDP connection so all chart operations (symbol changes, data reads) target that tab

Trade tracking, P&L, Discord notifications, and price polling are mode-agnostic and unchanged.

---

## Mode Definitions

| Mode key | Display name | Expected TV tab title |
|---|---|---|
| `scalping` | Scalping | "Scalping" |
| `day_trading` | Day Trading | "Day Trading" |
| `swing_trading` | Swing Trading | "Swing Trading" |
| `accumulation` | Accumulation | "Accumulation" |

User sets custom tab titles in TradingView Desktop once. The dashboard matches by exact title string.

---

## Section 1 — Connection Changes (`connection.js`)

### `findTargetByTitle(title)`

- Queries `http://localhost:9222/json/list` for all targets
- Filters to TV chart pages (`type === 'page'` and URL matches `tradingview.com/chart`)
- Injects a JS snippet into each renderer to read the custom tab title
- Returns the first target whose title matches (case-insensitive)
- Returns `null` if no match found
- **Note:** The exact JS path to read the TV custom tab title will be probed and confirmed during build. Likely candidates: `document.title`, a TradingView app-level API, or the tab's renderer state.

### `switchTarget(targetId)`

- Disconnects the current CDP `client`
- Reconnects via `CDP({ host, port, target: targetId })`
- Re-enables required domains (Runtime, Page, DOM)
- Updates the singleton `client` and `targetInfo`
- Subsequent `evaluate()` calls use the new target automatically

The existing `findChartTarget()` is unchanged — used as the default when no mode is active.

---

## Section 2 — New API Endpoints

### `GET /api/tabs`

Returns all discoverable TV chart targets with their resolved titles and IDs. Uses the same JS injection as `findTargetByTitle` to read each tab's custom title. Used by the UI on load to show tab availability per mode.

```json
{
  "tabs": [
    { "id": "821EB2...", "title": "Scalping", "url": "https://..." },
    { "id": "11B996...", "title": "Day Trading", "url": "https://..." }
  ]
}
```

### `POST /api/mode`

Body: `{ "mode": "scalping" }`

1. Looks up expected tab title for the mode
2. Calls `findTargetByTitle(title)`
3. If found: calls `Target.activateTarget`, calls `switchTarget(id)`, saves `active_mode` to state
4. If not found: returns `{ success: false, tab_found: false }` — does not crash

Response:
```json
{ "success": true, "mode": "scalping", "tab_found": true }
```

---

## Section 3 — State Changes (`state.js`)

Add one field:

```js
active_mode: null  // "scalping" | "day_trading" | "swing_trading" | "accumulation" | null
```

- Persisted to `state.json`
- Restored on dashboard restart
- If the stored mode's tab cannot be found on startup, `active_mode` resets to `null` silently

---

## Section 4 — Dashboard UI (`index.html`)

### Mode selector bar

Four buttons added across the top of the dashboard, above existing content:

- **Labels:** Scalping · Day Trading · Swing Trading · Accumulation
- **Active state:** highlighted with colored border matching existing dashboard palette
- **Tab not found:** muted/disabled appearance with small warning indicator — dashboard remains fully functional
- **On click:** `POST /api/mode`, updates active button state on success

### Behaviour

- Active mode button updates immediately on click (optimistic UI), reverts if API returns `tab_found: false`
- Mode state persists across page refreshes via `/api/state`
- No other layout changes — trades, P&L, scorecard, coin selector unchanged

---

## Error Handling

| Scenario | Behaviour |
|---|---|
| TV tab not open / not named correctly | `POST /api/mode` returns `tab_found: false`, button shows warning, no crash |
| TV not running | Falls back to existing CDP error handling |
| Mode active_mode in state but tab gone on restart | Resets to `null` silently |
| switchTarget fails | Logs error, retains previous connection |

---

## Out of Scope

- Per-mode trade tracking (trades remain global)
- Per-mode rules or AI analysis (trading bot phase)
- Automatically naming or creating TV tabs
- Syncing the TV tab's current coin back to the dashboard
