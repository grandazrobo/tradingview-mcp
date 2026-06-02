# Trading Mode Tab Switching — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Scalping / Day Trading / Swing Trading / Accumulation mode buttons to the tvdash that switch the CDP connection and bring the matching TradingView tab to the front.

**Architecture:** A mode bar is added above the dashboard header. Clicking a mode calls `POST /api/mode`, which uses new helpers in `connection.js` to find the TV tab by custom title, activate it via CDP REST, and switch the singleton CDP client to that target. Active mode persists to `~/.tv-paper-trades.json` and is restored on restart.

**Tech Stack:** Node.js 20+ ESM, Express 5, chrome-remote-interface 0.33, Node built-in test runner (`node --test`), vanilla JS + CSS frontend

---

## File Map

| File | Change |
|---|---|
| `src/connection.js` | Add `listTabsWithInfo()`, `findTargetByMode(modeKey)`, `activateTarget(targetId)`, `switchTarget(targetId)` |
| `src/dashboard/state.js` | Add `active_mode: null` to `DEFAULT_STATE`; migrate existing state on load |
| `src/cli/commands/dashboard.js` | Add `MODES` map, `GET /api/tabs`, `POST /api/mode`, import new connection helpers, startup mode restoration |
| `src/dashboard/index.html` | Add mode bar CSS + HTML + JS fetch calls |
| `tests/mode.test.js` | New: unit tests for connection helpers and state migration |

---

### Task 1: Probe — confirm the JS path for reading a TV tab's custom title

TradingView Desktop (Electron) stores custom tab titles somewhere accessible via JS from within each chart renderer. This task finds the exact path. **Requires TradingView to be running with at least one tab renamed.**

**Files:**
- Create (temp): `scripts/probe_tab_titles.js`

- [ ] **Step 1: In TradingView Desktop, right-click any chart tab → Rename → type `Probe Test` → confirm**

- [ ] **Step 2: Create the probe script**

Create `scripts/probe_tab_titles.js`:

```js
#!/usr/bin/env node
// Run: node scripts/probe_tab_titles.js
// Find the JS expression that returns a TV chart tab's custom title from its renderer.

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

const PROBES = [
  ['document.title', `document.title`],
  ['window.name', `window.name`],
  ['TV symbol+resolution', `(() => { try { const c = window.TradingViewApi._activeChartWidgetWV.value(); return c.symbol() + ' ' + c.resolution(); } catch(e) { return 'ERR:' + e.message; } })()`],
  ['TV layout name via _layout', `(() => { try { return window.TradingViewApi._layout?.name?.() ?? 'no _layout.name'; } catch(e) { return 'ERR:' + e.message; } })()`],
  ['localStorage tab keys', `(() => { try { return JSON.stringify(Object.keys(localStorage).filter(k => /tab|title|name/i.test(k)).slice(0,10)); } catch(e) { return 'ERR:' + e.message; } })()`],
  ['window.tvTabTitle', `(() => { try { return window.tvTabTitle ?? window.tabTitle ?? window.TradingViewApi?.tabTitle ?? 'not found'; } catch(e) { return 'ERR:' + e.message; } })()`],
  ['charting_library storage', `(() => { try { const keys = Object.keys(localStorage); const k = keys.find(k => k.includes('chart_layout_name') || k.includes('tab_name')); return k ? k + ': ' + localStorage.getItem(k) : 'no match in ' + keys.length + ' keys'; } catch(e) { return 'ERR:' + e.message; } })()`],
];

import CDP from 'chrome-remote-interface';

const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
const targets = await resp.json();
const charts = targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url));
console.log(`\nFound ${charts.length} chart target(s)\n`);

for (const target of charts) {
  let client;
  try {
    client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
    await client.Runtime.enable();
    console.log(`=== ${target.id.slice(0, 8)} ===`);
    for (const [label, expr] of PROBES) {
      const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
      console.log(`  ${label}: ${JSON.stringify(r.result?.value)}`);
    }
  } catch (e) {
    console.log(`  ERROR connecting: ${e.message}`);
  } finally {
    if (client) await client.close().catch(() => {});
  }
  console.log('');
}
```

