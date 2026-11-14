import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantLine } from './helpers.js';

const fixture = () => {
  const lines = Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000 }));
  const file = join(mkdtempSync(join(tmpdir(), 'lean-cli-')), 's.jsonl');
  writeFileSync(file, lines.join('\n'));
  return file;
};
const run = (...args) => execFileSync(process.execPath, ['bin/lean.js', 'doctor', ...args], { encoding: 'utf8' });

test('doctor prints a ranked text report', () => {
  const out = run('--file', fixture());
  assert.match(out, /claude-lean doctor: 1 sessions, 30 requests/);
  assert.match(out, /1\. \[official\] Context grew past 300k tokens/);
  assert.match(out, /found: +100% of 30 requests ran above 300k context/);
  assert.match(out, /fix: /);
});

test('doctor --json is machine readable', () => {
  const j = JSON.parse(run('--file', fixture(), '--json'));
  assert.equal(j.sessions, 1);
  assert.equal(j.requests, 30);
  assert.ok(j.findings.some((f) => f.id === 'ctx-300k' && f.confidence === 'official'));
});

test('unknown command exits non-zero with usage', () => {
  assert.throws(() => execFileSync(process.execPath, ['bin/lean.js', 'nope'], { stdio: 'pipe' }), /usage: lean doctor/);
});
