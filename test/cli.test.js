import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantLine, mcpFailLine } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/lean.js', import.meta.url));
// The machine's real Claude settings must never leak into a test.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISABLE_|CLAUDE_)/.test(k)));

function tmp(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'lean-cli-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}
const lean = (args, dir) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir, env: cleanEnv(), stdio: 'pipe' });
const transcript = (lines) => join(tmp({ 's.jsonl': lines.join('\n') }), 's.jsonl');
const bigSession = () => transcript(Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000 })));

test('doctor prints a ranked text report', () => {
  const dir = tmp();
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', bigSession()], dir);
  assert.match(out, /claude-lean doctor: 1 sessions, 30 requests/);
  assert.match(out, /1\. \[official\] Context grew past 300k tokens/);
  assert.match(out, /found: +100% of 30 requests ran above 300k context/);
  assert.match(out, /fix: /);
});

test('doctor includes config rules and marks fixable ones', () => {
  const dir = tmp();
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', bigSession()], dir);
  assert.match(out, /\[official\] Auto-update can rebuild the cache mid-work/);
  assert.match(out, /\[lean fix can apply this\]/);
});

test('doctor --json is machine readable', () => {
  const dir = tmp();
  const j = JSON.parse(lean(['doctor', '--json', '--claude-dir', join(dir, 'claude'), '--file', bigSession()], dir));
  assert.equal(j.sessions, 1);
  assert.equal(j.requests, 30);
  assert.deepEqual(j.warnings, []);
  assert.ok(j.findings.some((f) => f.id === 'ctx-300k' && f.confidence === 'official'));
});

test('unsupported transcript format is reported, not silently dropped', () => {
  const dir = tmp();
  const bad = JSON.stringify({ type: 'assistant', timestamp: new Date(0).toISOString(), message: { id: 'a', content: [] } });
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', transcript([bad])], dir);
  assert.match(out, /warning: 1 transcript file\(s\) have assistant lines without usage data/);
  assert.match(out, /No supported transcripts were analysed/);
  assert.doesNotMatch(out, /No known causes found/);
});

test('unknown command exits non-zero with usage', () => {
  assert.throws(() => execFileSync(process.execPath, [BIN, 'nope'], { stdio: 'pipe' }), /usage: lean doctor/);
});

const settingsWith = (obj) => {
  const dir = tmp({ 'claude/settings.json': JSON.stringify(obj, null, 2) });
  return { dir, claudeDir: join(dir, 'claude'), path: join(dir, 'claude', 'settings.json') };
};

// Unverified-rule skipping is unit-tested in fix.test.js; every shipped settings rule is documented ("official").
test('fix is a dry run by default and writes nothing', () => {
  const { dir, claudeDir, path } = settingsWith({ theme: 'dark', enabledPlugins: { 'a@m1': true, 'a@m2': true } });
  const before = readFileSync(path, 'utf8');
  const out = lean(['fix', '--claude-dir', claudeDir], dir);
  assert.match(out, /dry run/);
  assert.match(out, /would: disable plugin a@m2/);
  assert.match(out, /would: set env DISABLE_AUTOUPDATER = "1"/);
  assert.match(out, /would: set crossSessionInbound = "hold"/);
  assert.match(out, /Nothing was written/);
  assert.doesNotMatch(out, /skipped/);
  assert.equal(readFileSync(path, 'utf8'), before);
  assert.equal(readdirSync(claudeDir).length, 1, 'no backup in a dry run');
});

test('fix --apply backs up, edits only named keys, and a second run is a no-op', () => {
  const { dir, claudeDir, path } = settingsWith({ theme: 'dark', enabledPlugins: { 'a@m1': true, 'a@m2': true } });
  const before = readFileSync(path, 'utf8');
  lean(['fix', '--apply', '--claude-dir', claudeDir], dir);
  const backups = readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.lean-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(claudeDir, backups[0]), 'utf8'), before);
  const s = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.enabledPlugins, { 'a@m1': true, 'a@m2': false });
  assert.equal(s.env.DISABLE_AUTOUPDATER, '1');
  assert.equal(s.crossSessionInbound, 'hold');
  assert.equal(s.promptSuggestionEnabled, false);
  assert.equal(s.idleCompaction, false);
  const again = lean(['fix', '--apply', '--claude-dir', claudeDir], dir);
  assert.match(again, /Nothing to change/);
  assert.equal(readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.lean-backup-')).length, 1);
});

