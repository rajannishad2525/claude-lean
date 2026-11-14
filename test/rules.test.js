import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, evaluate } from '../src/rules.js';
import { req, sess } from './helpers.js';

test('shipped rules all load, have unique ids and a valid confidence tag', () => {
  const rules = loadRules();
  assert.equal(rules.length, 9);
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
