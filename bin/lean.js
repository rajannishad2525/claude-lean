#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeFile } from '../src/summarize.js';
import { evaluate, loadRules } from '../src/rules.js';
import { formatReport } from '../src/report.js';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (n) => args.includes(n);
const values = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));

if (cmd !== 'doctor') {
  console.error('usage: lean doctor [--json] [--dir <projects dir>] [--file <session.jsonl>]...');
  process.exit(1);
}

function transcriptFiles() {
  const files = values('--file');
  if (files.length) return files;
  const root = values('--dir')[0] || join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) {
    console.error(`no transcripts found at ${root}`);
    process.exit(2);
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith('.jsonl')).map((f) => join(root, d.name, f)));
}

const sessions = [];
for (const f of transcriptFiles()) {
  const s = await summarizeFile(f);
  if (s.requests.length) sessions.push(s);
}
const findings = evaluate(loadRules(), sessions);

if (flag('--json')) {
  console.log(JSON.stringify({
    sessions: sessions.length,
    requests: sessions.reduce((t, s) => t + s.requests.length, 0),
    findings: findings.map((f) => ({ id: f.rule.id, confidence: f.rule.confidence, evidence: f.evidence, weightTokens: f.weightTokens })),
  }, null, 2));
} else {
  console.log(formatReport(findings, sessions));
}