test('fix refuses to touch a settings.json that is not valid JSON', () => {
  const dir = tmp({ 'claude/settings.json': '{ not json' });
  const path = join(dir, 'claude', 'settings.json');
  assert.throws(() => lean(['fix', '--apply', '--claude-dir', join(dir, 'claude')], dir), /not valid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{ not json');
});

test('fix denies an MCP server that failed in several sessions (unverified rule: needs the flag), from transcripts', () => {
  const files = {};
  for (let i = 0; i < 3; i++) files[`claude/projects/p/s${i}.jsonl`] = [assistantLine({ id: `a${i}`, cr: 10 }), mcpFailLine(`m${i}`, [{ name: 'flaky' }])].join('\n');
  const dir = tmp({ 'claude/settings.json': '{}', ...files });
  const claudeDir = join(dir, 'claude');
  const plain = lean(['fix', '--claude-dir', claudeDir], dir);
  assert.match(plain, /skipped \(unverified.*mcp-failing/);
  const dry = lean(['fix', '--include-unverified', '--claude-dir', claudeDir], dir);
  assert.match(dry, /would: deny MCP server flaky/);
  lean(['fix', '--apply', '--include-unverified', '--claude-dir', claudeDir], dir);
  assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).deniedMcpServers, [{ serverName: 'flaky' }]);
});

test('doctor --context prints the overhead breakdown from a pasted /context file', () => {
  const dir = tmp({ 'ctx.txt': '⛁ MCP tools: 31.5k tokens (15.8%)\n⛁ Skills: 12.0k tokens (6.0%)\n' });
  const args = ['--claude-dir', join(dir, 'claude'), '--file', bigSession(), '--context', join(dir, 'ctx.txt')];
  const out = lean(['doctor', ...args], dir);
  assert.match(out, /Fixed overhead breakdown/);
  assert.match(out, /MCP tools/);
  assert.equal(JSON.parse(lean(['doctor', '--json', ...args], dir)).context.items[0].label, 'MCP tools');
});

test('doctor --context says so when the file has no recognisable token lines', () => {
  const dir = tmp({ 'ctx.txt': 'hello\n' });
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', bigSession(), '--context', join(dir, 'ctx.txt')], dir);
  assert.match(out, /No token lines recognised in/);
});

test('doctor and fix follow CLAUDE_CONFIG_DIR when no --claude-dir is given', () => {
  const lines = Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000 }));
  const dir = tmp({ 'custom/settings.json': '{}', 'custom/projects/p/s.jsonl': lines.join('\n') });
  const env = { ...cleanEnv(), CLAUDE_CONFIG_DIR: join(dir, 'custom') };
  const run = (args) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir, env, stdio: 'pipe' });
  assert.match(run(['doctor']), /1 sessions, 30 requests/);
  assert.match(run(['fix']), /would: set env DISABLE_AUTOUPDATER/);
});

test('a missing --file or --context path gives a clear error and exit 2, not a stack trace', () => {
  const dir = tmp();
  for (const extra of [['--file', join(dir, 'nope.jsonl')], ['--file', bigSession(), '--context', join(dir, 'nope.txt')]]) {
    let err;
    try { lean(['doctor', '--claude-dir', join(dir, 'claude'), ...extra], dir); } catch (e) { err = e; }
    assert.ok(err, 'exits non-zero');
    assert.equal(err.status, 2);
    assert.match(String(err.stderr), /file not found/i);
    assert.doesNotMatch(String(err.stderr), /\bat .*\.js:\d+/);
  }
});