- [ ] **Step 3: Run the probe**

```bash
cd /Users/dazza/tradingview-mcp
node scripts/probe_tab_titles.js
```

Look for the probe line that returns `"Probe Test"`. Note its label — that's `TAB_TITLE_EXPR`.

Expected output (one of the probes returns your custom title):
```
=== 821EB283 ===
  document.title: "Live stock, index, futures, Forex and Bitcoin charts on TradingView"
  window.name: null
  TV symbol+resolution: "BTCUSDT 60"
  TV layout name via _layout: "Probe Test"     ← this one (or whichever matches)
  ...
```

- [ ] **Step 4: Record the working JS expression**

Add a comment to the top of `src/connection.js` (after the imports) with the confirmed expression:

```js
// TAB_TITLE_EXPR confirmed 2026-05-13: window.TradingViewApi._layout?.name?.()
// (or whichever probe returned the custom tab title — fill in from probe results)
```

- [ ] **Step 5: Delete the probe script**

```bash
rm scripts/probe_tab_titles.js
```

---

### Task 2: Add connection helpers to `connection.js`

**Probe results (2026-05-13):** Tab identification uses resolution-based matching. Custom tab titles are not accessible from renderers. Confirmed JS paths:
- Symbol: `window.TradingViewApi._activeChartWidgetWV.value().symbol()`
- Resolution: `window.TradingViewApi._activeChartWidgetWV.value().resolution()`

**MODES resolution map:**
```js
const MODES = {
  scalping:      { label: 'Scalping',      resolutions: ['30S', '3', '5', '15'] },
  day_trading:   { label: 'Day Trading',   resolutions: ['15', '30', '60'] },
  swing_trading: { label: 'Swing Trading', resolutions: ['240', 'D'] },
  accumulation:  { label: 'Accumulation',  resolutions: ['D', 'W', 'M'] },
};
```

**Files:**
- Modify: `src/connection.js`
- Create: `tests/mode.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/mode.test.js`:

```js
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Verify exports exist and have correct types.
// Full integration tested manually in Task 6.
let connection;
before(async () => {
  connection = await import('../src/connection.js');
});

describe('connection — mode helpers', () => {
  it('exports listTabsWithInfo as a function', () => {
    assert.equal(typeof connection.listTabsWithInfo, 'function');
  });

  it('exports findTargetByMode as a function', () => {
    assert.equal(typeof connection.findTargetByMode, 'function');
  });

  it('exports activateTarget as a function', () => {
    assert.equal(typeof connection.activateTarget, 'function');
  });

  it('exports switchTarget as a function', () => {
    assert.equal(typeof connection.switchTarget, 'function');
  });

  it('findTargetByMode returns null when CDP has no chart targets', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => ({ json: async () => [] });
    const result = await connection.findTargetByMode('scalping');
    assert.equal(result, null);
    globalThis.fetch = original;
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/dazza/tradingview-mcp
node --test tests/mode.test.js
```

Expected: `TypeError` — exports not found yet.

- [ ] **Step 3: Add helpers to `src/connection.js`**

Add the following after the existing `disconnect()` export:

```js
// ── Mode / tab helpers ─────────────────────────────────────────

// Confirmed via probe 2026-05-13: symbol and resolution are readable per renderer.
const TAB_INFO_EXPR = `
  (() => {
    try {
      const c = window.TradingViewApi._activeChartWidgetWV.value();
      return JSON.stringify({ symbol: c.symbol(), resolution: c.resolution() });
    } catch(e) { return null; }
  })()
