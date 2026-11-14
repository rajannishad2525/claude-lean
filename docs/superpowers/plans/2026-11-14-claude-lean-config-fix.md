# claude-lean Config Rules + `lean fix` Implementation Plan (Plan 2 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the 14 config/env/hook-detectable rules, a `lean fix` command that edits `settings.json` safely, per-rule model filtering, and an "unsupported transcript format" warning.

**Architecture:** A new `src/config.js` reads settings/env/CLAUDE.md/MEMORY.md facts once. Metrics get an optional third argument (`config`); config metrics return "no hit" when it is absent, so Plan 1 tests keep working. Rules stay JSON. A rule whose `fix.type` is `settings` carries an `edit` descriptor (`op` + values); `src/fix.js` turns findings into a pure plan, and only `--apply` writes (after a timestamped backup).

**Tech Stack:** Node >= 18, ES modules, zero runtime dependencies, `node:test`.

**Scope note:** Plan 1 (done): core doctor + 9 transcript rules. This is Plan 2. Plan 3 (separate session): guard hooks, `lean share`, license decisions.

**Invariants this plan must not break:**
- **One API response = many transcript lines.** Requests are de-duplicated by `message.id` (Plan 1). Every *new* counter in this plan (hook output, MCP failures) is keyed by line `uuid`, so a repeated or resumed-session line is counted once and extra lines of one response never inflate counts. Task 2 tests this explicitly.
- **Privacy (repo is public).** No real paths, names or emails in code, tests, docs or commit messages. Tests use `os.tmpdir()` dirs and fake settings only. Docs say `~/.claude`.
- **Never guess a settings key as fact.** Every new rule ships `confidence: "unverified"` with a source that says so. Task 9 upgrades a rule to `official` only after the key is found in docs that were actually fetched. `lean fix` refuses to write keys of unverified rules unless `--include-unverified` is passed.

**Known deviations from the request (flag at approval):**
- `lean fix` edits **plugins (`enabledPlugins`) and named settings/env keys**. **MCP and hook enablement stay advice-only**: a transcript does not reliably say *which* server failed or *which* hook command printed the text, and removing the wrong one is the worst failure a fixer can have. Task 1 checks what the real transcripts expose; if they do carry a name, add `disableMcp` / `disableHook` ops in a follow-up.
- Only user-level `settings.json` is ever written. Project-level settings are read for detection and reported as "manual" when a fix would need them.
- No shipped rule needs a `models` filter yet (`thinking-heavy` will). The mechanism and tests are in, exercised with synthetic rules.

---

## File structure

```
src/config.js          # NEW  read settings (layered), env, plugins, CLAUDE.md/MEMORY.md facts
src/fix.js             # NEW  planFix (pure) + applyFix (backup + write)
src/summarize.js       # MOD  hook output, MCP failures, unsupported flag, uuid de-dup of non-assistant lines
src/metrics.js         # MOD  config metrics + hookInjection; 3rd arg `config`
src/rules.js           # MOD  validate `models` and `fix.edit`; models scoping; pass config
src/report.js          # MOD  warnings, "no supported transcripts", fixable marker
bin/lean.js            # MOD  `lean fix`, --claude-dir, warnings
rules/*.json           # +14 rules
test/helpers.js        # MOD  new builders (hookLine, mcpFailLine, cfg), sess defaults
test/config.test.js    # NEW
test/fix.test.js       # NEW
test/summarize.test.js, test/metrics.test.js, test/rules.test.js, test/cli.test.js   # MOD
README.md              # MOD
```

---

### Task 1: Check what real transcripts expose (no repo change)

The hook-output and MCP-failure counters rely on assumed line shapes. Look at the real shapes first, without printing any content.

**Files:** none in the repo. The script lives in the session scratchpad / a temp dir.

- [ ] **Step 1: Write a shape probe outside the repo** (`shapes.mjs` in a temp dir). It prints only type names, key names and counts.

```js
import { createReadStream, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const root = join(homedir(), '.claude', 'projects');
const c = {};
const bump = (k) => (c[k] = (c[k] || 0) + 1);
for (const d of readdirSync(root)) {
  for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith('.jsonl'))) {
    const rl = createInterface({ input: createReadStream(join(root, d, f)) });
    for await (const l of rl) {
      let o; try { o = JSON.parse(l); } catch { continue; }
      bump(`type=${o.type}`);
      if (o.type === 'attachment') bump(`attachment.type=${o.attachment?.type} keys=${Object.keys(o.attachment || {}).sort().join(',')}`);
      if (o.type === 'system') bump(`system subtype=${o.subtype} keys=${Object.keys(o).sort().join(',')}`);
      if (o.type === 'system' && /mcp/i.test(JSON.stringify(o))) bump('system-line-mentions-mcp');
    }
  }
}
console.log(c);
```

- [ ] **Step 2: Run it**

Run: `node <temp dir>/shapes.mjs`
Expected: a count table. Look for (a) `attachment.type=hook_*` entries and which of `hookEvent`, `hookName`, `stdout`, `content`, `command` are in their keys; (b) whether any `system` line mentions MCP failures.

- [ ] **Step 3: Decision gate**
  - Hook lines match the assumption (`type:"attachment"`, `attachment.type` starting `hook_`, an event name in `hookEvent` or `hookName`, text in `stdout` or `content`): continue unchanged.
  - Different shape: change only `HOOK_TEXT`/`hookEvent` access in Task 2 Step 4 and the `hookLine` helper in Step 1 to match, then continue.
  - No MCP failure lines exist in the history: keep the `mcp-failing` rule (synthetic test only), keep it `unverified`, and say so in the final report.
  - If a hook/MCP line carries a command or server **name**, note it for the follow-up, do not use it now.

No commit.

**Result (executed):** hook lines match (`hook_success`, keys `hookEvent`, `hookName`, `stdout`, `content`, `command`; `stdout` and `content` differ, so only `stdout ?? content` of `hook_success` is counted, never the other `hook_*` types). MCP failures are not system lines: they are `attachment.type=deferred_tools_delta` with `failedMcpServers` (array of objects, re-listed across deltas), so Task 2 counts distinct failed servers per session. Hook lines carry a `command`; MCP entries carry server objects. Both are names the transcript *does* expose, so `disableMcp` / `disableHook` ops are feasible in a follow-up; still not used here.

---

### Task 2: Summarizer: hook output, MCP failures, unsupported flag

**Files:**
- Modify: `test/helpers.js`, `test/summarize.test.js`, `src/summarize.js`

- [ ] **Step 1: Extend `test/helpers.js`**

Replace the `sess` helper's defaults and append the new builders (keep everything else):

