/**
 * Core tab management logic.
 * Controls TradingView Desktop tabs via CDP and Electron keyboard shortcuts.
 */
import CDP from 'chrome-remote-interface';
import { getClient, evaluate, switchTarget, activateTarget } from '../connection.js';

const CDP_HOST = 'localhost';
const CDP_PORT = 9222;

/**
 * List all open chart tabs (CDP page targets).
 */
export async function list() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();

  const tabs = targets
    .filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url))
    .map((t, i) => ({
      index: i,
      id: t.id,
      title: t.title.replace(/^Live stock.*charts on /, ''),
      url: t.url,
      chart_id: t.url.match(/\/chart\/([^/?]+)/)?.[1] || null,
    }));

  return { success: true, tab_count: tabs.length, tabs };
}

/**
 * Open a new chart tab via keyboard shortcut (Ctrl+T / Cmd+T).
 */
export async function newTab() {
  const c = await getClient();

  // Electron/TradingView Desktop uses Ctrl+T for new tab on macOS too
  // But some versions use Cmd+T
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2; // 4 = meta (Cmd), 2 = ctrl

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 't',
    code: 'KeyT',
    windowsVirtualKeyCode: 84,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 't', code: 'KeyT' });

  await new Promise(r => setTimeout(r, 2000));

  // Verify a new tab appeared
  const state = await list();
  return { success: true, action: 'new_tab_opened', ...state };
}

/**
 * Close the current tab via keyboard shortcut (Ctrl+W / Cmd+W).
 */
export async function closeTab() {
  const before = await list();
  if (before.tab_count <= 1) {
    throw new Error('Cannot close the last tab. Use tv_launch to restart TradingView instead.');
  }

  const c = await getClient();
  const isMac = process.platform === 'darwin';
  const mod = isMac ? 4 : 2;

  await c.Input.dispatchKeyEvent({
    type: 'keyDown',
    modifiers: mod,
    key: 'w',
    code: 'KeyW',
    windowsVirtualKeyCode: 87,
  });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'w', code: 'KeyW' });

  await new Promise(r => setTimeout(r, 1000));

  const after = await list();
  return { success: true, action: 'tab_closed', tabs_before: before.tab_count, tabs_after: after.tab_count };
}

/**
 * Switch to a tab by index. Reconnects CDP to the new target.
 */
export async function switchTab({ index }) {
  const tabs = await list();
  const idx = Number(index);

  if (idx >= tabs.tab_count) {
    throw new Error(`Tab index ${idx} out of range (have ${tabs.tab_count} tabs)`);
  }

  const target = tabs.tabs[idx];

  try {
    await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/activate/${target.id}`);
    return { success: true, action: 'switched', index: idx, tab_id: target.id, chart_id: target.chart_id };
  } catch (e) {
    throw new Error(`Failed to activate tab ${idx}: ${e.message}`);
  }
}

const PANE_COUNT_EXPR = `
  (function() {
    try {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();
      return count || 1;
    } catch(e) { return 1; }
  })()
`;

/**
 * Switch to a tab by name. For "4-pane" style names, matches by pane count
 * since TradingView doesn't expose superchart names in page titles.
 * Opens a per-target CDP connection to read each tab's actual pane count.
 */
export async function switchTabByName({ name }) {
  const tabs = await list();
  const needle = name.toLowerCase();

  // Parse requested pane count from name (e.g. "4-pane" → 4)
  const paneMatch = needle.match(/^(\d+)[- ]pane/);
  const requestedPanes = paneMatch ? parseInt(paneMatch[1], 10) : null;

  let matchedTab = null;

  if (requestedPanes) {
    // Find by pane count — open a per-target CDP session for each tab
    for (const tab of tabs.tabs) {
      let c;
      try {
        c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: tab.id });
        await c.Runtime.enable();
        const r = await c.Runtime.evaluate({ expression: PANE_COUNT_EXPR, returnByValue: true });
        const panes = r.result?.value ?? 1;
        if (panes >= requestedPanes) {
          matchedTab = tab;
          break;
        }
      } catch { /* skip unreachable */ }
      finally { if (c) await c.close().catch(() => {}); }
    }
  } else {
    // Fall back to title match
    matchedTab = tabs.tabs.find(t => t.title.toLowerCase().includes(needle));
  }

  if (!matchedTab) {
    const desc = requestedPanes
      ? `No tab with ${requestedPanes}+ panes found`
      : `No tab matching "${name}"`;
    throw new Error(`${desc}. Open tabs: ${tabs.tabs.map(t => `"${t.title}"`).join(', ')}`);
  }

  // Activate visually and redirect all future CDP calls to this target
  await activateTarget(matchedTab.id);
  await switchTarget(matchedTab.id);

  return { success: true, action: 'switched', index: matchedTab.index, title: matchedTab.title, tab_id: matchedTab.id, chart_id: matchedTab.chart_id };
}
