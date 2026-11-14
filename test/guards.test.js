import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageDecision, loadThresholds, promptDecision, shotDecision } from '../plugin/lib/guards.mjs';

const th = { ctxWarn: [150000, 300000], idleMinutes: 5, idleMinCtx: 100000, imageMaxKB: 500, screenshotWarnEvery: 30, disable: [] };
const MIN = 60_000;

test('loadThresholds returns defaults, merges a valid override and ignores wrong types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-th-'));
  assert.deepEqual(loadThresholds(dir), th);
  writeFileSync(join(dir, 'claude-lean.json'), JSON.stringify({ idleMinutes: 60, imageMaxKB: 'big', unknown: 1, disable: ['image'] }));
  const t = loadThresholds(dir);
  assert.equal(t.idleMinutes, 60);
  assert.equal(t.imageMaxKB, 500, 'wrong type ignored');
  assert.deepEqual(t.disable, ['image']);
  assert.equal(t.unknown, undefined);
  writeFileSync(join(dir, 'claude-lean.json'), '{ nope');
  assert.deepEqual(loadThresholds(dir), th, 'broken override falls back to defaults');
});

test('context watchdog warns once per level and resets when context shrinks', () => {
  let d = promptDecision({ ctx: 100e3, gapMs: 1000, level: 0, th });
  assert.equal(d.message, null);
  assert.equal(d.level, 0);
  d = promptDecision({ ctx: 160e3, gapMs: 1000, level: 0, th });
  assert.match(d.message, /context is 160k tokens.*\/compact/);
  assert.equal(d.level, 1);
  d = promptDecision({ ctx: 170e3, gapMs: 1000, level: 1, th });
  assert.equal(d.message, null, 'same level is not repeated');
  d = promptDecision({ ctx: 320e3, gapMs: 1000, level: 1, th });
  assert.match(d.message, /context is 320k tokens.*\/clear/);
  assert.equal(d.level, 2);
  d = promptDecision({ ctx: 20e3, gapMs: 1000, level: 2, th });
  assert.equal(d.message, null);
  assert.equal(d.level, 0, 'level resets after /clear or /compact');
});

test('idle guard needs a long gap AND a big context, and wins over the context warning', () => {
  assert.match(promptDecision({ ctx: 200e3, gapMs: 12 * MIN, level: 1, th }).message, /idle for 12 min.*200k/);
  assert.equal(promptDecision({ ctx: 50e3, gapMs: 12 * MIN, level: 0, th }).message, null);
  assert.equal(promptDecision({ ctx: 200e3, gapMs: 2 * MIN, level: 1, th }).message, null);
  assert.equal(promptDecision({ ctx: 200e3, gapMs: null, level: 1, th }).message, null);
  const both = promptDecision({ ctx: 320e3, gapMs: 12 * MIN, level: 0, th });
  assert.match(both.message, /idle/);
  assert.equal(both.level, 2, 'level still advances so the next prompt does not repeat it');
});

test('disabled guards stay silent and every message is a single line', () => {
  assert.equal(promptDecision({ ctx: 320e3, gapMs: 12 * MIN, level: 0, th: { ...th, disable: ['idle', 'context'] } }).message, null);
  for (const [ctx, gapMs, level] of [[160e3, 1, 0], [320e3, 1, 1], [200e3, 12 * MIN, 1]]) {
    assert.doesNotMatch(promptDecision({ ctx, gapMs, level, th }).message, /\n/);
  }
});

test('imageDecision blocks big images only', () => {
  const big = () => 2_400_000;
  const small = () => 100_000;
  assert.match(imageDecision({ path: '/x/a.PNG', th, sizeOf: big }), /image is 2344 KB \(limit 500 KB\)/);
  assert.equal(imageDecision({ path: '/x/a.png', th, sizeOf: small }), null);
  assert.equal(imageDecision({ path: '/x/notes.txt', th, sizeOf: big }), null);
  assert.equal(imageDecision({ path: '/x/a.png', th: { ...th, disable: ['image'] }, sizeOf: big }), null);
  assert.equal(imageDecision({ path: '/x/missing.png', th, sizeOf: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(imageDecision({ path: undefined, th }), null);
});

test('shotDecision counts screenshot tools and warns every N calls', () => {
  let count = 0;
  const msgs = [];
  for (let i = 0; i < 60; i++) {
    const d = shotDecision({ tool: 'mcp__claude-in-chrome__computer', count, th });
    count = d.count;
    if (d.message) msgs.push(d.message);
  }
  assert.equal(count, 60);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0], /30 screenshot/);
  assert.deepEqual(shotDecision({ tool: 'Bash', count: 5, th }), { count: 5, message: null });
  assert.equal(shotDecision({ tool: 'mcp__plugin_playwright_playwright__browser_take_screenshot', count: 0, th }).count, 1);
  assert.deepEqual(shotDecision({ tool: 'mcp__x__computer', count: 29, th: { ...th, disable: ['screenshot'] } }), { count: 29, message: null });
});