```js
// A session summary as produced by summarize.js (for metric tests).
export const sess = (requests, o = {}) => ({
  file: 'x.jsonl', requests, firstCtx: requests[0]?.ctx ?? 0,
  screenshotCalls: 0, agentSpawns: 0, imageResults: 0, imageBytes: 0, toolVolume: {}, version: null,
  hookChars: {}, mcpFailures: 0, unsupported: false, ...o,
});

export const hookLine = (event, chars, uuid = `h${++seq}`) =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'hook_success', hookEvent: event, content: 'x'.repeat(chars) } });

// Real shape (Task 1 probe): attachment deferred_tools_delta with failedMcpServers = array of objects,
// re-listed across deltas within a session.
export const mcpFailLine = (uuid = `s${++seq}`, servers = [{ name: 'demo' }]) =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'deferred_tools_delta', failedMcpServers: servers } });

// A config object as produced by config.js (for metric/rule tests). Override any field.
export const cfg = (o = {}) => ({
  settings: {}, userSettings: {}, userSettingsPath: 'settings.json', userSettingsError: false,
  env: {}, plugins: [], duplicates: [],
  facts: { pluginCount: 0, duplicatePluginCount: 0, claudeMdLines: 0, memoryIndexBytes: 0 },
  ...o,
});
```

- [ ] **Step 2: Add failing tests to `test/summarize.test.js`**

Add `hookLine, mcpFailLine` to the existing helpers import, then append:

```js
test('hook output and MCP failures are counted once per uuid, never per response line', () => {
  const lines = [
    hookLine('SessionStart', 100, 'h1'),
    hookLine('SessionStart', 100, 'h1'), // same line repeated (resumed session)
    hookLine('UserPromptSubmit', 50, 'h2'),
    mcpFailLine('m1'),
    mcpFailLine('m1'),                       // repeated line
    mcpFailLine('m2'),                       // same server re-listed in a later delta
    mcpFailLine('m3', [{ name: 'other' }]),  // a second, different server
    assistantLine({ id: 'a', cr: 10 }), // one response, two lines
    assistantLine({ id: 'a', cr: 10, out: 5 }),
  ];
  const s = summarizeLines(lines);
  assert.deepEqual(s.hookChars, { SessionStart: 100, UserPromptSubmit: 50 });
  assert.equal(s.mcpFailures, 2, 'distinct failed servers, not delta lines');
  assert.equal(s.requests.length, 1);
});

test('assistant lines with no usage data mark the transcript unsupported', () => {
  const noUsage = JSON.stringify({ type: 'assistant', timestamp: new Date(0).toISOString(), message: { id: 'a', content: [] } });
  const bad = summarizeLines([noUsage, noUsage]);
  assert.equal(bad.unsupported, true);
  assert.equal(bad.requests.length, 0);
  assert.equal(summarizeLines([assistantLine({ id: 'a' })]).unsupported, false);
  assert.equal(summarizeLines([]).unsupported, false);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: the two new tests FAIL (`hookChars` undefined / `unsupported` undefined); earlier tests still pass.

- [ ] **Step 4: Replace `src/summarize.js`**

```js
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Every computer-use action returns a screenshot, so all calls to the tool count.
const SCREENSHOT_TOOL = /(__computer$|screenshot)/i;
// Line shapes verified on real transcripts (Plan 2 Task 1). Only `hook_success` is counted:
// hook_additional_context / hook_system_message / hook_non_blocking_error would double count the text.
const hookEvent = (a) => a.hookEvent || String(a.hookName || '').split(':')[0] || '?';
const HOOK_TEXT = (a) => String(a.stdout ?? a.content ?? '');

