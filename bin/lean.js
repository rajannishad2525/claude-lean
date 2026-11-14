#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { summarizeFile } from '../src/summarize.js';
import { evaluate, loadRules } from '../src/rules.js';
import { formatReport } from '../src/report.js';
import { loadConfig } from '../src/config.js';
import { applyFix, planFix } from '../src/fix.js';
import { buildShare } from '../src/share.js';
import { formatContext, parseContext } from '../src/context.js';

const args = process.argv.slice(2);
const cmd = args.shift();
const flag = (n) => args.includes(n);
const values = (n) => args.flatMap((a, i) => (a === n ? [args[i + 1]] : []));

if (cmd !== 'doctor' && cmd !== 'fix' && cmd !== 'share') {
  console.error('usage: lean doctor [--json] [--context <file>] [--claude-dir <dir>] [--dir <projects dir>] [--file <session.jsonl>]...\n       lean fix [--apply] [--include-unverified] [--claude-dir <dir>]\n       lean share [--out <file>] [--claude-dir <dir>] [--dir <projects dir>] [--file <session.jsonl>]...');
  process.exit(1);
}

const claudeDir = values('--claude-dir')[0];
const config = loadConfig({ claudeDir });

function transcriptFiles({ optional }) {
  const files = values('--file');
  if (files.length) return files;
  const root = values('--dir')[0] || join(claudeDir || join(homedir(), '.claude'), 'projects');
  if (!existsSync(root)) {
    if (optional) return [];
    console.error(`no transcripts found at ${root}`);
    process.exit(2);
  }
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .flatMap((d) => readdirSync(join(root, d.name)).filter((f) => f.endsWith('.jsonl')).map((f) => join(root, d.name, f)));
}

async function loadSessions({ optional = false } = {}) {
  const sessions = [];
  let unsupported = 0;
  for (const f of transcriptFiles({ optional })) {
    const s = await summarizeFile(f);
    if (s.unsupported) unsupported++;
    if (s.requests.length) sessions.push(s);
  }
  return { sessions, unsupported };
}

if (cmd === 'fix') {
  if (config.userSettingsError) {
    console.error('settings.json exists but is not valid JSON; refusing to edit it.');
    process.exit(2);
  }
  // Most settings rules are config-detectable; only rules marked needs:"transcripts" make fix read the history.
  const rules = loadRules().filter((r) => r.fix.type === 'settings');
  const { sessions } = rules.some((r) => r.needs === 'transcripts') ? await loadSessions({ optional: true }) : { sessions: [] };
  const plan = planFix(config.userSettings, evaluate(rules, sessions, config), { includeUnverified: flag('--include-unverified') });
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

const { sessions, unsupported } = await loadSessions();
const warnings = unsupported
  ? [`${unsupported} transcript file(s) have assistant lines without usage data (unsupported format?) and were excluded. Claude Code's transcript format may have changed.`]
  : [];
const findings = evaluate(loadRules(), sessions, config);

if (cmd === 'share') {
  const out = JSON.stringify(buildShare(sessions, config, findings), null, 2);
  const file = values('--out')[0];
  if (file) writeFileSync(file, `${out}\n`);
  else console.log(out);
  console.error('Review this before sharing. It holds only counts and rule ids; nothing was sent anywhere.');
  process.exit(0);
}

const contextFile = values('--context')[0];
const context = contextFile ? parseContext(readFileSync(contextFile, 'utf8')) : null;

if (flag('--json')) {
  console.log(JSON.stringify({
    sessions: sessions.length,
    requests: sessions.reduce((t, s) => t + s.requests.length, 0),
    warnings,
    findings: findings.map((f) => ({ id: f.rule.id, confidence: f.rule.confidence, evidence: f.evidence, weightTokens: f.weightTokens })),
    ...(context ? { context } : {}),
  }, null, 2));
} else {
  console.log(formatReport(findings, sessions, warnings));
  if (context) console.log(`\n${formatContext(context, contextFile)}`);
}
