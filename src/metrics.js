const sum = (a, f) => a.reduce((t, x) => t + f(x), 0);
const allRequests = (sessions) => sessions.flatMap((s) => s.requests);
const pct = (x) => Math.round(x * 100);
const mtok = (n) => `${Math.round(n / 1e6)}M`;

// Each metric: (sessions, params) -> { hit, weightTokens, evidence }.
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
};