export function createSummarizer(file = '') {
  const reqs = new Map();      // message id -> request (one API response spans many lines)
  const toolNames = new Map(); // tool_use id -> tool name
  const seen = new Set();      // uuids of non-assistant lines (a resumed session repeats lines)
  const failedMcp = new Set(); // distinct failed MCP servers (deltas re-list them); never leaves this file
  const s = {
    file, toolVolume: {}, imageResults: 0, imageBytes: 0, screenshotCalls: 0, agentSpawns: 0, version: null,
    hookChars: {}, mcpFailures: 0, assistantLines: 0, usageLines: 0,
  };

  const bump = (name, chars) => {
    const t = (s.toolVolume[name] ??= { n: 0, chars: 0 });
    t.n++;
    t.chars += chars;
  };

  function push(line) {
    if (!line) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    if (o.version) s.version = o.version;
    if (o.type !== 'assistant' && o.uuid) {
      if (seen.has(o.uuid)) return;
      seen.add(o.uuid);
    }

    const a = o.attachment;
    if (o.type === 'attachment' && a?.type === 'hook_success') {
      const ev = hookEvent(a);
      s.hookChars[ev] = (s.hookChars[ev] || 0) + HOOK_TEXT(a).length;
      return;
    }
    if (o.type === 'attachment' && a?.type === 'deferred_tools_delta') {
      for (const e of Array.isArray(a.failedMcpServers) ? a.failedMcpServers : []) failedMcp.add(JSON.stringify(e));
      s.mcpFailures = failedMcp.size;
      return;
    }

    const m = o.message;
    if (!m) return;

    if (o.type === 'assistant') {
      s.assistantLines++;
      if (m.usage) {
        s.usageLines++;
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
    // Assistant lines exist but none carries usage: the format changed, do not report wrong numbers.
    const unsupported = s.assistantLines > 0 && s.usageLines === 0;
    return { ...s, requests, firstCtx: requests[0]?.ctx ?? 0, unsupported };
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
Expected: all PASS, including the 4 Plan 1 summarize tests (the `{"type":"summary"}` line has no `uuid`, so the de-dup guard skips it).

- [ ] **Step 6: Commit**

```bash
git add test/helpers.js test/summarize.test.js src/summarize.js
git commit -m "feat: summarize hook output, MCP failures and unsupported format, de-duplicated by uuid" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Config reader

**Files:**
- Create: `test/config.test.js`, `src/config.js`

- [ ] **Step 1: Write the failing tests `test/config.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';

function dirWith(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'lean-cfg-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}

test('reads enabled plugins, duplicate names, merged env and file sizes', () => {
  const claudeDir = dirWith({
    'settings.json': JSON.stringify({
      enabledPlugins: { 'a@m1': true, 'a@m2': true, 'b@m1': true, 'c@m1': false },
      env: { DISABLE_AUTOUPDATER: '1' },
    }),
    'CLAUDE.md': 'l1\nl2\nl3\n',
    'projects/p1/memory/MEMORY.md': 'x'.repeat(100),
    'projects/p2/memory/MEMORY.md': 'x'.repeat(300),
  });
  const c = loadConfig({ claudeDir, cwd: dirWith(), env: { FOO: '1' } });
  assert.deepEqual(c.plugins, ['a@m1', 'a@m2', 'b@m1']);
  assert.deepEqual(c.duplicates, [['a@m1', 'a@m2']]);
  assert.deepEqual(c.facts, { pluginCount: 3, duplicatePluginCount: 1, claudeMdLines: 3, memoryIndexBytes: 300 });
  assert.deepEqual(c.env, { FOO: '1', DISABLE_AUTOUPDATER: '1' });
});

test('project settings layer over user settings for detection; user file stays separate', () => {
  const claudeDir = dirWith({ 'settings.json': JSON.stringify({ env: { A: '1' } }) });
  const cwd = dirWith({ '.claude/settings.json': JSON.stringify({ env: { B: '2' }, idleCompaction: false }), 'CLAUDE.md': 'one\ntwo' });
  const c = loadConfig({ claudeDir, cwd, env: {} });
  assert.deepEqual(c.env, { A: '1', B: '2' });
  assert.equal(c.settings.idleCompaction, false);
  assert.equal(c.userSettings.idleCompaction, undefined);
  assert.equal(c.facts.claudeMdLines, 2);
});

test('missing settings is empty; invalid settings is flagged so fix can refuse', () => {
  const missing = loadConfig({ claudeDir: dirWith(), cwd: dirWith(), env: {} });
  assert.deepEqual(missing.userSettings, {});
  assert.equal(missing.userSettingsError, false);
  const bad = loadConfig({ claudeDir: dirWith({ 'settings.json': '{ nope' }), cwd: dirWith(), env: {} });
  assert.equal(bad.userSettingsError, true);
  const arr = loadConfig({ claudeDir: dirWith({ 'settings.json': '[]' }), cwd: dirWith(), env: {} });
  assert.equal(arr.userSettingsError, true);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/config.js'`.

- [ ] **Step 3: Write `src/config.js`**

```js
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readSettings(path) {
  if (!existsSync(path)) return { value: {}, error: false };
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(v) ? { value: v, error: false } : { value: {}, error: true };
  } catch {
    return { value: {}, error: true };
  }
}

const merge = (a, b) => ({ ...a, ...b, env: { ...a.env, ...b.env }, enabledPlugins: { ...a.enabledPlugins, ...b.enabledPlugins } });
const lineCount = (p) => { try { const t = readFileSync(p, 'utf8').trimEnd(); return t ? t.split('\n').length : 0; } catch { return 0; } };
const bytes = (p) => { try { return statSync(p).size; } catch { return 0; } };

// Facts about the user's setup. `settings`/`env` are merged user+project layers (for detection);
// `userSettings` is the user file alone (the only thing `lean fix` ever writes).
export function loadConfig({ claudeDir = join(homedir(), '.claude'), cwd = process.cwd(), env = process.env } = {}) {
  const userSettingsPath = join(claudeDir, 'settings.json');
  const user = readSettings(userSettingsPath);
  const layers = [user.value, readSettings(join(cwd, '.claude', 'settings.json')).value, readSettings(join(cwd, '.claude', 'settings.local.json')).value];
  const settings = layers.reduce(merge, {});

  const plugins = Object.entries(settings.enabledPlugins).filter(([, on]) => on === true).map(([id]) => id).sort();
  const byName = new Map();
  for (const id of plugins) {
    const name = id.split('@')[0];
    byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  const duplicates = [...byName.values()].filter((ids) => ids.length > 1);

  const projects = join(claudeDir, 'projects');
  const memorySizes = existsSync(projects) ? readdirSync(projects).map((d) => bytes(join(projects, d, 'memory', 'MEMORY.md'))) : [];

  return {
    userSettingsPath,
    userSettings: user.value,
    userSettingsError: user.error,
    settings,
    env: { ...env, ...settings.env },
    plugins,
    duplicates,
    facts: {
      pluginCount: plugins.length,
      duplicatePluginCount: duplicates.length,
      claudeMdLines: Math.max(lineCount(join(claudeDir, 'CLAUDE.md')), lineCount(join(cwd, 'CLAUDE.md'))),
      memoryIndexBytes: Math.max(0, ...memorySizes),
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS (3 new).

- [ ] **Step 5: Commit**

```bash
git add test/config.test.js src/config.js
git commit -m "feat: config reader for settings, env, plugins and memory sizes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Config metrics and `hookInjection`

**Files:**
- Modify: `test/metrics.test.js`, `src/metrics.js`

- [ ] **Step 1: Add failing tests to `test/metrics.test.js`**

Change the helpers import to `import { req, sess, cfg } from './helpers.js';`, then append:

```js
test('configAtLeast compares a numeric config fact', () => {
  const c = cfg({ facts: { claudeMdLines: 250 } });
  assert.equal(metrics.configAtLeast([], { field: 'claudeMdLines', min: 201 }, c).hit, true);
  assert.equal(metrics.configAtLeast([], { field: 'claudeMdLines', min: 300 }, c).hit, false);
});

test('duplicatePlugins targets every copy after the first', () => {
  const r = metrics.duplicatePlugins([], {}, cfg({ duplicates: [['a@m1', 'a@m2', 'a@m3'], ['b@x', 'b@y']] }));
  assert.equal(r.hit, true);
  assert.deepEqual(r.targets, ['a@m2', 'a@m3', 'b@y']);
  assert.equal(metrics.duplicatePlugins([], {}, cfg()).hit, false);
});

test('settingState handles absent, present (truthy only), notFalse and prefix', () => {
  const c = cfg({ settings: { idleCompaction: false, keep: 'x' }, env: { DISABLE_PROMPT_CACHING: '1', DISABLE_PROMPT_CACHING_HAIKU: '0' } });
  const st = (p) => metrics.settingState([], p, c);
  assert.equal(st({ source: 'setting', key: 'nope', when: 'absent' }).hit, true);
  assert.equal(st({ source: 'setting', key: 'keep', when: 'absent' }).hit, false);
  assert.equal(st({ source: 'setting', key: 'idleCompaction', when: 'notFalse' }).hit, false);
  assert.equal(st({ source: 'setting', key: 'other', when: 'notFalse' }).hit, true);
  const p = st({ source: 'env', key: 'DISABLE_PROMPT_CACHING', prefix: true, when: 'present' });
  assert.equal(p.hit, true);
  assert.deepEqual(p.targets, ['DISABLE_PROMPT_CACHING']); // the "0" one is not active
});

test('hookInjection averages estimated tokens per session over the named events', () => {
  const a = sess([req(1)], { hookChars: { SessionStart: 36000 } });
  const b = sess([req(1)], { hookChars: { SessionStart: 36000, Other: 99999 } });
  const r = metrics.hookInjection([a, b], { above: 3000, events: ['SessionStart', 'UserPromptSubmit'] });
  assert.equal(r.hit, true);
  assert.equal(r.weightTokens, 20000);
  assert.match(r.evidence, /~10k tokens per session/);
  assert.equal(metrics.hookInjection([sess([req(1)])], { above: 3000, events: ['SessionStart'] }).hit, false);
  assert.equal(metrics.hookInjection([], { above: 3000, events: ['SessionStart'] }).hit, false);
});

test('config metrics never hit when no config is supplied', () => {
  assert.equal(metrics.configAtLeast([], { field: 'claudeMdLines', min: 0 }, null).hit, false);
  assert.equal(metrics.duplicatePlugins([], {}, undefined).hit, false);
  assert.equal(metrics.settingState([], { source: 'env', key: 'X', when: 'absent' }, null).hit, false);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: new tests FAIL (`metrics.configAtLeast is not a function`).

- [ ] **Step 3: Edit `src/metrics.js`**

Add these helpers under the existing four helper lines at the top:

```js
const NO_CONFIG = { hit: false, weightTokens: 0, evidence: 'no config available' };
const needsConfig = (fn) => (sessions, params, config) => (config ? fn(config, params) : NO_CONFIG);
const truthy = (v) => ![undefined, null, false, 0, '', '0', 'false'].includes(v);
```

Update the header comment's signature to `(sessions, params, config) -> { hit, weightTokens, evidence, targets? }`, and add these entries inside the `metrics` object (after `modelShare`):

```js
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add test/metrics.test.js src/metrics.js
git commit -m "feat: config metrics and hook injection metric" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Loader changes (models, edits) and the 14 rules

**Files:**
- Modify: `test/rules.test.js`, `src/rules.js`
- Create: 14 files in `rules/` (listed in Step 5)

- [ ] **Step 1: Update `test/rules.test.js`**

Change the helpers import to `import { req, sess, cfg } from './helpers.js';`. In the first test change `assert.equal(rules.length, 9);` to `assert.equal(rules.length, 23);`. Append:

```js
test('official rules cite an https source; unverified rules say so', () => {
  for (const r of loadRules()) {
    if (r.confidence === 'official') assert.match(r.source, /https:\/\//, r.id);
    if (r.confidence === 'unverified') assert.match(r.source, /unverified/, r.id);
  }
});

function writeRule(extra) {
  const dir = mkdtempSync(join(tmpdir(), 'lean-rules-'));
  writeFileSync(join(dir, 'r.json'), JSON.stringify({
    id: 'r', title: 't', source: 's', confidence: 'measured',
    detect: { metric: 'modelShare', match: 'x', minShare: 1 }, fix: { type: 'advice', text: 'x' }, ...extra,
  }));
  return dir;
}

test('loadRules rejects a bad models list and an unknown fix edit op', () => {
  assert.throws(() => loadRules(writeRule({ models: 'opus' })), /bad rule r\.json/);
  assert.throws(() => loadRules(writeRule({ fix: { type: 'settings', text: 'x', edit: { op: 'rm -rf' } } })), /bad rule r\.json/);
  assert.doesNotThrow(() => loadRules(writeRule({ models: ['opus'], fix: { type: 'settings', text: 'x', edit: { op: 'setKey', key: 'k', value: 1 } } })));
});

test('models filter scopes requests and skips rules with no matching model', () => {
  const s = sess([req(600e3, { cr: 600e3, model: 'claude-opus-5-5' }), req(10e3, { model: 'claude-sonnet-5-5' })]);
  const rule = (models) => ({
    id: 'x', title: 't', source: 's', confidence: 'measured', models,
    detect: { metric: 'shareRequestsAboveCtx', above: 500e3, minShare: 0.9 }, fix: { type: 'advice', text: 'x' },
  });
  assert.equal(evaluate([rule(['opus'])], [s]).length, 1);  // only the opus request counts: 100%
  assert.equal(evaluate([rule(['*'])], [s]).length, 0);     // 50% overall
  assert.equal(evaluate([rule(['haiku'])], [s]).length, 0); // nothing matches: rule skipped
});

// [config that makes the rule fire, config that keeps it quiet]
const CONFIG_CASES = {
  'plugin-duplicate': [cfg({ duplicates: [['a@m1', 'a@m2']] }), cfg()],
  'plugin-count': [cfg({ facts: { pluginCount: 20 } }), cfg({ facts: { pluginCount: 3 } })],
  'claudemd-big': [cfg({ facts: { claudeMdLines: 300 } }), cfg({ facts: { claudeMdLines: 100 } })],
  'memory-index-big': [cfg({ facts: { memoryIndexBytes: 40000 } }), cfg({ facts: { memoryIndexBytes: 100 } })],
  'agent-teams': [cfg({ env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1' } }), cfg()],
  'caching-disabled': [cfg({ env: { DISABLE_PROMPT_CACHING: '1' } }), cfg()],
  'subagent-ttl': [cfg(), cfg({ settings: { subagentPromptCacheTtl: '1h' } })],
  'crossession-inbound': [cfg(), cfg({ settings: { crossSessionInbound: 'hold' } })],
  'goal-checkin': [cfg(), cfg({ env: { CLAUDE_CODE_GOAL_CHECKIN_MINUTES: '0' } })],
  'idle-compaction': [cfg(), cfg({ settings: { idleCompaction: false } })],
  'prompt-suggestions': [cfg(), cfg({ settings: { promptSuggestionEnabled: false } })],
  'autoupdate-rebuild': [cfg(), cfg({ env: { DISABLE_AUTOUPDATER: '1' } })],
};

for (const [id, [fires, quiet]] of Object.entries(CONFIG_CASES)) {
  test(`config rule ${id} fires and stays quiet`, () => {
    const rules = loadRules().filter((r) => r.id === id);
    assert.equal(rules.length, 1);
    assert.equal(evaluate(rules, [], fires).length, 1);
    assert.equal(evaluate(rules, [], quiet).length, 0);
  });
}

test('transcript-derived rules hook-stdout-big and mcp-failing fire and stay quiet', () => {
  const pick = (id) => loadRules().filter((r) => r.id === id);
  assert.equal(evaluate(pick('hook-stdout-big'), [sess([req(1)], { hookChars: { SessionStart: 36000 } })], cfg()).length, 1);
  assert.equal(evaluate(pick('hook-stdout-big'), [sess([req(1)], { hookChars: { SessionStart: 100 } })], cfg()).length, 0);
  assert.equal(evaluate(pick('mcp-failing'), [sess([req(1)], { mcpFailures: 2 })], cfg()).length, 1);
  assert.equal(evaluate(pick('mcp-failing'), [sess([req(1)])], cfg()).length, 0);
});

test('findings carry targets from the metric', () => {
  const f = evaluate(loadRules().filter((r) => r.id === 'plugin-duplicate'), [], cfg({ duplicates: [['a@m1', 'a@m2']] }));
  assert.deepEqual(f[0].targets, ['a@m2']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (rule count 9 vs 23, missing rules, `models` not validated).

- [ ] **Step 3: Replace `src/rules.js`**

```js
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
```

- [ ] **Step 4: Write the 14 rule files**

All ship `confidence: "unverified"` (Task 9 upgrades). `weightTokens` is 0 for config rules, so they sort after weighted transcript findings.

`rules/plugin-duplicate.json`
```json
{
  "id": "plugin-duplicate",
  "title": "Same plugin enabled from more than one marketplace",
  "source": "unverified: measured on one user; settings key enabledPlugins (to check against https://code.claude.com/docs/en/settings)",
  "confidence": "unverified",
  "detect": { "metric": "duplicatePlugins" },
  "fix": { "type": "settings", "text": "Keep one copy of each plugin; every enabled plugin adds its skill and agent descriptions to every session.", "edit": { "op": "disablePlugin" } }
}
```

`rules/plugin-count.json`
```json
{
  "id": "plugin-count",
  "title": "Many plugins enabled",
  "source": "unverified: threshold is a heuristic; each enabled plugin's skill descriptions load every session (to check against https://code.claude.com/docs/en/costs)",
  "confidence": "unverified",
  "detect": { "metric": "configAtLeast", "field": "pluginCount", "min": 15 },
  "fix": { "type": "advice", "text": "Disable plugins you do not use (/plugin). Run /context to see what they cost before deciding." }
}
```

`rules/mcp-failing.json`
```json
{
  "id": "mcp-failing",
  "title": "MCP servers failed or timed out",
  "source": "unverified: counted from failedMcpServers in transcript attachments (internal format, not documented)",
  "confidence": "unverified",
  "detect": { "metric": "maxPerSession", "field": "mcpFailures", "min": 1 },
  "fix": { "type": "advice", "text": "Remove or disable MCP servers that do not connect (/mcp). A server that is configured but broken still costs startup time and often tool-definition tokens." }
}
```

`rules/hook-stdout-big.json`
```json
{
  "id": "hook-stdout-big",
  "title": "Hooks inject a lot of text into every session",
  "source": "unverified: measured from hook attachment lines in transcripts; character-based estimate (chars/3.6)",
  "confidence": "unverified",
  "detect": { "metric": "hookInjection", "above": 3000, "events": ["SessionStart", "UserPromptSubmit"] },
  "fix": { "type": "advice", "text": "Shorten or remove SessionStart/UserPromptSubmit hooks that print long text; that text stays in context and is re-read on every request. The transcript does not say which hook command it came from, so check your hooks in settings.json." }
}
```

`rules/claudemd-big.json`
```json
{
  "id": "claudemd-big",
  "title": "CLAUDE.md is long",
  "source": "unverified: 200-line threshold from the spec (to check against https://code.claude.com/docs/en/memory)",
  "confidence": "unverified",
  "detect": { "metric": "configAtLeast", "field": "claudeMdLines", "min": 201 },
  "fix": { "type": "advice", "text": "CLAUDE.md loads in full every session. Keep it short and move workflows into skills." }
}
```

`rules/memory-index-big.json`
```json
{
  "id": "memory-index-big",
  "title": "Large MEMORY.md index",
  "source": "unverified: 25 KB threshold is a heuristic (to check against https://code.claude.com/docs/en/memory)",
  "confidence": "unverified",
  "detect": { "metric": "configAtLeast", "field": "memoryIndexBytes", "min": 25000 },
  "fix": { "type": "advice", "text": "MEMORY.md is loaded each session. Prune or archive old entries." }
}
```

`rules/subagent-ttl.json`
```json
{
  "id": "subagent-ttl",
  "title": "Subagent prompt-cache TTL not set",
  "source": "unverified: setting name subagentPromptCacheTtl comes from the design spec; not confirmed in docs",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "setting", "key": "subagentPromptCacheTtl", "when": "absent" },
  "fix": { "type": "advice", "text": "Subagents may default to a 5-minute cache TTL. If your client supports subagentPromptCacheTtl, set a longer one (check the docs for valid values)." }
}
```

`rules/agent-teams.json`
```json
{
  "id": "agent-teams",
  "title": "Agent teams enabled",
  "source": "unverified: env CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS and the ~7x token claim come from the design spec",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "env", "key": "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS", "when": "present" },
  "fix": { "type": "advice", "text": "Teams use many times the tokens of one session. Keep teams small and close idle teammates, or unset the variable if you do not use them." }
}
```

`rules/crossession-inbound.json`
```json
{
  "id": "crossession-inbound",
  "title": "Cross-session messages can open turns while idle",
  "source": "unverified: setting crossSessionInbound and value \"hold\" come from the design spec",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "setting", "key": "crossSessionInbound", "when": "absent" },
  "fix": { "type": "settings", "text": "Set crossSessionInbound to \"hold\" so idle sessions do not start turns on their own.", "edit": { "op": "setKey", "key": "crossSessionInbound", "value": "hold" } }
}
```

`rules/goal-checkin.json`
```json
{
  "id": "goal-checkin",
  "title": "Goal check-ins can run while idle",
  "source": "unverified: env CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0 comes from the design spec",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "env", "key": "CLAUDE_CODE_GOAL_CHECKIN_MINUTES", "when": "absent" },
  "fix": { "type": "settings", "text": "Set CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0 to stop idle goal check-in turns.", "edit": { "op": "setEnv", "name": "CLAUDE_CODE_GOAL_CHECKIN_MINUTES", "value": "0" } }
}
```

`rules/idle-compaction.json`
```json
{
  "id": "idle-compaction",
  "title": "Background idle compaction may be on",
  "source": "unverified: setting idleCompaction comes from the design spec; default value unknown",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "setting", "key": "idleCompaction", "when": "notFalse" },
  "fix": { "type": "settings", "text": "Set idleCompaction to false so idle sessions do not compact in the background.", "edit": { "op": "setKey", "key": "idleCompaction", "value": false } }
}
```

`rules/prompt-suggestions.json`
```json
{
  "id": "prompt-suggestions",
  "title": "Prompt suggestions cost an extra request per turn",
  "source": "unverified: setting name promptSuggestionEnabled not confirmed in docs",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "setting", "key": "promptSuggestionEnabled", "when": "notFalse" },
  "fix": { "type": "advice", "text": "Turn prompt suggestions off in /config if you do not use them." }
}
```

`rules/autoupdate-rebuild.json`
```json
{
  "id": "autoupdate-rebuild",
  "title": "Auto-update can rebuild the cache mid-work",
  "source": "unverified: env DISABLE_AUTOUPDATER (to check against https://code.claude.com/docs/en/settings)",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "env", "key": "DISABLE_AUTOUPDATER", "when": "absent" },
  "fix": { "type": "settings", "text": "Set DISABLE_AUTOUPDATER=1 and update on your own schedule; a version change invalidates the prompt cache.", "edit": { "op": "setEnv", "name": "DISABLE_AUTOUPDATER", "value": "1" } }
}
```

`rules/caching-disabled.json`
```json
{
  "id": "caching-disabled",
  "title": "Prompt caching is disabled by an environment variable",
  "source": "unverified: DISABLE_PROMPT_CACHING* variables (to check against https://code.claude.com/docs/en/prompt-caching)",
  "confidence": "unverified",
  "detect": { "metric": "settingState", "source": "env", "key": "DISABLE_PROMPT_CACHING", "prefix": true, "when": "present" },
  "fix": { "type": "settings", "text": "Remove DISABLE_PROMPT_CACHING* variables; without caching every request pays full price for the whole context.", "edit": { "op": "removeEnv" } }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS. (23 rules; 12 config-case tests, the transcript-derived test, the models/validation tests.)

- [ ] **Step 6: Commit**

```bash
git add test/rules.test.js src/rules.js rules/
git commit -m "feat: models filter, fix edit validation and 14 config/env rules" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: `fix.js` (plan + apply)

**Files:**
- Create: `test/fix.test.js`, `src/fix.js`

- [ ] **Step 1: Write the failing tests `test/fix.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyFix, planFix } from '../src/fix.js';

