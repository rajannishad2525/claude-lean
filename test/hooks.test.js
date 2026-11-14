import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../plugin/hooks/', import.meta.url));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISABLE_|CLAUDE_)/.test(k)));

function sandbox(override = null) {
  const root = mkdtempSync(join(tmpdir(), 'lean-hook-'));
  const cfg = join(root, 'cfg');
  mkdirSync(cfg);
  if (override) writeFileSync(join(cfg, 'claude-lean.json'), JSON.stringify(override));
  return { root, env: { ...baseEnv, CLAUDE_PLUGIN_DATA: join(root, 'data'), CLAUDE_CONFIG_DIR: cfg } };
}
function run(script, input, env) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env });
  assert.equal(r.status, 0, `${script} must always exit 0 (stderr: ${r.stderr})`);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.ok(lines.length <= 1, `${script} printed ${lines.length} lines`);
  return lines.length ? JSON.parse(lines[0]) : null;
}
function transcriptWith({ root, ctx, ageMs }) {
  const file = join(root, 't.jsonl');
  writeFileSync(file, `${JSON.stringify({
    type: 'assistant', timestamp: new Date(Date.now() - ageMs).toISOString(),
    message: { id: 'a', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, output_tokens: 1 } },
  })}\n`);
  return file;
}

test('prompt-guard is silent on the happy path', () => {
  const { root, env } = sandbox();
  assert.equal(run('prompt-guard.mjs', { session_id: 's', transcript_path: transcriptWith({ root, ctx: 50e3, ageMs: 60_000 }) }, env), null);
});

test('prompt-guard warns once per context level, through systemMessage only', () => {
  const { root, env } = sandbox();
  const input = { session_id: 's', transcript_path: transcriptWith({ root, ctx: 160e3, ageMs: 60_000 }) };
  const out = run('prompt-guard.mjs', input, env);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.match(out.systemMessage, /context is 160k tokens/);
  assert.equal(run('prompt-guard.mjs', input, env), null, 'same level is not repeated');
});

test('prompt-guard warns about an idle gap with a big context', () => {
  const { root, env } = sandbox();
  const out = run('prompt-guard.mjs', { session_id: 's', transcript_path: transcriptWith({ root, ctx: 200e3, ageMs: 10 * 60_000 }) }, env);
  assert.match(out.systemMessage, /idle for 10 min/);
});

test('prompt-guard honors claude-lean.json (idle disabled, higher context levels)', () => {
  const { root, env } = sandbox({ disable: ['idle'], ctxWarn: [500000] });
  assert.equal(run('prompt-guard.mjs', { session_id: 's', transcript_path: transcriptWith({ root, ctx: 200e3, ageMs: 10 * 60_000 }) }, env), null);
});

test('every guard stays silent and exits 0 on garbage, empty or unusable input', () => {
  const { root, env } = sandbox();
  for (const script of ['prompt-guard.mjs', 'image-guard.mjs', 'screenshot-guard.mjs']) {
    assert.equal(run(script, '', env), null);
    assert.equal(run(script, 'not json', env), null);
    assert.equal(run(script, {}, env), null);
  }
  assert.equal(run('prompt-guard.mjs', { session_id: 's', transcript_path: join(root, 'missing.jsonl') }, env), null);
});

test('image-guard denies a big image Read with a hookSpecificOutput deny and allows the rest', () => {
  const { root, env } = sandbox();
  writeFileSync(join(root, 'big.png'), Buffer.alloc(600 * 1024));
  writeFileSync(join(root, 'small.png'), Buffer.alloc(10 * 1024));
  const deny = run('image-guard.mjs', { tool_name: 'Read', cwd: root, tool_input: { file_path: 'big.png' } }, env);
  assert.equal(deny.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /image is 600 KB/);
  assert.equal(run('image-guard.mjs', { tool_name: 'Read', cwd: root, tool_input: { file_path: 'small.png' } }, env), null);
  assert.equal(run('image-guard.mjs', { tool_name: 'Bash', cwd: root, tool_input: { file_path: 'big.png' } }, env), null);
});

test('screenshot-guard warns every Nth screenshot call in a session, per session', () => {
  const { env } = sandbox({ screenshotWarnEvery: 3 });
  const call = (session, tool = 'mcp__claude-in-chrome__computer') => run('screenshot-guard.mjs', { session_id: session, tool_name: tool }, env);
  assert.equal(call('s1'), null);
  assert.equal(call('s1'), null);
  assert.match(call('s1').systemMessage, /3 screenshot/);
  assert.equal(call('s2'), null, 'another session has its own count');
  assert.equal(call('s1', 'Bash'), null, 'non-screenshot tools are not counted');
});
