# claude-lean Core Doctor Implementation Plan (Plan 1 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working `lean doctor` that streams Claude Code transcripts, de-duplicates requests, evaluates 9 transcript-based rules, and prints a ranked report.

**Architecture:** `summarize.js` turns one transcript into a small summary object. `metrics.js` holds a few generic metric functions. Rules are JSON files that name a metric and its parameters, so adding a cause is adding a file. `rules.js` loads and evaluates, `report.js` formats, `bin/lean.js` wires the CLI.

**Tech Stack:** Node >= 18, ES modules, zero runtime dependencies, `node:test`.

**Scope note:** The spec (`docs/superpowers/specs/2026-11-14-claude-lean-design.md`) covers three independent subsystems. This is Plan 1: core + transcript rules. Plan 2: config rules + `lean fix`. Plan 3: guard plugin (hooks) + `lean share` + README. Each ends in working software.

**Transcript facts this plan relies on (verified on real files):**
- One JSONL line per content block; one API response spans several lines sharing `message.id` and identical `usage`. Real request count = distinct `message.id` (871 vs 2194 lines in one real session).
- Assistant lines: `type:"assistant"`, `timestamp` (ISO), `version`, `message.{id,model,usage,content[]}`; `usage` has `input_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`, `output_tokens`.
- Tool calls: `message.content[]` items `{type:"tool_use", id, name, input}`. Results: `type:"user"`, `message.content[]` items `{type:"tool_result", tool_use_id, content}` where `content` is a string or an array that may contain `{type:"image", source:{data}}`.

---

## File structure

```
claude-lean/
  package.json
  .gitignore
  bin/lean.js            # CLI entry: `lean doctor`
  src/summarize.js       # transcript -> session summary (streaming, de-duplicating)
  src/metrics.js         # generic metric functions used by rules
  src/rules.js           # load + validate rules/*.json, evaluate against sessions
  src/report.js          # findings -> text report
  rules/*.json           # 9 rules
  test/helpers.js        # synthetic transcript/session builders
  test/summarize.test.js
  test/metrics.test.js
  test/rules.test.js
  test/cli.test.js
```

---

### Task 1: Scaffold

**Files:**
- Create: `package.json`, `.gitignore`

- [ ] **Step 1: Write `package.json`**

```json
{
  "name": "claude-lean",
  "version": "0.1.0",
  "description": "Find and fix what makes Claude Code burn your usage limit",
  "type": "module",
  "bin": { "lean": "bin/lean.js" },
  "engines": { "node": ">=18" },
  "scripts": { "test": "node --test" },
  "license": "MIT"
}
```

- [ ] **Step 2: Write `.gitignore`**

```
node_modules/
*.log
```

- [ ] **Step 3: Verify the test runner works with no tests**

Run: `npm test`
Expected: exits 0 (`tests 0`).

- [ ] **Step 4: Commit**

```bash
git add package.json .gitignore
git commit -m "chore: scaffold claude-lean package" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Test helpers and `summarize.js`

**Files:**
- Create: `test/helpers.js`, `test/summarize.test.js`, `src/summarize.js`

- [ ] **Step 1: Write `test/helpers.js`**

```js
let seq = 0;
const iso = (ms) => new Date(ms).toISOString();

export function assistantLine({ id = `m${++seq}`, cr = 0, cc = 0, input = 0, out = 1, at = 0, model = 'claude-sonnet-5-5', content = [] } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: iso(at), version: '2.1.300',
    message: { id, model, usage: { input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: out }, content },
  });
}

export const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

export function toolResultLine(toolUseId, content) {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
}

export const imageBlock = (b64len) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(b64len) } });

// A request as produced by summarize.js (for metric tests).
export const req = (ctx, o = {}) => ({ ctx, cc: 0, cr: 0, out: 0, model: 'claude-sonnet-5-5', ts: null, gapMs: null, ...o });

// A session summary as produced by summarize.js (for metric tests).
export const sess = (requests, o = {}) => ({
  file: 'x.jsonl', requests, firstCtx: requests[0]?.ctx ?? 0,
  screenshotCalls: 0, agentSpawns: 0, imageResults: 0, imageBytes: 0, toolVolume: {}, version: null, ...o,
});
```

- [ ] **Step 2: Write the failing tests `test/summarize.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLines } from '../src/summarize.js';
import { assistantLine, toolUse, toolResultLine, imageBlock } from './helpers.js';