const finding = (edit, { confidence = 'measured', targets = [], type = 'settings' } = {}) => ({
  rule: { id: 'r', confidence, fix: { type, text: 'x', edit } },
  targets,
});

test('setKey and setEnv edit a copy, keep other keys, and are idempotent', () => {
  const settings = { theme: 'dark', env: { KEEP: '1' } };
  const fs = [finding({ op: 'setKey', key: 'idleCompaction', value: false }), finding({ op: 'setEnv', name: 'DISABLE_AUTOUPDATER', value: '1' })];
  const plan = planFix(settings, fs);
  assert.deepEqual(plan.next, { theme: 'dark', idleCompaction: false, env: { KEEP: '1', DISABLE_AUTOUPDATER: '1' } });
  assert.equal(plan.done.length, 2);
  assert.deepEqual(settings, { theme: 'dark', env: { KEEP: '1' } }, 'input is not mutated');
  assert.equal(planFix(plan.next, fs).done.length, 0, 'second run changes nothing');
});

test('unverified rules are skipped unless includeUnverified is set', () => {
  const f = finding({ op: 'setKey', key: 'k', value: 1 }, { confidence: 'unverified' });
  const skipped = planFix({}, [f]);
  assert.deepEqual(skipped.skipped, ['r']);
  assert.equal(skipped.done.length, 0);
  assert.equal(planFix({}, [f], { includeUnverified: true }).done.length, 1);
});

