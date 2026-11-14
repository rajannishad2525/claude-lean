import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, evaluate } from '../src/rules.js';
import { req, sess, cfg } from './helpers.js';

test('shipped rules all load, have unique ids and a valid confidence tag', () => {
  const rules = loadRules();
  assert.equal(rules.length, 23);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  for (const r of rules) assert.ok(['official', 'measured', 'unverified'].includes(r.confidence), r.id);
});

test('loadRules rejects a rule that names an unknown metric', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-rules-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({
    id: 'bad', title: 't', source: 's', confidence: 'measured', detect: { metric: 'nope' }, fix: { type: 'advice', text: 'x' },
  }));
  assert.throws(() => loadRules(dir), /bad rule bad\.json/);
});

test('evaluate returns only hits, heaviest first', () => {
  const huge = sess(Array.from({ length: 10 }, () => req(800e3, { cr: 800e3 })), { screenshotCalls: 99 });
  const ids = evaluate(loadRules(), [huge]).map((f) => f.rule.id);
  assert.ok(ids.includes('ctx-300k') && ids.includes('ctx-500k') && ids.includes('screenshot-loop'));
  assert.ok(ids.indexOf('ctx-500k') < ids.indexOf('screenshot-loop'), 'weighted findings sort before unweighted');
});

test('a healthy session produces no findings', () => {
  const ok = sess(Array.from({ length: 30 }, () => req(40e3, { cr: 40e3 })));
  assert.deepEqual(evaluate(loadRules(), [ok]), []);
});

test('official rules cite an https source; unverified rules say so', () => {
  for (const r of loadRules()) {
    if (r.confidence === 'official') assert.match(r.source, /https:\/\//, r.id);
    if (r.confidence === 'unverified') assert.match(r.source, /unverified/, r.id);
  }
});

function writeRule(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'lean-rules-'));
  writeFileSync(join(dir, 'r.json'), JSON.stringify({
    id: 'r', title: 't', source: 's', confidence: 'measured',
    detect: { metric: 'modelShare', match: 'x', minShare: 1 }, fix: { type: 'advice', text: 'x' }, ...extra,
  }));
  return dir;
}

test('loadRules rejects a bad models list and an unknown fix edit op', () => {
  assert.throws(() => loadRules(writeRule({ models: 'opus' })), /bad rule r\.json/);
  assert.throws(() => loadRules(writeRule({ fix: { type: 'settings', text: 'x', edit: { op: 'rm -rf' } } })), /bad rule r\.json/);
  assert.doesNotThrow(() => loadRules(writeRule({ models: ['opus'], fix: { type: 'settings', text: 'x', edit: { op: 'setKey', key: 'k', value: 1 } } })));
});

test('models filter scopes requests and skips rules with no matching model', () => {
  const s = sess([req(600e3, { cr: 600e3, model: 'claude-opus-5-5' }), req(10e3, { model: 'claude-sonnet-5-5' })]);
  const rule = (models) => ({
    id: 'x', title: 't', source: 's', confidence: 'measured', models,
    detect: { metric: 'shareRequestsAboveCtx', above: 500e3, minShare: 0.9 }, fix: { type: 'advice', text: 'x' },
  });
  assert.equal(evaluate([rule(['opus'])], [s]).length, 1);  // only the opus request counts: 100%
  assert.equal(evaluate([rule(['*'])], [s]).length, 0);     // 50% overall
  assert.equal(evaluate([rule(['haiku'])], [s]).length, 0); // nothing matches: rule skipped
});

// [config that makes the rule fire, config that keeps it quiet]
const CONFIG_CASES = {
  'plugin-duplicate': [cfg({ duplicates: [['a@m1', 'a@m2']] }), cfg()],
  'plugin-count': [cfg({ facts: { pluginCount: 20 } }), cfg({ facts: { pluginCount: 3 } })],
  'claudemd-big': [cfg({ facts: { claudeMdLines: 300 } }), cfg({ facts: { claudeMdLines: 100 } })],
  'memory-index-big': [cfg({ facts: { memoryIndexBytes: 40000 } }), cfg({ facts: { memoryIndexBytes: 100 } })],
  'agent-teams': [cfg({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }), cfg()],
  'caching-disabled': [cfg({ env: { DISABLE_PROMPT_CACHING: '1' } }), cfg()],
  'subagent-ttl': [cfg(), cfg({ settings: { subagentPromptCacheTtl: '1h' } })],
  'crossession-inbound': [cfg(), cfg({ settings: { crossSessionInbound: 'hold' } })],
  'goal-checkin': [cfg(), cfg({ env: { CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '0' } })],
  'idle-compaction': [cfg(), cfg({ settings: { idleCompaction: false } })],
  'prompt-suggestions': [cfg(), cfg({ settings: { promptSuggestionEnabled: false } })],
  'autoupdate-rebuild': [cfg(), cfg({ env: { DISABLE_AUTOUPDATER: '1' } })],
};

for (const [id, [fires, quiet]] of Object.entries(CONFIG_CASES)) {
  test(`config rule ${id} fires and stays quiet`, () => {
    const rules = loadRules().filter((r) => r.id === id);
    assert.equal(rules.length, 1);
    assert.equal(evaluate(rules, [], fires).length, 1);
    assert.equal(evaluate(rules, [], quiet).length, 0);
  });
}

test('transcript-derived rules hook-stdout-big and mcp-failing fire and stay quiet', () => {
  const pick = (id) => loadRules().filter((r) => r.id === id);
  assert.equal(evaluate(pick('hook-stdout-big'), [sess([req(1)], { hookChars: { SessionStart: 36000 } })], cfg()).length, 1);
  assert.equal(evaluate(pick('hook-stdout-big'), [sess([req(1)], { hookChars: { SessionStart: 100 } })], cfg()).length, 0);
  assert.equal(evaluate(pick('mcp-failing'), [sess([req(1)], { mcpFailures: 2 })], cfg()).length, 1);
  assert.equal(evaluate(pick('mcp-failing'), [sess([req(1)])], cfg()).length, 0);
});

test('findings carry targets from the metric', () => {
  const f = evaluate(loadRules().filter((r) => r.id === 'plugin-duplicate'), [], cfg({ duplicates: [['a@m1', 'a@m2']] }));
  assert.deepEqual(f[0].targets, ['a@m2']);
});