test('lines sharing a message id count as one request, last usage wins', () => {
  const lines = [
    assistantLine({ id: 'a', cr: 100, out: 1, content: [{ type: 'text', text: 'hi' }] }),
    assistantLine({ id: 'a', cr: 100, out: 50, content: [toolUse('t1', 'Bash')] }),
    assistantLine({ id: 'b', cr: 200, at: 1000 }),
  ];
  const s = summarizeLines(lines, 'f.jsonl');
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[0].out, 50);
  assert.equal(s.firstCtx, 100);
});

test('ctx is input + cache_read + cache_creation and gapMs is time since previous request', () => {
  const lines = [
    assistantLine({ id: 'a', input: 5, cr: 100, cc: 10, at: 0 }),
    assistantLine({ id: 'b', cr: 300, at: 90_000 }),
  ];
  const s = summarizeLines(lines);
  assert.equal(s.requests[0].ctx, 115);
  assert.equal(s.requests[0].gapMs, null);
  assert.equal(s.requests[1].gapMs, 90_000);
});

test('counts agent spawns, screenshot calls and image results; ignores repeated tool_use ids', () => {
  const lines = [
    assistantLine({ id: 'a', content: [toolUse('t1', 'Agent'), toolUse('t2', 'mcp__claude-in-chrome__computer'), toolUse('t3', 'Bash')] }),
    assistantLine({ id: 'a', content: [toolUse('t1', 'Agent')] }),
    toolResultLine('t2', [imageBlock(400)]),
    toolResultLine('t3', 'plain text output'),
  ];
  const s = summarizeLines(lines);
  assert.equal(s.agentSpawns, 1);
  assert.equal(s.screenshotCalls, 1);
  assert.equal(s.imageResults, 1);
  assert.equal(s.imageBytes, 300);
  assert.equal(s.toolVolume.Bash.chars, 'plain text output'.length);
  assert.equal(s.toolVolume['mcp__claude-in-chrome__computer'].n, 1);
});