test('advice findings are ignored', () => {
  assert.equal(planFix({}, [finding({ op: 'setKey', key: 'k', value: 1 }, { type: 'advice' })]).done.length, 0);
});

test('removeEnv removes from settings.env and reports shell-only variables as manual', () => {
  const plan = planFix({ env: { DISABLE_PROMPT_CACHING: '1' } }, [finding({ op: 'removeEnv' }, { targets: ['DISABLE_PROMPT_CACHING', 'DISABLE_PROMPT_CACHING_HAIKU'] })]);
  assert.deepEqual(plan.next.env, {});
  assert.deepEqual(plan.done, ['remove env DISABLE_PROMPT_CACHING']);
  assert.match(plan.manual[0], /DISABLE_PROMPT_CACHING_HAIKU .*outside settings\.json/);
});

test('disablePlugin disables enabled user plugins and reports others as manual', () => {
  const plan = planFix({ enabledPlugins: { 'a@m2': true, 'b@m1': true } }, [finding({ op: 'disablePlugin' }, { targets: ['a@m2', 'z@m9'] })]);
  assert.deepEqual(plan.next.enabledPlugins, { 'a@m2': false, 'b@m1': true });
  assert.deepEqual(plan.done, ['disable plugin a@m2']);
  assert.match(plan.manual[0], /z@m9/);
});

