import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';

function dirWith(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'lean-cfg-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}

test('reads enabled plugins, duplicate names, merged env and file sizes', () => {
  const claudeDir = dirWith({
    'settings.json': JSON.stringify({
      enabledPlugins: { 'a@m1': true, 'a@m2': true, 'b@m1': true, 'c@m1': false },
      env: { DISABLE_AUTOUPDATER: '1' },
    }),
    'CLAUDE.md': 'l1\nl2\nl3\n',
    'projects/p1/memory/MEMORY.md': 'x'.repeat(100),
    'projects/p2/memory/MEMORY.md': 'x'.repeat(300),
  });
  const c = loadConfig({ claudeDir, cwd: dirWith(), env: { FOO: '1' } });
  assert.deepEqual(c.plugins, ['a@m1', 'a@m2', 'b@m1']);
  assert.deepEqual(c.duplicates, [['a@m1', 'a@m2']]);
  assert.deepEqual(c.facts, { pluginCount: 3, duplicatePluginCount: 1, claudeMdLines: 3, memoryIndexBytes: 300 });
  assert.deepEqual(c.env, { FOO: '1', DISABLE_AUTOUPDATER: '1' });
});

test('project settings layer over user settings for detection; user file stays separate', () => {
  const claudeDir = dirWith({ 'settings.json': JSON.stringify({ env: { A: '1' } }) });
  const cwd = dirWith({ '.claude/settings.json': JSON.stringify({ env: { B: '2' }, idleCompaction: false }), 'CLAUDE.md': 'one\ntwo' });
  const c = loadConfig({ claudeDir, cwd, env: {} });
  assert.deepEqual(c.env, { A: '1', B: '2' });
  assert.equal(c.settings.idleCompaction, false);
  assert.equal(c.userSettings.idleCompaction, undefined);
  assert.equal(c.facts.claudeMdLines, 2);
});

test('missing settings is empty; invalid settings is flagged so fix can refuse', () => {
  const missing = loadConfig({ claudeDir: dirWith(), cwd: dirWith(), env: {} });
  assert.deepEqual(missing.userSettings, {});
  assert.equal(missing.userSettingsError, false);
  const bad = loadConfig({ claudeDir: dirWith({ 'settings.json': '{ nope' }), cwd: dirWith(), env: {} });
  assert.equal(bad.userSettingsError, true);
  const arr = loadConfig({ claudeDir: dirWith({ 'settings.json': '[]' }), cwd: dirWith(), env: {} });
  assert.equal(arr.userSettingsError, true);
});

test('hookOwners maps a hook command to the plugin whose hooks.json holds it, or to settings', () => {
  const claudeDir = dirWith({
    'settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }),
    'pluginA/hooks/hooks.json': JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/x.mjs"' }] }] } }),
  });
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
  writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', installPath: join(claudeDir, 'pluginA') }], 'b@m': [{ installPath: join(claudeDir, 'missing') }] } }));
  const c = loadConfig({ claudeDir, cwd: dirWith(), env: {} });
  assert.equal(c.hookOwners.get('node "${CLAUDE_PLUGIN_ROOT}/x.mjs"'), 'a@m');
  assert.equal(c.hookOwners.get('my-own-hook'), 'settings hooks');
  assert.equal(c.hookOwners.size, 2);
});

test('hookOwners is empty (no crash) when installed_plugins.json is missing or broken', () => {
  assert.equal(loadConfig({ claudeDir: dirWith(), cwd: dirWith(), env: {} }).hookOwners.size, 0);
  const broken = dirWith({ 'plugins/installed_plugins.json': '{ nope' });
  assert.equal(loadConfig({ claudeDir: broken, cwd: dirWith(), env: {} }).hookOwners.size, 0);
});
