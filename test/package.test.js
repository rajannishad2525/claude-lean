import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantLine } from './helpers.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISABLE_|CLAUDE_)/.test(k)));

test('the npm package installs on its own and runs: every file the CLI needs is shipped', () => {
  const work = mkdtempSync(join(tmpdir(), 'lean-pack-'));
  execSync(`npm pack --pack-destination "${work}" --silent`, { cwd: root, stdio: 'pipe' });
  const tgz = readdirSync(work).find((f) => f.endsWith('.tgz'));
  assert.ok(tgz, 'npm pack produced a tarball');
  const prefix = join(work, 'install');
  mkdirSync(prefix);
  execSync(`npm install --prefix "${prefix}" "${join(work, tgz)}" --no-audit --no-fund`, { stdio: 'pipe' });
  const bin = join(prefix, 'node_modules', 'claude-lean', 'bin', 'lean.js');

  const transcript = join(work, 's.jsonl');
  writeFileSync(transcript, Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000 })).join('\n'));
  const run = (...args) => execFileSync(process.execPath, [bin, ...args, '--claude-dir', join(work, 'claude'), '--file', transcript], { encoding: 'utf8', cwd: work, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  assert.match(run('doctor'), /claude-lean doctor: 1 sessions, 30 requests/);
  assert.equal(JSON.parse(run('share')).schema, 1);
  assert.match(run('fix'), /dry run/);
});