test('applyFix writes a byte-exact timestamped backup and the new file; no-op writes nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-fix-'));
  const path = join(dir, 'settings.json');
  const original = '{ "theme": "dark" }\n';
  writeFileSync(path, original);
  const plan = planFix({ theme: 'dark' }, [finding({ op: 'setKey', key: 'idleCompaction', value: false })]);
  const backup = applyFix(path, plan, new Date('2026-11-14T10:20:30.123Z'));
  assert.equal(readFileSync(backup, 'utf8'), original);
  assert.match(backup, /settings\.json\.lean-backup-2026-11-14T10-20-30-123Z$/);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { theme: 'dark', idleCompaction: false });
  const before = readdirSync(dir).length;
  assert.equal(applyFix(path, planFix(plan.next, []), new Date()), null);
  assert.equal(readdirSync(dir).length, before);
});

test('applyFix creates the file without a backup when settings.json does not exist', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'lean-fix-')), 'settings.json');
  const plan = planFix({}, [finding({ op: 'setKey', key: 'k', value: 1 })]);
  assert.equal(applyFix(path, plan), null);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { k: 1 });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/fix.js'`.

- [ ] **Step 3: Write `src/fix.js`**

```js
import { copyFileSync, existsSync, writeFileSync } from 'node:fs';

const R = (done = [], manual = []) => ({ done, manual });

// Each op edits the settings copy in place and says what it did. Only these ops exist (see EDIT_OPS in rules.js).
const OPS = {
  setKey(s, e) {
    if (JSON.stringify(s[e.key]) === JSON.stringify(e.value)) return R();
    s[e.key] = e.value;
    return R([`set ${e.key} = ${JSON.stringify(e.value)}`]);
  },
  setEnv(s, e) {
    s.env ??= {};
    if (s.env[e.name] === String(e.value)) return R();
    s.env[e.name] = String(e.value);
    return R([`set env ${e.name} = "${e.value}"`]);
  },
  removeEnv(s, _e, targets) {
    const out = R();
    for (const t of targets) {
      if (s.env && t in s.env) {
        delete s.env[t];
        out.done.push(`remove env ${t}`);
      } else {
        out.manual.push(`${t} is set outside settings.json (shell or project settings); remove it there`);
      }
    }
    return out;
  },
  disablePlugin(s, _e, targets) {
    const out = R();
    for (const t of targets) {
      if (s.enabledPlugins?.[t] === true) {
        s.enabledPlugins[t] = false;
        out.done.push(`disable plugin ${t}`);
      } else {
        out.manual.push(`${t} is enabled outside user settings.json; disable it there`);
      }
    }
    return out;
  },
};

// Pure: returns { next, done, manual, skipped }. Never touches the disk.
export function planFix(settings, findings, { includeUnverified = false } = {}) {
  const plan = { next: structuredClone(settings), done: [], manual: [], skipped: [] };
  for (const f of findings) {
    const { rule } = f;
    if (rule.fix.type !== 'settings') continue;
    if (rule.confidence === 'unverified' && !includeUnverified) {
      plan.skipped.push(rule.id);
      continue;
    }
    const r = OPS[rule.fix.edit.op](plan.next, rule.fix.edit, f.targets ?? []);
    plan.done.push(...r.done);
    plan.manual.push(...r.manual);
  }
  return plan;
}

// Writes only when the plan changed something. Returns the backup path, or null (no backup needed or nothing written).
export function applyFix(path, plan, now = new Date()) {
  if (!plan.done.length) return null;
  let backup = null;
  if (existsSync(path)) {
    backup = `${path}.lean-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(plan.next, null, 2)}\n`);
  return backup;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS (7 new in fix.test.js).

- [ ] **Step 5: Commit**

```bash
git add test/fix.test.js src/fix.js
git commit -m "feat: fix plan/apply with backup, idempotent edits and manual notes" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Report, warnings and the CLI (`doctor` + `fix`)

**Files:**
- Modify: `src/report.js`, `bin/lean.js`
- Replace: `test/cli.test.js`

- [ ] **Step 1: Replace `test/cli.test.js` with the full new version**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assistantLine } from './helpers.js';

const BIN = fileURLToPath(new URL('../bin/lean.js', import.meta.url));
// The machine's real Claude settings must never leak into a test.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISABLE_|CLAUDE_)/.test(k)));

function tmp(files = {}) {
  const d = mkdtempSync(join(tmpdir(), 'lean-cli-'));
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(d, p)), { recursive: true });
    writeFileSync(join(d, p), c);
  }
  return d;
}
const lean = (args, dir) => execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: dir, env: cleanEnv() });
const transcript = (lines) => join(tmp({ 's.jsonl': lines.join('\n') }), 's.jsonl');
const bigSession = () => transcript(Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000 })));

