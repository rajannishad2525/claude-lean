import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShare } from '../src/share.js';
import { evaluate, loadRules } from '../src/rules.js';
import { assistantLine, cfg, req, sess, toolUse } from './helpers.js';

const opus = (n, ctx, o = {}) => Array.from({ length: n }, () => req(ctx, { model: 'claude-opus-5-5', ...o }));

function fixture() {
  const s1 = sess([req(100e3, { model: 'claude-opus-5-5' }), ...opus(9, 600e3, { cr: 600e3 }), ...opus(15, 40e3)], {
    file: '/home/secret/project/s1.jsonl', hookChars: { SessionStart: 36000 }, imageResults: 12, screenshotCalls: 40, agentSpawns: 3, mcpFailures: 1,
    toolVolume: { SECRET_TOOL: { n: 1, chars: 5 } },
  });
  const s2 = sess(Array.from({ length: 25 }, () => req(40e3, { model: 'claude-sonnet-5-5' })));
  const config = cfg({
    facts: { pluginCount: 19, duplicatePluginCount: 1, claudeMdLines: 250, memoryIndexBytes: 30720 },
    plugins: ['SECRET_PLUGIN@secret-market'], duplicates: [['SECRET_PLUGIN@a', 'SECRET_PLUGIN@b']],
    env: { SECRET_ENV: '1' }, userSettingsPath: '/home/secret/.claude/settings.json',
  });
  const sessions = [s1, s2];
  return { sessions, config, findings: evaluate(loadRules(), sessions, config) };
}

test('buildShare reports aggregates only', () => {
  const { sessions, config, findings } = fixture();
  const s = buildShare(sessions, config, findings);
  assert.equal(s.schema, 1);
  assert.equal(s.sessions, 2);
  assert.equal(s.requests, 50);
  assert.equal(s.shareAbove300k, 0.18);
  assert.equal(s.shareAbove500k, 0.18);
  assert.equal(s.medianFirstCtxK, 100);
  assert.equal(s.hookTokensPerSessionK, 5);
  assert.deepEqual(s.maxPerSession, { imageResults: 12, screenshotCalls: 40, agentSpawns: 3, mcpFailures: 1 });
  assert.equal(s.modelShare.opus, 0.5);
  assert.deepEqual(s.config, { pluginCount: 19, duplicatePluginCount: 1, claudeMdLines: '>200', memoryIndexKB: 30 });
  assert.ok(s.findings.some((f) => f.id === 'plugin-duplicate'));
  assert.ok(s.findings.every((f) => Object.keys(f).sort().join() === 'confidence,id,weightMtok'));
});

test('buildShare output contains no path, name or text from the inputs', () => {
  const { sessions, config, findings } = fixture();
  assert.ok(findings.some((f) => /SECRET/.test(f.evidence)), 'sanity: the evidence does hold a plugin name, share must drop it');
  assert.doesNotMatch(JSON.stringify(buildShare(sessions, config, findings)), /SECRET|secret|home|jsonl/);
});

test('buildShare copes with no sessions', () => {
  const s = buildShare([], cfg(), []);
  assert.equal(s.requests, 0);
  assert.equal(s.shareAbove300k, 0);
  assert.equal(s.medianFirstCtxK, 0);
});

const BIN = fileURLToPath(new URL('../bin/lean.js', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISABLE_|CLAUDE_)/.test(k)));

test('lean share prints sanitized JSON, nothing from the transcript or settings leaks, and --out writes a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-share-'));
  const put = (p, c) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); return join(dir, p); };
  put('claude/settings.json', JSON.stringify({ enabledPlugins: { 'SECRET_PLUGIN@m1': true, 'SECRET_PLUGIN@m2': true }, env: { SECRET_ENV: '1' } }));
  put('claude/CLAUDE.md', 'SECRET_INSTRUCTIONS\n');
  const lines = Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000, content: [toolUse(`t${i}`, 'Bash', { command: 'SECRET_CMD' })] }));
  const file = put('s.jsonl', lines.join('\n'));
  const args = ['share', '--claude-dir', join(dir, 'claude'), '--file', file];
  const run = (extra = []) => execFileSync(process.execPath, [BIN, ...args, ...extra], { encoding: 'utf8', cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  const out = run();
  const j = JSON.parse(out);
  assert.equal(j.schema, 1);
  assert.equal(j.requests, 30);
  assert.equal(j.config.duplicatePluginCount, 1);
  assert.doesNotMatch(out, /SECRET|secret/);

  const outFile = join(dir, 'share.json');
  assert.equal(run(['--out', outFile]), '');
  assert.ok(existsSync(outFile));
  assert.deepEqual(JSON.parse(readFileSync(outFile, 'utf8')), j);
});
