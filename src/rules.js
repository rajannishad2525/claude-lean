import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metrics } from './metrics.js';

export const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');

export function loadRules(dir = RULES_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const ok = r.id && r.title && r.source && r.confidence && r.fix?.text && r.detect && metrics[r.detect.metric];
      if (!ok) throw new Error(`bad rule ${f}`);
      return r;
    });
}

export function evaluate(rules, sessions) {
  return rules
    .map((rule) => {
      const { metric, ...params } = rule.detect;
      return { rule, ...metrics[metric](sessions, params) };
    })
    .filter((f) => f.hit)
    .sort((a, b) => b.weightTokens - a.weightTokens || a.rule.id.localeCompare(b.rule.id));
}