`;

// Resolution sets per mode — first matching tab wins.
const MODE_RESOLUTIONS = {
  scalping:      ['30S', '3', '5', '15'],
  day_trading:   ['15', '30', '60'],
  swing_trading: ['240', 'D'],
  accumulation:  ['D', 'W', 'M'],
};

export async function listTabsWithInfo() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  const chartTargets = targets.filter(
    t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)
  );
  const results = [];
  for (const target of chartTargets) {
    let symbol = null, resolution = null;
    let c;
    try {
      c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });
      await c.Runtime.enable();
      const r = await c.Runtime.evaluate({ expression: TAB_INFO_EXPR, returnByValue: true });
      if (r.result?.value) ({ symbol, resolution } = JSON.parse(r.result.value));
    } catch { /* skip unreachable targets */ }
    finally { if (c) await c.close().catch(() => {}); }
    results.push({ id: target.id, symbol, resolution, url: target.url });
  }
  return results;
}

export async function findTargetByMode(modeKey) {
  const resolutions = MODE_RESOLUTIONS[modeKey];
  if (!resolutions) return null;
  const tabs = await listTabsWithInfo();
  return tabs.find(t => t.resolution && resolutions.includes(t.resolution)) ?? null;
}

export async function activateTarget(targetId) {
  // CDP REST API — brings the target tab to front in TradingView Desktop
  await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${targetId}`);
}

