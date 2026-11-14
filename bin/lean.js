#!/usr/bin/env node
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeFile } from '../src/summarize.js';
import { evaluate, loadRules } from '../src/rules.js';
import { formatReport } from '../src/report.js';
import { loadConfig } from '../src/config.js';
import { applyFix, planFix } from '../src/fix.js';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (n) => args.includes(n);
const values = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));

if (cmd !== 'doctor' && cmd !== 'fix') {
  console.error('usage: lean doctor [--json] [--claude-dir <dir>] [--dir <projects dir>] [--file <session.jsonl>]...\n       lean fix [--apply] [--include-unverified] [--claude-dir <dir>]');
  process.exit(1);
}

const claudeDir = values('--claude-dir')[0];
const config = loadConfig({ claudeDir });

if (cmd === 'fix') {
  if (config.userSettingsError) {
    console.error('settings.json exists but is not valid JSON; refusing to edit it.');
    process.exit(2);
  }
  // Settings rules are config-detectable by design, so no transcripts are needed here.
  const rules = loadRules().filter((r) => r.fix.type === 'settings');
  const plan = planFix(config.userSettings, evaluate(rules, [], config), { includeUnverified: flag('--include-unverified') });
  const apply = flag('--apply');
  console.log(`claude-lean fix${apply ? '' : ' (dry run)'}`);
  const backup = apply ? applyFix(config.userSettingsPath, plan) : null;
  for (const d of plan.done) console.log(`  ${apply ? 'did' : 'would'}: ${d}`);
  for (const m of plan.manual) console.log(`  manual: ${m}`);
  if (plan.skipped.length) console.log(`  skipped (unverified setting names; pass --include-unverified to apply): ${plan.skipped.join(', ')}`);
  if (!plan.done.length) console.log('Nothing to change.');
  else if (!apply) console.log('Nothing was written. Re-run with --apply to write (a backup is made first).');
  else console.log(`Wrote ${config.userSettingsPath}${backup ? ` (backup: ${backup})` : ' (new file, no backup needed)'}`);
  process.exit(0);
}

function transcriptFiles() {
  const files = values('--file');
  if (files.length) return files;
  const root = values('--dir')[0] || join(claudeDir || join(homedir(), '.claude'), 'projects');
  if (!existsSync(root)) {
    console.error(`no transcripts found at ${root}`);
    process.exit(2);
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith('.jsonl')).map((f) => join(root, d.name, f)));
}

const sessions = [];
let unsupported = 0;
for (const f of transcriptFiles()) {
  const s = await summarizeFile(f);
  if (s.unsupported) unsupported++;
  if (s.requests.length) sessions.push(s);
}
const warnings = unsupported
  ? [`${unsupported} transcript file(s) have assistant lines without usage data (unsupported format?) and were excluded. Claude Code's transcript format may have changed.`]
  : [];
const findings = evaluate(loadRules(), sessions, config);

if (flag('--json')) {
  console.log(JSON.stringify({
    sessions: sessions.length,
    requests: sessions.reduce((t, s) => t + s.requests.length, 0),
    warnings,
    findings: findings.map((f) => ({ id: f.rule.id, confidence: f.rule.confidence, evidence: f.evidence, weightTokens: f.weightTokens })),
  }, null, 2));
} else {
  console.log(formatReport(findings, sessions, warnings));
}
