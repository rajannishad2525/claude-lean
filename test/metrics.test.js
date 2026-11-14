import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics } from '../src/metrics.js';
import { req, sess, cfg } from './helpers.js';

test('shareRequestsAboveCtx fires and weighs cache-read above the threshold', () => {
  const s = sess([req(100e3), req(600e3, { cr: 600e3 }), req(700e3, { cr: 700e3 })]);
  const r = metrics.shareRequestsAboveCtx([s], { above: 500e3, minShare: 0.5 });
  assert.equal(r.hit, true);
  assert.equal(r.weightTokens, 1300e3);
  assert.match(r.evidence, /67% of 3 requests ran above 500k/);
});

test('shareRequestsAboveCtx stays quiet below minShare and on no requests', () => {
  assert.equal(metrics.shareRequestsAboveCtx([sess([req(10e3), req(20e3)])], { above: 500e3, minShare: 0.1 }).hit, false);
  assert.equal(metrics.shareRequestsAboveCtx([], { above: 500e3, minShare: 0.1 }).hit, false);
});

test('medianFirstCtx uses the median of sessions with enough requests', () => {
  const long = (first) => sess(Array.from({ length: 20 }, (_, i) => req(i === 0 ? first : 1)));
  const short = sess([req(900e3)]);
  const r = metrics.medianFirstCtx([long(100e3), long(110e3), long(10e3), short], { above: 60e3, minRequests: 20 });
  assert.equal(r.hit, true);
  assert.match(r.evidence, /median first-request context is 100k tokens over 3 sessions/);
  assert.equal(metrics.medianFirstCtx([long(10e3)], { above: 60e3 }).hit, false);
});

test('cacheRebuilds separates idle rebuilds from mid-session rebuilds by gap', () => {
  const idle = req(200e3, { cc: 200e3, gapMs: 600_000 });
  const mid = req(200e3, { cc: 200e3, gapMs: 30_000 });
  const first = req(200e3, { cc: 200e3, gapMs: null });
  const small = req(10e3, { cc: 10e3, gapMs: 600_000 });
  const s = sess([first, idle, mid, small]);
  const idleHit = metrics.cacheRebuilds([s], { minTokens: 150e3, gapMinMs: 300_000, minCount: 1 });
  assert.equal(idleHit.hit, true);
  assert.equal(idleHit.weightTokens, 200e3);
  const midHit = metrics.cacheRebuilds([s], { minTokens: 150e3, gapMaxMs: 300_000, minCount: 1 });
  assert.equal(midHit.hit, true);
  assert.equal(midHit.weightTokens, 200e3);
  assert.equal(metrics.cacheRebuilds([s], { minTokens: 150e3, gapMinMs: 300_000, minCount: 2 }).hit, false);
});

test('maxPerSession fires when any session reaches the minimum', () => {
  const a = sess([req(1)], { screenshotCalls: 5 });
  const b = sess([req(1)], { screenshotCalls: 40 });
  const r = metrics.maxPerSession([a, b], { field: 'screenshotCalls', min: 30 });
  assert.equal(r.hit, true);
  assert.match(r.evidence, /1 of 2 sessions had >=30 screenshotCalls \(max 40\)/);
  assert.equal(metrics.maxPerSession([a], { field: 'screenshotCalls', min: 30 }).hit, false);
});

test('modelShare matches model names case-insensitively', () => {
  const s = sess([req(1, { model: 'claude-opus-5-5' }), req(1, { model: 'claude-opus-5-5' }), req(1, { model: 'claude-sonnet-5-5' })]);
  assert.equal(metrics.modelShare([s], { match: 'opus', minShare: 0.5 }).hit, true);
  assert.equal(metrics.modelShare([s], { match: 'opus', minShare: 0.9 }).hit, false);
});

test('configAtLeast compares a numeric config fact', () => {
  const c = cfg({ facts: { claudeMdLines: 250 } });
  assert.equal(metrics.configAtLeast([], { field: 'claudeMdLines', min: 201 }, c).hit, true);
  assert.equal(metrics.configAtLeast([], { field: 'claudeMdLines', min: 300 }, c).hit, false);
});

test('duplicatePlugins targets every copy after the first', () => {
  const r = metrics.duplicatePlugins([], {}, cfg({ duplicates: [['a@m1', 'a@m2', 'a@m3'], ['b@x', 'b@y']] }));
  assert.equal(r.hit, true);
  assert.deepEqual(r.targets, ['a@m2', 'a@m3', 'b@y']);
  assert.equal(metrics.duplicatePlugins([], {}, cfg()).hit, false);
});

test('settingState handles absent, present (truthy only), notFalse and prefix', () => {
  const c = cfg({ settings: { idleCompaction: false, keep: 'x' }, env: { DISABLE_PROMPT_CACHING: '1', DISABLE_PROMPT_CACHING_HAIKU: '0' } });
  const st = (p) => metrics.settingState([], p, c);
  assert.equal(st({ source: 'setting', key: 'nope', when: 'absent' }).hit, true);
  assert.equal(st({ source: 'setting', key: 'keep', when: 'absent' }).hit, false);
  assert.equal(st({ source: 'setting', key: 'idleCompaction', when: 'notFalse' }).hit, false);
  assert.equal(st({ source: 'setting', key: 'other', when: 'notFalse' }).hit, true);
  const p = st({ source: 'env', key: 'DISABLE_PROMPT_CACHING', prefix: true, when: 'present' });
  assert.equal(p.hit, true);
  assert.deepEqual(p.targets, ['DISABLE_PROMPT_CACHING']); // the "0" one is not active
});

test('hookInjection averages estimated tokens per session over the named events', () => {
  const a = sess([req(1)], { hookChars: { SessionStart: 36000 } });
  const b = sess([req(1)], { hookChars: { SessionStart: 36000, Other: 99999 } });
  const r = metrics.hookInjection([a, b], { above: 3000, events: ['SessionStart', 'UserPromptSubmit'] });
  assert.equal(r.hit, true);
  assert.equal(r.weightTokens, 20000);
  assert.match(r.evidence, /~10k tokens per session/);
  assert.equal(metrics.hookInjection([sess([req(1)])], { above: 3000, events: ['SessionStart'] }).hit, false);
  assert.equal(metrics.hookInjection([], { above: 3000, events: ['SessionStart'] }).hit, false);
});

test('config metrics never hit when no config is supplied', () => {
  assert.equal(metrics.configAtLeast([], { field: 'claudeMdLines', min: 0 }, null).hit, false);
  assert.equal(metrics.duplicatePlugins([], {}, undefined).hit, false);
  assert.equal(metrics.settingState([], { source: 'env', key: 'X', when: 'absent' }, null).hit, false);
});
