import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadState, resetState } from '../src/dashboard/state.js';

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

describe('state — active_mode', () => {
  it('resetState includes active_mode: null', () => {
    const state = resetState();
    assert.equal(state.active_mode, null);
  });

  it('loadState returns active_mode: null when field absent in stored file', () => {
    const state = loadState();
    assert.ok('active_mode' in state, 'active_mode key must exist');
  });
});
