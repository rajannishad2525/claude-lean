import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFix, planFix } from '../src/fix.js';

const finding = (edit, { confidence = 'measured', targets = [], type = 'settings' } = {}) => ({
  rule: { id: 'r', confidence, fix: { type, text: 'x', edit } },
  targets,
});

test('setKey and setEnv edit a copy, keep other keys, and are idempotent', () => {
  const settings = { theme: 'dark', env: { KEEP: '1' } };
  const fs = [finding({ op: 'setKey', key: 'idleCompaction', value: false }), finding({ op: 'setEnv', name: 'DISABLE_AUTOUPDATER', value: '1' })];
  const plan = planFix(settings, fs);
  assert.deepEqual(plan.next, { theme: 'dark', idleCompaction: false, env: { KEEP: '1', DISABLE_AUTOUPDATER: '1' } });
  assert.equal(plan.done.length, 2);
  assert.deepEqual(settings, { theme: 'dark', env: { KEEP: '1' } }, 'input is not mutated');
  assert.equal(planFix(plan.next, fs).done.length, 0, 'second run changes nothing');
});

test('unverified rules are skipped unless includeUnverified is set', () => {
  const f = finding({ op: 'setKey', key: 'k', value: 1 }, { confidence: 'unverified' });
  const skipped = planFix({}, [f]);
  assert.deepEqual(skipped.skipped, ['r']);
  assert.equal(skipped.done.length, 0);
  assert.equal(planFix({}, [f], { includeUnverified: true }).done.length, 1);
});

test('advice findings are ignored', () => {
  assert.equal(planFix({}, [finding({ op: 'setKey', key: 'k', value: 1 }, { type: 'advice' })]).done.length, 0);
});

test('removeEnv removes from settings.env and reports shell-only variables as manual', () => {
  const plan = planFix({ env: { DISABLE_PROMPT_CACHING: '1' } }, [finding({ op: 'removeEnv' }, { targets: ['DISABLE_PROMPT_CACHING', 'DISABLE_PROMPT_CACHING_HAIKU'] })]);
  assert.deepEqual(plan.next.env, {});
  assert.deepEqual(plan.done, ['remove env DISABLE_PROMPT_CACHING']);
  assert.match(plan.manual[0], /DISABLE_PROMPT_CACHING_HAIKU .*outside settings\.json/);
});

test('disablePlugin disables enabled user plugins and reports others as manual', () => {
  const plan = planFix({ enabledPlugins: { 'a@m2': true, 'b@m1': true } }, [finding({ op: 'disablePlugin' }, { targets: ['a@m2', 'z@m9'] })]);
  assert.deepEqual(plan.next.enabledPlugins, { 'a@m2': false, 'b@m1': true });
  assert.deepEqual(plan.done, ['disable plugin a@m2']);
  assert.match(plan.manual[0], /z@m9/);
});

test('applyFix writes a byte-exact timestamped backup and the new file; no-op writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-fix-'));
  const path = join(dir, 'settings.json');
  const original = '{ "theme": "dark" }\n';
  writeFileSync(path, original);
  const plan = planFix({ theme: 'dark' }, [finding({ op: 'setKey', key: 'idleCompaction', value: false })]);
  const backup = applyFix(path, plan, new Date('2026-11-14T10:20:30.123Z'));
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.match(backup, /settings\.json\.lean-backup-2026-11-14T10-20-30-123Z$/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme: 'dark', idleCompaction: false });
  const before = readdirSync(dir).length;
  assert.equal(applyFix(path, planFix(plan.next, []), new Date()), null);
  assert.equal(readdirSync(dir).length, before);
});

test('applyFix creates the file without a backup when settings.json does not exist', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lean-fix-')), 'settings.json');
  const plan = planFix({}, [finding({ op: 'setKey', key: 'k', value: 1 })]);
  assert.equal(applyFix(path, plan), null);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { k: 1 });
});