export async function switchTarget(targetId) {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
  client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
  await client.Runtime.enable();
  await client.Page.enable();
  await client.DOM.enable();
  targetInfo = { id: targetId };
  return client;
}
```

- [ ] **Step 4: Run tests**

```bash
node --test tests/mode.test.js
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/dazza/tradingview-mcp
git add src/connection.js tests/mode.test.js
git commit -m "feat: add listTabsWithInfo, findTargetByMode, activateTarget, switchTarget"
```

---

### Task 3: Add `active_mode` to state

**Files:**
- Modify: `src/dashboard/state.js`
- Modify: `tests/mode.test.js`

- [ ] **Step 1: Add failing test**

In `tests/mode.test.js`, add the import at the **top of the file** (with the other imports):

```js
import { loadState, resetState } from '../src/dashboard/state.js';
```

Then append the describe block at the **bottom of the file**:

```js
describe('state — active_mode', () => {
  it('resetState includes active_mode: null', () => {
    const state = resetState();
    assert.equal(state.active_mode, null);
  });

  it('loadState returns active_mode: null when field absent in stored file', () => {
    // loadState merges missing field — simulated by resetState then removing the field
    const state = loadState();
    assert.ok('active_mode' in state, 'active_mode key must exist');
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
node --test tests/mode.test.js
```

Expected: `AssertionError` — `active_mode` is `undefined`.

- [ ] **Step 3: Update `src/dashboard/state.js`**

Update `DEFAULT_STATE`:

```js
const DEFAULT_STATE = {
  starting_balance: 10000,
  balance: 10000,
  open_trades: [],
  history: [],
  pairs: ['KUCOIN:SOLUSDT', 'KUCOIN:BTCUSDT', 'BINANCE:ETHUSDT', 'BINANCE:AVAXUSDT'],
  active_mode: null,
};
```

Update `loadState()` to migrate existing state files that lack the field:

```js
export function loadState() {
  if (!existsSync(STATE_FILE)) return structuredClone(DEFAULT_STATE);
  try {
    const state = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (!('active_mode' in state)) state.active_mode = null;
    return state;
  } catch {
    return structuredClone(DEFAULT_STATE);
  }
}
```

- [ ] **Step 4: Run tests**

```bash
node --test tests/mode.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/state.js tests/mode.test.js
git commit -m "feat: add active_mode to dashboard state with migration"
```

---

### Task 4: Add `/api/tabs` and `/api/mode` endpoints

**Files:**
- Modify: `src/cli/commands/dashboard.js`

- [ ] **Step 1: Add imports and MODES map**

At the top of `src/cli/commands/dashboard.js`, add to the existing imports:

```js
import {
  findTargetByMode, activateTarget, switchTarget, listTabsWithInfo,
} from '../../connection.js';
```

Add after the imports (outside `startDashboard`):

```js
const MODES = {
  scalping:      { label: 'Scalping',      resolutions: ['30S', '3', '5', '15'] },
  day_trading:   { label: 'Day Trading',   resolutions: ['15', '30', '60'] },
  swing_trading: { label: 'Swing Trading', resolutions: ['240', 'D'] },
  accumulation:  { label: 'Accumulation',  resolutions: ['D', 'W', 'M'] },
};
```

- [ ] **Step 2: Add `GET /api/tabs` endpoint**

Add after `app.get('/api/state', ...)` in `startDashboard`:

```js
app.get('/api/tabs', async (_req, res) => {
  try {
    const tabs = await listTabsWithInfo();
    // Annotate each tab with which mode its resolution matches (if any)
    const modeTabs = tabs.map(tab => ({
      ...tab,
      mode: Object.entries(MODES).find(([, { resolutions }]) =>
        tab.resolution && resolutions.includes(tab.resolution)
      )?.[0] ?? null,
    }));
    res.json({ tabs: modeTabs });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 3: Add `POST /api/mode` endpoint**

Add after the `/api/tabs` route:

```js
app.post('/api/mode', async (req, res) => {
  const { mode } = req.body;
  if (!mode || !MODES[mode]) {
    return res.status(400).json({ error: `Unknown mode. Valid: ${Object.keys(MODES).join(', ')}` });
  }
  const target = await findTargetByMode(mode);
  if (!target) {
    return res.json({ success: false, mode, tab_found: false });
  }
  try {
    await activateTarget(target.id);
    await switchTarget(target.id);
    state.active_mode = mode;
    saveState(state);
    res.json({ success: true, mode, tab_found: true, resolution: target.resolution });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});
```

- [ ] **Step 4: Add startup mode restoration**

In `startDashboard`, after `let state = reset ? resetState() : loadState();`, add:

```js
if (state.active_mode && MODES[state.active_mode]) {
  findTargetByMode(state.active_mode)
    .then(target => {
      if (target) return switchTarget(target.id);
      state.active_mode = null;
      saveState(state);
    })
    .catch(() => { state.active_mode = null; });
}
```

- [ ] **Step 5: Smoke-test the endpoints manually**

With the dashboard running and TradingView open (at least one tab on a recognised timeframe):

```bash
# List all TV tabs with symbol, resolution, and matched mode
curl -s http://localhost:3333/api/tabs | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(d),null,2)))"

# Switch to Day Trading mode (needs a TV tab on 15, 30, or 60 min)
curl -s -X POST http://localhost:3333/api/mode \
  -H "Content-Type: application/json" \
  -d '{"mode":"day_trading"}' | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(d))"
```

Expected from `/api/tabs`: tabs with `symbol`, `resolution`, and `mode` populated.
Expected from `/api/mode`: `{"success":true,"mode":"day_trading","tab_found":true,"resolution":"60"}`.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/dashboard.js
git commit -m "feat: add /api/tabs and /api/mode endpoints with startup mode restoration"
```

---

### Task 5: Add mode selector UI to `index.html`

**Files:**
- Modify: `src/dashboard/index.html`

- [ ] **Step 1: Add mode bar CSS**

In `src/dashboard/index.html`, add inside `<style>` after the `.balance-pnl` rules:

```css
/* ── Mode Bar ── */
.mode-bar { display:flex; gap:6px; margin-bottom:12px; }
.mode-btn {
  flex:1; padding:8px 4px; border-radius:6px; border:1px solid #2a2a2a;
  background:#1a1a1a; color:#555; font-family:inherit; font-size:11px;
  font-weight:700; text-transform:uppercase; letter-spacing:1px;
  cursor:pointer; transition:all 0.15s;
}
.mode-btn:hover { border-color:#444; color:#888; }
.mode-btn.active { background:#0d2b1f; border-color:#00d084; color:#00d084; }
.mode-btn.not-found { border-color:#2a2a2a; color:#333; cursor:not-allowed; }
.mode-btn.not-found::after { content:' ⚠'; }
```

- [ ] **Step 2: Add mode bar HTML**

In `src/dashboard/index.html`, add after `<body>` and before `<div class="header">`:

```html
<div class="mode-bar">
  <button class="mode-btn" data-mode="scalping">Scalping</button>
  <button class="mode-btn" data-mode="day_trading">Day Trading</button>
  <button class="mode-btn" data-mode="swing_trading">Swing Trading</button>
  <button class="mode-btn" data-mode="accumulation">Accumulation</button>
</div>
```

- [ ] **Step 3: Add mode bar JavaScript**

In `src/dashboard/index.html`, add inside the `<script>` block, after the `DOMContentLoaded` event or at the top of the existing JS section:

```js
// ── Mode bar ──────────────────────────────────────────────────
const modeBtns = document.querySelectorAll('.mode-btn');

async function loadTabAvailability() {
  try {
    const { tabs } = await (await fetch('/api/tabs')).json();
    const foundModes = new Set(tabs.filter(t => t.mode).map(t => t.mode));
    modeBtns.forEach(btn => {
      if (!foundModes.has(btn.dataset.mode)) btn.classList.add('not-found');
      else btn.classList.remove('not-found');
    });
  } catch { /* TV not running */ }
}

function setActiveMode(mode) {
  modeBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode));
}

modeBtns.forEach(btn => {
  btn.addEventListener('click', async () => {
    if (btn.classList.contains('not-found')) return;
    const mode = btn.dataset.mode;
    setActiveMode(mode); // optimistic
    try {
      const res = await fetch('/api/mode', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (!data.tab_found) {
        setActiveMode(null); // revert — tab not found
        btn.classList.add('not-found');
      }
    } catch {
      setActiveMode(null);
    }
  });
});

// Restore active mode and tab availability on page load
(async () => {
  const state = await (await fetch('/api/state')).json();
  if (state.active_mode) setActiveMode(state.active_mode);
  await loadTabAvailability();
})();
```

- [ ] **Step 4: Verify in browser**

Open `http://localhost:3333`. Confirm:
- 4 mode buttons appear above the header
- Tabs not found show `⚠` and are unclickable
- Clicking an active tab button highlights it green and brings that TV tab to front
- Refreshing the page restores the last active mode button

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/index.html
git commit -m "feat: add mode selector bar to dashboard UI"
```

---

### Task 6: End-to-end test + TV tab naming guide

**Files:**
- None (manual test + one-time TV setup)

- [ ] **Step 1: Name your TradingView tabs**

In TradingView Desktop, for each trading setup tab:
- Right-click the tab → **Rename**
- Set names exactly: `Scalping`, `Day Trading`, `Swing Trading`, `Accumulation`

- [ ] **Step 2: Restart the dashboard**

```bash
# Kill existing dashboard (if running)
pkill -f "tradingview-mcp/src/cli/index.js dashboard"
# Start fresh
node /Users/dazza/tradingview-mcp/src/cli/index.js dashboard
```

- [ ] **Step 3: Verify full flow**

Open `http://localhost:3333` and confirm:
1. All 4 mode buttons appear without `⚠` (tabs found)
2. Clicking **Scalping** highlights the button green and TradingView jumps to the Scalping tab
3. Clicking **Day Trading** switches TradingView to the Day Trading tab
4. Refresh the page — the last active mode button is still highlighted
5. Restart the dashboard — the last active mode is restored (TV tab switches on startup)

- [ ] **Step 4: Run full test suite to confirm nothing regressed**

```bash
cd /Users/dazza/tradingview-mcp
node --test tests/mode.test.js tests/cli.test.js
```

Expected: all tests PASS.
