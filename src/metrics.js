const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
const allRequests = (sessions) => sessions.flatMap((s) => s.requests);
const pct = (x) => Math.round(x * 100);
const mtok = (n) => `${Math.round(n / 1e6)}M`;
const NO_CONFIG = { hit: false, weightTokens: 0, evidence: 'no config available' };
const needsConfig = (fn) => (sessions, params, config) => (config ? fn(config, params) : NO_CONFIG);
const truthy = (v) => ![undefined, null, false, 0, '', '0', 'false'].includes(v);

// Each metric: (sessions, params, config) -> { hit, weightTokens, evidence, targets? }.
// weightTokens ranks findings; 0 means "no cheap token estimate" (ponytail: such
// findings sort last; add real weights if ranking proves misleading).
export const metrics = {
  shareRequestsAboveCtx(sessions, { above, minShare }) {
    const reqs = allRequests(sessions);
    const hi = reqs.filter((r) => r.ctx > above);
    const share = reqs.length ? hi.length / reqs.length : 0;
    const weightTokens = sum(hi, (r) => r.cr);
    return {
      hit: reqs.length > 0 && share >= minShare,
      weightTokens,
      evidence: `${pct(share)}% of ${reqs.length} requests ran above ${above / 1000}k context (${mtok(weightTokens)} cache-read tokens there)`,
    };
  },

  medianFirstCtx(sessions, { above, minRequests = 20 }) {
    const v = sessions.filter((s) => s.requests.length >= minRequests).map((s) => s.firstCtx).sort((a, b) => a - b);
    const med = v.length ? v[Math.floor(v.length / 2)] : 0;
    return {
      hit: v.length > 0 && med > above,
      weightTokens: 0,
      evidence: `median first-request context is ${Math.round(med / 1000)}k tokens over ${v.length} sessions (limit ${above / 1000}k)`,
    };
  },

  cacheRebuilds(sessions, { minTokens, gapMinMs = 0, gapMaxMs = Infinity, minCount }) {
    const hits = allRequests(sessions).filter(
      (r) => r.cc >= minTokens && r.gapMs !== null && r.gapMs >= gapMinMs && r.gapMs < gapMaxMs,
    );
    const weightTokens = sum(hits, (r) => r.cc);
    return {
      hit: hits.length >= minCount,
      weightTokens,
      evidence: `${hits.length} cache rebuilds of >=${minTokens / 1000}k tokens (${mtok(weightTokens)} tokens written)`,
    };
  },

  maxPerSession(sessions, { field, min }) {
    const over = sessions.filter((s) => s[field] >= min);
    const max = Math.max(0, ...sessions.map((s) => s[field]));
    return {
      hit: over.length > 0,
      weightTokens: 0,
      evidence: `${over.length} of ${sessions.length} sessions had >=${min} ${field} (max ${max})`,
    };
  },

  modelShare(sessions, { match, minShare }) {
    const reqs = allRequests(sessions);
    const n = reqs.filter((r) => r.model.toLowerCase().includes(match.toLowerCase())).length;
    const share = reqs.length ? n / reqs.length : 0;
    return {
      hit: reqs.length > 0 && share >= minShare,
      weightTokens: 0,
      evidence: `${pct(share)}% of ${reqs.length} requests used a ${match} model`,
    };
  },

  configAtLeast: needsConfig((config, { field, min }) => {
    const v = config.facts[field] ?? 0;
    return { hit: v >= min, weightTokens: 0, evidence: `${field} is ${v} (limit ${min})` };
  }),

  duplicatePlugins: needsConfig((config) => {
    const targets = config.duplicates.flatMap((ids) => ids.slice(1));
    const names = config.duplicates.map((ids) => ids[0].split('@')[0]).join(', ');
    return { hit: targets.length > 0, weightTokens: 0, targets, evidence: `${config.duplicates.length} plugin names enabled from more than one marketplace: ${names}` };
  }),

  // when: absent (no such key), present (a truthy value), notFalse (not explicitly set to false)
  settingState: needsConfig((config, { source, key, prefix = false, when }) => {
    const bag = source === 'env' ? config.env : config.settings;
    const keys = Object.keys(bag).filter((k) => (prefix ? k.startsWith(key) : k === key));
    const hit = when === 'absent' ? keys.length === 0
      : when === 'present' ? keys.some((k) => truthy(bag[k]))
      : !keys.some((k) => bag[k] === false);
    const targets = when === 'present' ? keys.filter((k) => truthy(bag[k])) : keys;
    return { hit, weightTokens: 0, targets, evidence: `${source} ${key}${prefix ? '*' : ''} is ${when === 'notFalse' ? 'not set to false' : when}` };
  }),

  hookInjection(sessions, { above, events }, config) {
    const per = sessions.map((s) => sum(events, (e) => s.hookChars?.[e] ?? 0) / 3.6);
    const total = sum(per, (x) => x);
    const mean = per.length ? total / per.length : 0;
    const hit = per.length > 0 && mean > above;
    let evidence = `hook output adds ~${Math.round(mean / 1000)}k tokens per session on average (${events.join(' + ')}; estimate from characters)`;
    if (hit) {
      const byOwner = new Map();
      for (const s of sessions) {
        for (const e of events) {
          for (const [cmd, n] of Object.entries(s.hookByCommand?.[e] ?? {})) {
            const owner = config?.hookOwners?.get(cmd) ?? 'unknown source';
            byOwner.set(owner, (byOwner.get(owner) ?? 0) + n);
          }
        }
      }
      const all = sum([...byOwner.values()], (x) => x) || 1;
      const top = [...byOwner].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([o, n]) => `${o} ${pct(n / all)}%`).join(', ');
      if (top) evidence += `; biggest sources: ${top}`;
    }
    return { hit, weightTokens: Math.round(total), evidence };
  },

  compactCold(sessions, { minTokens, gapMinMs, minCount }) {
    const hits = sessions.flatMap((s) => s.compactions ?? []).filter((c) => c.preTokens >= minTokens && c.gapMs !== null && c.gapMs >= gapMinMs);
    const weightTokens = sum(hits, (c) => c.preTokens);
    return {
      hit: hits.length >= minCount,
      weightTokens,
      evidence: `${hits.length} compactions of >=${minTokens / 1000}k tokens ran after an idle gap of >=${Math.round(gapMinMs / 60000)} min (${Math.round(weightTokens / 1000)}k tokens summarized without a warm cache)`,
    };
  },

  mcpPersistent(sessions, { minSessions }) {
    // Startup timeouts are often intermittent, so a server that connected in ANY analysed session is not a dead server.
    const connected = new Set(sessions.flatMap((s) => s.mcpConnected ?? []));
    const counts = new Map();
    for (const s of sessions) for (const name of s.failedMcpNames ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
    const targets = [...counts]
      .filter(([name, c]) => c >= minSessions && !connected.has(name.replace(/[^a-zA-Z0-9_-]/g, '_')))
      .map(([name]) => name)
      .sort();
    return { hit: targets.length > 0, weightTokens: 0, targets, evidence: `${targets.length} MCP server(s) failed to connect in at least ${minSessions} sessions and never connected in any analysed session` };
  },

  thinkingShare(sessions, { minTokens, minShare }) {
    const reqs = allRequests(sessions);
    const est = sum(reqs.filter((r) => r.thinking), (r) => Math.max(0, r.out - r.visible / 3.6));
    const out = sum(reqs, (r) => r.out);
    const share = out ? est / out : 0;
    return {
      hit: est >= minTokens && share >= minShare,
      weightTokens: Math.round(est),
      evidence: `~${Math.round(est / 1000)}k of ${Math.round(out / 1000)}k output tokens look like hidden thinking (${pct(share)}%; estimate from output size)`,
    };
  },
};
