import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metrics } from './metrics.js';

export const RULES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'rules');
export const EDIT_OPS = ['setKey', 'setEnv', 'removeEnv', 'disablePlugin'];

export function loadRules(dir = RULES_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      const r = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const ok = r.id && r.title && r.source && r.confidence && r.fix?.text && r.detect && metrics[r.detect.metric]
        && (r.fix.type !== 'settings' || EDIT_OPS.includes(r.fix.edit?.op))
        && (r.models === undefined || (Array.isArray(r.models) && r.models.every((m) => typeof m === 'string')));
      if (!ok) throw new Error(`bad rule ${f}`);
      return r;
    });
}

// models: ["*"] (default) or substrings of a model name. Requests of other models are ignored;
// a rule with no matching request at all is skipped.
function scope(rule, sessions) {
  if (!rule.models || rule.models.includes('*')) return sessions;
  const want = rule.models.map((m) => m.toLowerCase());
  const scoped = sessions
    .map((s) => ({ ...s, requests: s.requests.filter((r) => want.some((m) => r.model.toLowerCase().includes(m))) }))
    .filter((s) => s.requests.length);
  return scoped.length ? scoped : null;
}

export function evaluate(rules, sessions, config = null) {
  return rules
    .map((rule) => {
      const scoped = scope(rule, sessions);
      if (!scoped) return { hit: false };
      const { metric, ...params } = rule.detect;
      return { rule, ...metrics[metric](scoped, params, config) };
    })
    .filter((f) => f.hit)
    .sort((a, b) => b.weightTokens - a.weightTokens || a.rule.id.localeCompare(b.rule.id));
}