test('garbage and empty lines are skipped, version is captured', () => {
  const s = summarizeLines(['', 'not json', '{"type":"summary"}', assistantLine({ id: 'a' })]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.version, '2.1.300');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/summarize.js'`.

- [ ] **Step 4: Write `src/summarize.js`**

```js
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Every computer-use action returns a screenshot, so all calls to the tool count.
const SCREENSHOT_TOOL = /(__computer$|screenshot)/i;

export function createSummarizer(file = '') {
  const reqs = new Map();      // message id -> request (one API response spans many lines)
  const toolNames = new Map(); // tool_use id -> tool name
  const s = { file, toolVolume: {}, imageResults: 0, imageBytes: 0, screenshotCalls: 0, agentSpawns: 0, version: null };

  const bump = (name, chars) => {
    const t = (s.toolVolume[name] ??= { n: 0, chars: 0 });
    t.n++;
    t.chars += chars;
  };

  function push(line) {
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const m = o.message;
    if (!m) return;
    if (o.version) s.version = o.version;

    if (o.type === 'assistant') {
      if (m.usage) {
        const u = m.usage;
        reqs.set(m.id || o.requestId || o.uuid, {
          ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          cc: u.cache_creation_input_tokens || 0,
          cr: u.cache_read_input_tokens || 0,
          out: u.output_tokens || 0,
          model: m.model || '',
          ts: o.timestamp ? Date.parse(o.timestamp) : null,
        });
      }
      for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type !== 'tool_use' || toolNames.has(c.id)) continue;
        toolNames.set(c.id, c.name);
        if (c.name === 'Agent' || c.name === 'Task') s.agentSpawns++;
        if (SCREENSHOT_TOOL.test(c.name)) s.screenshotCalls++;
      }
    } else if (o.type === 'user' && Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type !== 'tool_result') continue;
        const parts = Array.isArray(c.content) ? c.content : [{ type: 'text', text: String(c.content ?? '') }];
        let chars = 0;
        for (const p of parts) {
          if (p.type === 'image') {
            s.imageResults++;
            s.imageBytes += Math.round((p.source?.data?.length || 0) * 0.75);
          } else {
            chars += (p.text || '').length;
          }
        }
        bump(toolNames.get(c.tool_use_id) || '?', chars);
      }
    }
  }

  function result() {
    const requests = [...reqs.values()];
    let prev = null;
    for (const r of requests) {
      r.gapMs = prev !== null && r.ts !== null ? r.ts - prev : null;
      prev = r.ts;
    }
    return { ...s, requests, firstCtx: requests[0]?.ctx ?? 0 };
  }

  return { push, result };
}

export function summarizeLines(lines, file = '') {
  const z = createSummarizer(file);
  for (const l of lines) z.push(l);
  return z.result();
}

export async function summarizeFile(path) {
  const z = createSummarizer(path);
  const rl = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const l of rl) z.push(l);
  return z.result();
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: 4 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add test/helpers.js test/summarize.test.js src/summarize.js
git commit -m "feat: streaming transcript summarizer with message-id de-duplication" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Metrics

**Files:**
- Create: `test/metrics.test.js`, `src/metrics.js`

- [ ] **Step 1: Write the failing tests `test/metrics.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { metrics } from '../src/metrics.js';
import { req, sess } from './helpers.js';

test('shareRequestsAboveCtx fires and weighs cache-read above the threshold', () => {
  const s = sess([req(100e3), req(600e3, { cr: 600e3 }), req(700e3, { cr: 700e3 })]);
  const r = metrics.shareRequestsAboveCtx([s], { above: 500e3, minShare: 0.5 });
  assert.equal(r.hit, true);
  assert.equal(r.weightTokens, 1300e3);
  assert.match(r.evidence, /67% of 3 requests ran above 500k/);
});

test('shareRequestsAboveCtx stays quiet below minShare and on no requests', () => {
  assert.equal(metrics.shareRequestsAboveCtx([sess([req(10e3), req(20e3)])], { above: 500e3, minShare: 0.1 }).hit, false);
  assert.equal(metrics.shareRequestsAboveCtx([], { above: 500e3, minShare: 0.1 }).hit, false);
});

test('medianFirstCtx uses the median of sessions with enough requests', () => {
  const long = (first) => sess(Array.from({ length: 20 }, (_, i) => req(i === 0 ? first : 1)));
  const short = sess([req(900e3)]);
  const r = metrics.medianFirstCtx([long(100e3), long(110e3), long(10e3), short], { above: 60e3, minRequests: 20 });
  assert.equal(r.hit, true);
  assert.match(r.evidence, /median first-request context is 100k tokens over 3 sessions/);
  assert.equal(metrics.medianFirstCtx([long(10e3)], { above: 60e3 }).hit, false);
});

test('cacheRebuilds separates idle rebuilds from mid-session rebuilds by gap', () => {
  const idle = req(200e3, { cc: 200e3, gapMs: 600_000 });
  const mid = req(200e3, { cc: 200e3, gapMs: 30_000 });
  const first = req(200e3, { cc: 200e3, gapMs: null });
  const small = req(10e3, { cc: 10e3, gapMs: 600_000 });
  const s = sess([first, idle, mid, small]);
  const idleHit = metrics.cacheRebuilds([s], { minTokens: 150e3, gapMinMs: 300_000, minCount: 1 });
  assert.equal(idleHit.hit, true);
  assert.equal(idleHit.weightTokens, 200e3);
  const midHit = metrics.cacheRebuilds([s], { minTokens: 150e3, gapMaxMs: 300_000, minCount: 1 });
  assert.equal(midHit.hit, true);
  assert.equal(midHit.weightTokens, 200e3);
  assert.equal(metrics.cacheRebuilds([s], { minTokens: 150e3, gapMinMs: 300_000, minCount: 2 }).hit, false);
});

test('maxPerSession fires when any session reaches the minimum', () => {
  const a = sess([req(1)], { screenshotCalls: 5 });
  const b = sess([req(1)], { screenshotCalls: 40 });
  const r = metrics.maxPerSession([a, b], { field: 'screenshotCalls', min: 30 });
  assert.equal(r.hit, true);
  assert.match(r.evidence, /1 of 2 sessions had >=30 screenshotCalls \(max 40\)/);
  assert.equal(metrics.maxPerSession([a], { field: 'screenshotCalls', min: 30 }).hit, false);
});

test('modelShare matches model names case-insensitively', () => {
  const s = sess([req(1, { model: 'claude-opus-5-5' }), req(1, { model: 'claude-opus-5-5' }), req(1, { model: 'claude-sonnet-5-5' })]);
  assert.equal(metrics.modelShare([s], { match: 'opus', minShare: 0.5 }).hit, true);
  assert.equal(metrics.modelShare([s], { match: 'opus', minShare: 0.9 }).hit, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/metrics.js'`.

- [ ] **Step 3: Write `src/metrics.js`**

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (4 summarize + 6 metrics).

- [ ] **Step 5: Commit**

```bash
git add test/metrics.test.js src/metrics.js
git commit -m "feat: generic metric functions for rules" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Rule loader and the 9 rules

**Files:**
- Create: `test/rules.test.js`, `src/rules.js`, `rules/ctx-300k.json`, `rules/ctx-500k.json`, `rules/overhead-high.json`, `rules/cache-idle-rebuild.json`, `rules/cache-buster.json`, `rules/image-read-big.json`, `rules/screenshot-loop.json`, `rules/subagent-spawns.json`, `rules/opus-default.json`

(That is 9 files: `ctx-300k` and `ctx-500k` are separate rules, matching the spec's `ctx-300k / ctx-500k` row.)

- [ ] **Step 1: Write the failing tests `test/rules.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRules, evaluate } from '../src/rules.js';
import { req, sess } from './helpers.js';

test('shipped rules all load, have unique ids and a valid confidence tag', () => {
  const rules = loadRules();
  assert.equal(rules.length, 9);
  assert.equal(new Set(rules.map((r) => r.id)).size, rules.length);
  for (const r of rules) assert.ok(['official', 'measured', 'unverified'].includes(r.confidence), r.id);
});

test('loadRules rejects a rule that names an unknown metric', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-rules-'));
  writeFileSync(join(dir, 'bad.json'), JSON.stringify({
    id: 'bad', title: 't', source: 's', confidence: 'measured', detect: { metric: 'nope' }, fix: { type: 'advice', text: 'x' },
  }));
  assert.throws(() => loadRules(dir), /bad rule bad\.json/);
});

test('evaluate returns only hits, heaviest first', () => {
  const huge = sess(Array.from({ length: 10 }, () => req(800e3, { cr: 800e3 })), { screenshotCalls: 99 });
  const ids = evaluate(loadRules(), [huge]).map((f) => f.rule.id);
  assert.ok(ids.includes('ctx-300k') && ids.includes('ctx-500k') && ids.includes('screenshot-loop'));
  assert.ok(ids.indexOf('ctx-500k') < ids.indexOf('screenshot-loop'), 'weighted findings sort before unweighted');
});

test('a healthy session produces no findings', () => {
  const ok = sess(Array.from({ length: 30 }, () => req(40e3, { cr: 40e3 })));
  assert.deepEqual(evaluate(loadRules(), [ok]), []);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/rules.js'`.

- [ ] **Step 3: Write `src/rules.js`**

```js
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
```

- [ ] **Step 4: Write the 9 rule files**

`rules/ctx-300k.json`
```json
{
  "id": "ctx-300k",
  "title": "Context grew past 300k tokens",
  "source": "measured on transcripts; https://code.claude.com/docs/en/costs (history is resent on every request)",
  "confidence": "official",
  "detect": { "metric": "shareRequestsAboveCtx", "above": 300000, "minShare": 0.25 },
  "fix": { "type": "advice", "text": "Run /clear between unrelated tasks and /compact at about 150k while the cache is still warm. Every tool call is another request that re-reads the whole context." }
}
```

`rules/ctx-500k.json`
```json
{
  "id": "ctx-500k",
  "title": "Context grew past 500k tokens",
  "source": "measured on transcripts; https://code.claude.com/docs/en/costs",
  "confidence": "official",
  "detect": { "metric": "shareRequestsAboveCtx", "above": 500000, "minShare": 0.1 },
  "fix": { "type": "advice", "text": "Start a fresh session (/clear) for each task. Sessions this large spend almost all their tokens re-reading old history." }
}
```

`rules/overhead-high.json`
```json
{
  "id": "overhead-high",
  "title": "Fixed overhead before your first prompt is large",
  "source": "measured: context of the first request in each session; https://code.claude.com/docs/en/costs",
  "confidence": "measured",
  "detect": { "metric": "medianFirstCtx", "above": 60000, "minRequests": 20 },
  "fix": { "type": "advice", "text": "Run /context to see what fills the window. Common causes: many enabled plugins (skill descriptions), long CLAUDE.md or memory index, hooks that print text every turn. Disable what you do not use." }
}
```

`rules/cache-idle-rebuild.json`
```json
{
  "id": "cache-idle-rebuild",
  "title": "Cache rebuilt after an idle gap",
  "source": "measured; https://code.claude.com/docs/en/prompt-caching (cache TTL depends on plan: 5 min or 1 hour)",
  "confidence": "official",
  "detect": { "metric": "cacheRebuilds", "minTokens": 150000, "gapMinMs": 300000, "minCount": 3 },
  "fix": { "type": "advice", "text": "After a break longer than the cache TTL, the next prompt re-writes the whole context. Use /clear after breaks instead of continuing a huge session; check promptCacheTtl for your plan." }
}
```

`rules/cache-buster.json`
```json
{
  "id": "cache-buster",
  "title": "Cache rebuilt mid-session with no idle gap",
  "source": "measured; https://code.claude.com/docs/en/prompt-caching (model, effort, fast mode, MCP and plugin changes invalidate the cache)",
  "confidence": "official",
  "detect": { "metric": "cacheRebuilds", "minTokens": 150000, "gapMaxMs": 300000, "minCount": 2 },
  "fix": { "type": "advice", "text": "Large rebuilds right after a request usually come from /model, effort or fast-mode changes, MCP or plugin toggles, or compaction. Make those changes at session start." }
}
```

`rules/image-read-big.json`
```json
{
  "id": "image-read-big",
  "title": "Many image results in one session",
  "source": "measured on transcripts; each image stays in context and is re-read on every later request",
  "confidence": "measured",
  "detect": { "metric": "maxPerSession", "field": "imageResults", "min": 10 },
  "fix": { "type": "advice", "text": "Take one screenshot per check, crop or use a small viewport, and do not Read full-page PNGs. Start a fresh session when the visual work is done." }
}
```

`rules/screenshot-loop.json`
```json
{
  "id": "screenshot-loop",
  "title": "Screenshot/scroll loop in a browser session",
  "source": "measured on transcripts (computer-use calls each return a screenshot)",
  "confidence": "measured",
  "detect": { "metric": "maxPerSession", "field": "screenshotCalls", "min": 30 },
  "fix": { "type": "advice", "text": "Use find or read_page instead of scroll-and-screenshot, and keep browser automation in its own short session." }
}
```

`rules/subagent-spawns.json`
```json
{
  "id": "subagent-spawns",
  "title": "Many subagent spawns in one session",
  "source": "measured; https://code.claude.com/docs/en/costs (subagent requests count against usage)",
  "confidence": "official",
  "detect": { "metric": "maxPerSession", "field": "agentSpawns", "min": 20 },
  "fix": { "type": "advice", "text": "Spawn subagents only for real parallel work. Each one starts cold and re-derives context; give simple work a smaller model." }
}
```

`rules/opus-default.json`
```json
{
  "id": "opus-default",
  "title": "Most requests used an Opus model",
  "source": "https://code.claude.com/docs/en/costs; issue anthropics/claude-code#27665",
  "confidence": "official",
  "detect": { "metric": "modelShare", "match": "opus", "minShare": 0.5 },
  "fix": { "type": "advice", "text": "Use /model to switch routine work to Sonnet and keep Opus for hard reasoning." }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (4 + 6 + 4).

- [ ] **Step 6: Commit**

```bash
git add test/rules.test.js src/rules.js rules/
git commit -m "feat: rule loader and the 9 transcript rules" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Report and CLI

**Files:**
- Create: `src/report.js`, `bin/lean.js`, `test/cli.test.js`

- [ ] **Step 1: Write the failing test `test/cli.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assistantLine } from './helpers.js';

const fixture = () => {
  const lines = Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000 }));
  const file = join(mkdtempSync(join(tmpdir(), 'lean-cli-')), 's.jsonl');
  writeFileSync(file, lines.join('\n'));
  return file;
};
const run = (...args) => execFileSync(process.execPath, ['bin/lean.js', 'doctor', ...args], { encoding: 'utf8' });

test('doctor prints a ranked text report', () => {
  const out = run('--file', fixture());
  assert.match(out, /claude-lean doctor: 1 sessions, 30 requests/);
  assert.match(out, /1\. \[official\] Context grew past 300k tokens/);
  assert.match(out, /found: 100% of 30 requests ran above 300k context/);
  assert.match(out, /fix: /);
});

test('doctor --json is machine readable', () => {
  const j = JSON.parse(run('--file', fixture(), '--json'));
  assert.equal(j.sessions, 1);
  assert.equal(j.requests, 30);
  assert.ok(j.findings.some((f) => f.id === 'ctx-300k' && f.confidence === 'official'));
});

test('unknown command exits non-zero with usage', () => {
  assert.throws(() => execFileSync(process.execPath, ['bin/lean.js', 'nope'], { stdio: 'pipe' }), /usage: lean doctor/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL, cli tests error (`Cannot find module .../bin/lean.js`).

- [ ] **Step 3: Write `src/report.js`**

```js
export function formatReport(findings, sessions) {
  const requests = sessions.reduce((t, s) => t + s.requests.length, 0);
  const out = [`claude-lean doctor: ${sessions.length} sessions, ${requests} requests`, ''];
  if (!findings.length) out.push('No known causes found.', '');
  findings.forEach((f, i) => {
    out.push(
      `${i + 1}. [${f.rule.confidence}] ${f.rule.title}`,
      `   found:  ${f.evidence}`,
      `   fix:    ${f.rule.fix.text}`,
      `   source: ${f.rule.source}`,
      '',
    );
  });
  out.push('Token counts come from the usage fields in your transcripts. Local data only; nothing is sent anywhere.');
  return out.join('\n');
}
```

- [ ] **Step 4: Write `bin/lean.js`**

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (17 total).

- [ ] **Step 6: Commit**

```bash
git add src/report.js bin/lean.js test/cli.test.js
git commit -m "feat: lean doctor CLI and text/JSON report" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Acceptance on real transcripts

**Files:** none created. This verifies the spec acceptance criteria on a real Claude Code history (the reference run used two real sessions of 871 and 551 requests).

- [ ] **Step 1: Run on one real transcript**

Run: `node bin/lean.js doctor --json --file <path to a large session .jsonl under ~/.claude/projects/>`
Expected: `requests` equals the number of distinct `message.id` values in the file (not the number of assistant lines); a `ctx-500k` finding whose percentage matches a manual count of requests with context above 500k; `overhead-high` whose value equals the first request context.

- [ ] **Step 2: Run the text report on the whole history and read it**

Run: `node bin/lean.js doctor`
Expected: a ranked report, `ctx-300k` / `ctx-500k` first when sessions are large, each finding with `found:`, `fix:`, `source:`. If a number disagrees with the manual count, debug `summarize.js` before continuing; do not edit the expected numbers.

- [ ] **Step 3: Commit**

```bash
git commit --allow-empty -m "test: acceptance verified on real transcripts"
```

---

## Self-review (against the spec)

- **Summary object / de-dup / streaming / fail-soft:** Task 2 (garbage lines skipped; unsupported-format warning is not implemented, noted for Plan 2).
- **Rule format and catalog:** Tasks 3-4 cover the 9 transcript-detectable seed rules (`ctx-300k`, `ctx-500k`, `overhead-high`, `cache-idle-rebuild`, `cache-buster`, `image-read-big`, `screenshot-loop`, `subagent-spawns`, `opus-default`). The remaining ~21 config/env/heuristic rules, `models` filtering, `lean fix` with backup and `--dry-run`: **Plan 2**.
- **Doctor output ranked with confidence tags, `--json`:** Task 5. Server-side-drain note: Plan 2.
- **Guards, `lean share`, README, license file:** **Plan 3**.
- **Privacy:** Task 5 report states local-only; the summary keeps only aggregates (no paths/commands/text).
- **Acceptance:** Task 6 (numbers corrected to the de-duplicated counts).
- **Placeholder scan:** none. **Name consistency:** `summarizeLines/summarizeFile/createSummarizer`, `loadRules/evaluate`, `formatReport`, metric names `shareRequestsAboveCtx/medianFirstCtx/cacheRebuilds/maxPerSession/modelShare` are identical across tasks and rule JSON.
- **Known gaps carried to Plan 2:** "unsupported transcript format" warning; per-rule `models` filter.
