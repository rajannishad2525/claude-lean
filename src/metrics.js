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

  hookInjection(sessions, { above, events }) {
    const per = sessions.map((s) => sum(events, (e) => s.hookChars?.[e] ?? 0) / 3.6);
    const total = sum(per, (x) => x);
    const mean = per.length ? total / per.length : 0;
    return {
      hit: per.length > 0 && mean > above,
      weightTokens: Math.round(total),
      evidence: `hook output adds ~${Math.round(mean / 1000)}k tokens per session on average (${events.join(' + ')}; estimate from characters)`,
    };
  },
};
