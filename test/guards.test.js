import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageDecision, lastUsage, loadState, loadThresholds, promptDecision, saveState, shotDecision } from '../plugin/lib/guards.mjs';

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

const usageLine = ({ id, cr, cc = 0, at, side = false, model = 'claude-sonnet-5-5' }) => JSON.stringify({
  type: 'assistant', timestamp: new Date(at).toISOString(), isSidechain: side,
  message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 1 } },
});
const transcript = (lines) => {
  const f = join(mkdtempSync(join(tmpdir(), 'lean-tail-')), 't.jsonl');
  writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
};

test('lastUsage reads ctx and time from the last real assistant line, skipping sidechain and synthetic', () => {
  const f = transcript([
    usageLine({ id: 'a', cr: 100e3, at: 1000 }),
    usageLine({ id: 'b', cr: 200e3, cc: 5e3, at: 2000 }),
    usageLine({ id: 'c', cr: 999e3, at: 3000, side: true }),
    usageLine({ id: 'd', cr: 0, at: 4000, model: '<synthetic>' }),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  ]);
  assert.deepEqual(lastUsage(f), { ctx: 205001, ts: 2000 });
});

test('lastUsage works on a transcript far bigger than the tail window (cut first line is dropped)', () => {
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } });
  const f = transcript([usageLine({ id: 'old', cr: 50e3, at: 1 }), ...Array.from({ length: 400 }, () => filler), usageLine({ id: 'new', cr: 300e3, at: 5000 })]);
  assert.equal(lastUsage(f).ctx, 300001);
});

test('lastUsage widens the window when the last usage line is far from the end', () => {
  const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } });
  assert.equal(lastUsage(transcript([usageLine({ id: 'a', cr: 120e3, at: 7 }), huge])).ctx, 120001);
});

test('lastUsage returns null when there is no usage, or the file is empty or missing', () => {
  assert.equal(lastUsage(transcript([JSON.stringify({ type: 'user', message: { content: 'hi' } })])), null);
  assert.equal(lastUsage(transcript([])), null);
  assert.equal(lastUsage(join(tmpdir(), 'lean-does-not-exist.jsonl')), null);
});

test('state round-trips per session, sanitizes the session id and survives a missing dir', () => {
  process.env.CLAUDE_PLUGIN_DATA = join(mkdtempSync(join(tmpdir(), 'lean-state-')), 'nested');
  assert.deepEqual(loadState('s1'), {});
  saveState('s1', { level: 2 });
  assert.deepEqual(loadState('s1'), { level: 2 });
  saveState('../evil', { level: 1 });
  assert.ok(existsSync(join(process.env.CLAUDE_PLUGIN_DATA, '___evil.json')), 'no path traversal');
});