test('doctor prints a ranked text report', () => {
  const dir = tmp();
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', bigSession()], dir);
  assert.match(out, /claude-lean doctor: 1 sessions, 30 requests/);
  assert.match(out, /1\. \[official\] Context grew past 300k tokens/);
  assert.match(out, /found: 100% of 30 requests ran above 300k context/);
  assert.match(out, /fix: /);
});

test('doctor includes config rules and marks fixable ones', () => {
  const dir = tmp();
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', bigSession()], dir);
  assert.match(out, /\[unverified\] Auto-update can rebuild the cache mid-work/);
  assert.match(out, /\[lean fix can apply this\]/);
});

test('doctor --json is machine readable', () => {
  const dir = tmp();
  const j = JSON.parse(lean(['doctor', '--json', '--claude-dir', join(dir, 'claude'), '--file', bigSession()], dir));
  assert.equal(j.sessions, 1);
  assert.equal(j.requests, 30);
  assert.deepEqual(j.warnings, []);
  assert.ok(j.findings.some((f) => f.id === 'ctx-300k' && f.confidence === 'official'));
});

test('unsupported transcript format is reported, not silently dropped', () => {
  const dir = tmp();
  const bad = JSON.stringify({ type: 'assistant', timestamp: new Date(0).toISOString(), message: { id: 'a', content: [] } });
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', transcript([bad])], dir);
  assert.match(out, /warning: 1 transcript file\(s\) have assistant lines without usage data/);
  assert.match(out, /No supported transcripts were analysed/);
  assert.doesNotMatch(out, /No known causes found/);
});

test('unknown command exits non-zero with usage', () => {
  assert.throws(() => execFileSync(process.execPath, [BIN, 'nope'], { stdio: 'pipe' }), /usage: lean doctor/);
});

const settingsWith = (obj) => {
  const dir = tmp({ 'claude/settings.json': JSON.stringify(obj, null, 2) });
  return { dir, claudeDir: join(dir, 'claude'), path: join(dir, 'claude', 'settings.json') };
};

