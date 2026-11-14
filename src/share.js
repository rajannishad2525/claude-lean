import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const r2 = (x) => Math.round(x * 100) / 100;
const lineBucket = (n) => (n === 0 ? '0' : n <= 100 ? '1-100' : n <= 200 ? '101-200' : '>200');

// Counts, shares and rule ids only. No paths, commands, text, plugin names, env names or dates.
// Evidence strings are deliberately not copied: some name plugins from your own settings.
export function buildShare(sessions, config, findings) {
  const reqs = sessions.flatMap((s) => s.requests);
  const n = reqs.length || 1;
  const above = (t) => r2(reqs.filter((r) => r.ctx > t).length / n);
  const rebuilds = (lo, hi) => {
    const hit = reqs.filter((r) => r.cc >= 150000 && r.gapMs !== null && r.gapMs >= lo && r.gapMs < hi);
    return { count: hit.length, mtok: r2(hit.reduce((t, r) => t + r.cc, 0) / 1e6) };
  };
  const family = (m) => r2(reqs.filter((r) => r.model.toLowerCase().includes(m)).length / n);
  const maxOf = (field) => Math.max(0, ...sessions.map((s) => s[field]));
  const firsts = sessions.filter((s) => s.requests.length >= 20).map((s) => s.firstCtx).sort((a, b) => a - b);
  const hookChars = sessions.reduce((t, s) => t + Object.values(s.hookChars).reduce((a, b) => a + b, 0), 0);

  return {
    schema: 1,
    tool: 'claude-lean',
    toolVersion: version,
    sessions: sessions.length,
    requests: reqs.length,
    shareAbove300k: above(300000),
    shareAbove500k: above(500000),
    cacheRebuilds: { idle: rebuilds(300000, Infinity), midSession: rebuilds(0, 300000) },
    medianFirstCtxK: firsts.length ? Math.round(firsts[Math.floor(firsts.length / 2)] / 1000) : 0,
    hookTokensPerSessionK: sessions.length ? Math.round(hookChars / 3.6 / sessions.length / 1000) : 0,
    maxPerSession: { imageResults: maxOf('imageResults'), screenshotCalls: maxOf('screenshotCalls'), agentSpawns: maxOf('agentSpawns'), mcpFailures: maxOf('mcpFailures') },
    modelShare: { opus: family('opus'), sonnet: family('sonnet'), haiku: family('haiku'), fable: family('fable') },
    config: {
      pluginCount: config.facts.pluginCount,
      duplicatePluginCount: config.facts.duplicatePluginCount,
      claudeMdLines: lineBucket(config.facts.claudeMdLines),
      memoryIndexKB: Math.round(config.facts.memoryIndexBytes / 1024),
    },
    findings: findings.map((f) => ({ id: f.rule.id, confidence: f.rule.confidence, weightMtok: r2(f.weightTokens / 1e6) })),
  };
}