test('fix is a dry run by default and skips unverified rules', () => {
  const { dir, claudeDir, path } = settingsWith({ theme: 'dark', enabledPlugins: { 'a@m1': true, 'a@m2': true } });
  const before = readFileSync(path, 'utf8');
  const out = lean(['fix', '--claude-dir', claudeDir], dir);
  assert.match(out, /dry run/);
  assert.match(out, /skipped \(unverified/);
  assert.match(out, /Nothing was written/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('fix --include-unverified without --apply lists edits but writes nothing', () => {
  const { dir, claudeDir, path } = settingsWith({ theme: 'dark', enabledPlugins: { 'a@m1': true, 'a@m2': true } });
  const before = readFileSync(path, 'utf8');
  const out = lean(['fix', '--include-unverified', '--claude-dir', claudeDir], dir);
  assert.match(out, /would: disable plugin a@m2/);
  assert.match(out, /would: set env DISABLE_AUTOUPDATER = "1"/);
  assert.equal(readFileSync(path, 'utf8'), before);
});

test('fix --apply backs up, edits only named keys, and a second run is a no-op', () => {
  const { dir, claudeDir, path } = settingsWith({ theme: 'dark', enabledPlugins: { 'a@m1': true, 'a@m2': true } });
  const before = readFileSync(path, 'utf8');
  lean(['fix', '--apply', '--include-unverified', '--claude-dir', claudeDir], dir);
  const backups = readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.lean-backup-'));
  assert.equal(backups.length, 1);
  assert.equal(readFileSync(join(claudeDir, backups[0]), 'utf8'), before);
  const s = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(s.theme, 'dark');
  assert.deepEqual(s.enabledPlugins, { 'a@m1': true, 'a@m2': false });
  assert.equal(s.env.DISABLE_AUTOUPDATER, '1');
  const again = lean(['fix', '--apply', '--include-unverified', '--claude-dir', claudeDir], dir);
  assert.match(again, /Nothing to change/);
  assert.equal(readdirSync(claudeDir).filter((f) => f.startsWith('settings.json.lean-backup-')).length, 1);
});

test('fix refuses to touch a settings.json that is not valid JSON', () => {
  const dir = tmp({ 'claude/settings.json': '{ not json' });
  const path = join(dir, 'claude', 'settings.json');
  assert.throws(() => lean(['fix', '--apply', '--include-unverified', '--claude-dir', join(dir, 'claude')], dir), /not valid JSON/);
  assert.equal(readFileSync(path, 'utf8'), '{ not json');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (CLI has no `fix`, no `--claude-dir`, no warnings).

- [ ] **Step 3: Replace `src/report.js`**

```js
export function formatReport(findings, sessions, warnings = []) {
  const requests = sessions.reduce((t, s) => t + s.requests.length, 0);
  const out = [`claude-lean doctor: ${sessions.length} sessions, ${requests} requests`, ''];
  for (const w of warnings) out.push(`warning: ${w}`);
  if (warnings.length) out.push('');
  if (!sessions.length) out.push('No supported transcripts were analysed, so transcript-based rules did not run.', '');
  else if (!findings.length) out.push('No known causes found.', '');
  findings.forEach((f, i) => {
    const fixable = f.rule.fix.type === 'settings' ? ' [lean fix can apply this]' : '';
    out.push(
      `${i + 1}. [${f.rule.confidence}] ${f.rule.title}`,
      `   found:  ${f.evidence}`,
      `   fix:    ${f.rule.fix.text}${fixable}`,
      `   source: ${f.rule.source}`,
      '',
    );
  });
  out.push('Token counts come from the usage fields in your transcripts. Local data only; nothing is sent anywhere.');
  return out.join('\n');
}
```

- [ ] **Step 4: Replace `bin/lean.js`**

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/report.js bin/lean.js test/cli.test.js
git commit -m "feat: lean fix (dry-run default, --apply, backup), config rules in doctor, unsupported-format warning" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Acceptance on real transcripts (no new files)

Confirms the de-duplication invariant still holds with the new code and that the new counters read real data.

- [ ] **Step 1: Request count equals distinct message ids, per real transcript**

Run (replace `<file>` with a large real session `.jsonl`):

```bash
node --input-type=module -e "
import { readFileSync } from 'node:fs';
import { summarizeFile } from './src/summarize.js';
const f = process.argv[1];
const ids = new Set();
for (const l of readFileSync(f, 'utf8').split('\n')) { try { const o = JSON.parse(l); if (o.type === 'assistant' && o.message?.usage) ids.add(o.message.id); } catch {} }
const s = await summarizeFile(f);
console.log({ distinctIds: ids.size, requests: s.requests.length, assistantLines: s.assistantLines, hookChars: s.hookChars, mcpFailures: s.mcpFailures, unsupported: s.unsupported });
" <file>
```

Expected: `distinctIds === requests` and `assistantLines > requests` (proves multi-line responses are being merged). `unsupported: false`. If `hookChars` is `{}` although hooks are configured, the hook line shape differs from Task 1's finding: fix `summarize.js` and the `hookLine` helper, do not weaken tests.

- [ ] **Step 2: Full report on the whole history**

Run: `node bin/lean.js doctor`
Expected: Plan 1 findings first (weighted), config findings after, each tagged `[unverified]`; no crash with an unreadable or missing `settings.json`.

- [ ] **Step 3: `lean fix` dry run on the real settings**

Run: `node bin/lean.js fix`
Expected: `dry run`, a "skipped (unverified ...)" line (before Task 9), `Nothing was written`. Confirm the real `settings.json` is byte-identical afterwards (check its modification time). Do **not** run `--apply` against the real file in this task.

- [ ] **Step 4: Record**

```bash
git commit --allow-empty -m "test: Plan 2 acceptance verified on real transcripts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Verify setting names against official docs

Turns "unverified" into a fact where docs support it. Do not invent values the docs do not give.

**Files:** `rules/*.json` for the 14 Plan 2 rules, only where verified.

- [ ] **Step 1: Fetch the docs** (use the web fetch/scrape tool): `https://code.claude.com/docs/en/settings`, `.../env-vars` (or wherever env vars are listed), `.../costs`, `.../prompt-caching`, `.../memory`. Save nothing to the repo.

- [ ] **Step 2: Fill this table from the fetched pages** (keep it in the final report, not in the repo)

| rule | key / env | found in docs? | doc URL | valid value stated |
|---|---|---|---|---|
| plugin-duplicate | `enabledPlugins` | | | |
| autoupdate-rebuild | `DISABLE_AUTOUPDATER` | | | |
| caching-disabled | `DISABLE_PROMPT_CACHING*` | | | |
| crossession-inbound | `crossSessionInbound` | | | |
| goal-checkin | `CLAUDE_CODE_GOAL_CHECKIN_MINUTES` | | | |
| idle-compaction | `idleCompaction` | | | |
| prompt-suggestions | (name unknown) | | | |
| subagent-ttl | `subagentPromptCacheTtl` | | | |
| agent-teams | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | | | |
| claudemd-big / memory-index-big | size guidance | | | |
| plugin-count, hook-stdout-big, mcp-failing | (mechanism) | | | |

- [ ] **Step 3: Edit rule files**
  - Found, and the value in the rule matches the docs: set `"confidence": "official"` and replace the `source` with the exact doc URL (must contain `https://`; the test enforces it).
  - Found but the rule's value differs: fix the value to the documented one, then upgrade as above.
  - `prompt-suggestions` / `subagent-ttl` with a documented key and value: switch `fix` to `settings` with the documented `setKey` edit.
  - Not found: leave `unverified` untouched.

- [ ] **Step 4: Run tests**

Run: `npm test`
Expected: all PASS (the source/confidence consistency test catches a half-edited rule).

- [ ] **Step 5: Commit**

```bash
git add rules/
git commit -m "docs: verify rule sources against official docs where possible" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: README and privacy check

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Read `README.md`, then add (keeping its existing tone and structure):**
  - Commands: `lean fix [--apply] [--include-unverified] [--claude-dir <dir>]` and `lean doctor --claude-dir`.
  - **What `lean fix` changes**: only `enabledPlugins` entries and the named settings/env keys of rules marked "can apply this"; only the user-level `settings.json`; a `settings.json.lean-backup-<timestamp>` copy is made before any write; dry run is the default; a settings file that is not valid JSON is never touched; project-level or shell-level settings are reported as "manual".
  - **What it never changes**: MCP servers, hooks, CLAUDE.md, memory, project settings.
  - **Confidence tags**: `official` (documented), `measured` (seen in transcripts), `unverified` (not confirmed; `lean fix` skips these unless `--include-unverified`).
  - A rule table (id, what it detects, confidence as of Task 9) and how to add a rule (one JSON file: `detect.metric`, optional `models`, `fix.type` `advice` or `settings` with `edit`).
  - A note that a transcript shows one API response across several lines and claude-lean counts requests by `message.id`; and that an unsupported transcript format produces a warning instead of numbers.
  - Use `~/.claude` in all examples; no real paths, names or emails.

- [ ] **Step 2: Privacy scan of everything tracked or staged**

Run:
```bash
git add -A && git grep --cached -nIF -e "${USERNAME:-$USER}" -e "$(git config user.email)" -- . ; git grep --cached -nIiE "[A-Za-z]:[\\/]+Users" -- . ; echo scan-done
```
Expected: only `scan-done` is printed (no matches). If anything matches, remove it before committing. (The scan reads the identity from the environment, so no personal string is written into this plan.)

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "docs: README for config rules, lean fix and confidence tags" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

## Self-review (against the request and spec)

- **14 rules** (`plugin-duplicate, plugin-count, mcp-failing, hook-stdout-big, claudemd-big, memory-index-big, subagent-ttl, agent-teams, crossession-inbound, goal-checkin, idle-compaction, prompt-suggestions, autoupdate-rebuild, caching-disabled`): Task 5 Step 4, one fire/quiet test each (Task 5 Step 1). Each has an official URL or an `unverified` source; a test enforces the pairing; Task 9 upgrades only on fetched evidence.
- **`lean fix`**: Task 6 (pure plan, backup, idempotent, no mutation of input) and Task 7 (dry-run default, `--apply`, refuse invalid JSON, skip unverified). Scope is plugin enablement + named keys; MCP/hook enablement is advice-only (stated in the deviations block, with the reason).
- **Model-aware rules**: `models` validated and applied in `rules.js`, tested in Task 5 with synthetic rules (no shipped rule needs it yet).
- **"Unsupported transcript format"**: Task 2 flag, Task 7 warning in text and `--json`, and the report refuses to say "No known causes found" when nothing was analysed.
- **Multi-line responses / message.id**: Plan 1 de-dup is untouched; new counters are uuid-keyed; Task 2 test feeds repeated lines and split responses; Task 8 Step 1 compares `requests` to distinct ids on real data and expects `assistantLines > requests`.
- **Tests first, zero dependencies, `node --test`**: every task writes the failing test, runs it, then implements. No packages added.
- **Privacy**: tests use tmp dirs and fake settings; README uses `~/.claude`; Task 10 Step 2 scans for identity strings without embedding them.
- **Placeholder scan:** none; the one corrected test line in Task 6 Step 1 is spelled out. **Name consistency:** `loadConfig` fields (`userSettings`, `userSettingsPath`, `userSettingsError`, `settings`, `env`, `plugins`, `duplicates`, `facts`), `cfg()` helper, metrics `configAtLeast/duplicatePlugins/settingState/hookInjection`, `planFix/applyFix`, `EDIT_OPS` (`setKey/setEnv/removeEnv/disablePlugin`) match across tasks and rule JSON.
- **Carried to Plan 3:** guards, `lean share` (must strip plugin names and env var names from its output), license choice. **Possible follow-up:** `disableMcp` / `disableHook` ops if Task 1 shows names in transcripts.
