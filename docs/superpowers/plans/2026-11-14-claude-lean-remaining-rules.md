# claude-lean Remaining Rules, MCP Fix, /context, Distribution (Plan 4 of 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the spec: the seven remaining buildable rules, a `denyMcp` fix op, hook-source attribution, `lean doctor --context`, and a marketplace manifest + icon so others can install the guards plugin.

**Architecture:** The summarizer gains a few more per-session counters (all de-duplicated by line `uuid`, request fields still merged by `message.id`). New metrics read them; rules stay JSON. Hook attribution maps a recorded hook command to the plugin whose installed `hooks/hooks.json` contains it. `lean fix` learns one new op and loads transcripts only when a settings rule needs them.

**Tech Stack:** Node >= 18, zero dependencies, `node:test`.

## Verified before writing this plan (real transcripts + official docs, 2026-11-14)

| Fact | Evidence |
|---|---|
| `compact_boundary` system lines carry `compactMetadata.{trigger, preTokens, postTokens, durationMs}` | real transcripts (5 compactions) |
| `skill_listing` attachments carry `content`; in the reference history it is capped at ~30,000 chars | real transcripts (49 listings, median 29,980) |
| `scheduled_task_fire` system lines exist (`taskKind: "loop"`); docs: a scheduled task "fires on its interval even while the session is idle, sending your full context each time" | real transcripts + costs docs |
| `failedMcpServers[]` entries are objects `{name, errorCode, error}` and re-list across deltas | real transcripts |
| Hook `command` is recorded with the literal `${CLAUDE_PLUGIN_ROOT}` (not the path). `~/.claude/plugins/installed_plugins.json` maps `name@marketplace` to `installPath`; `<installPath>/hooks/hooks.json` holds the same command strings | real data: 5,149 of 5,185 hook records (99.3%) and 97% of hook characters attribute to a plugin |
| Thinking text is omitted from transcripts: 4,062 thinking blocks, only 455 with text | real transcripts |
| Thinking cannot be turned off on Fable, Sonnet 5 and later, Haiku 5.5, Opus 4.7 and later ("always use adaptive reasoning"); older models use `MAX_THINKING_TOKENS`; setting `alwaysThinkingEnabled` | env-vars + settings-reference docs |
| `deniedMcpServers` (any settings file) blocks servers by name; entry shape `{ "serverName": "..." }`; `disabledMcpjsonServers` covers only a project `.mcp.json` | settings-reference + mcp docs |
| Docs recommend a `PreToolUse` hook that trims test output to the last 100 lines; `/compact` "is itself a large request"; `promptCacheTtl` takes `5m`/`1h`, 1-hour cache writes cost more | costs + prompt-caching docs |
| Marketplace = `.claude-plugin/marketplace.json` with `name`, `owner`, `plugins[{name, source, description}]`; checked by `claude plugin validate` | plugin-marketplaces docs |
| The docs give no sample of `/context` output | docs search found none |

## Deviations / scope decisions (flag at approval)

- **`server-side-drain` is NOT built.** It needs your reported plan usage and a documented limit formula; neither exists, and any "your limit drained for server reasons" claim would be a guess. `lean doctor` already says its numbers come from local transcripts. Say so if you want a `--limit-hit-at` experiment anyway.
- **`ttl-regression` becomes `cache-ttl-5m`.** The spec's version-regression claim (2.1.218+) is an unverified GitHub claim. The rule instead detects what is measurable and documented: cache rebuilds after 5 to 60 minute pauses (they would have survived a 1-hour TTL) and points at the documented `promptCacheTtl`, with the cost caveat.
- **`thinking-heavy` is an estimate and uses the `models` filter** (first real use): it only looks at models where thinking can be tuned (Opus/Sonnet 4.6 and older), so on a 5.x history it will not fire. The estimate is `output tokens - visible text/tool-input size/3.6` on responses that contain a thinking block. Confidence `unverified`.
- **Hook findings stay advice**, but now name the biggest sources ("plugin-x 62%"). Auto-disabling a whole plugin because one hook is chatty is too blunt. **MCP gets a real fix** (`denyMcp`, blocks persistently failing servers) but the rule is `unverified` (internal transcript format), so it needs `--include-unverified`.
- **`/context` parsing is built on an assumed text shape** (docs show none). It is tested on synthetic samples of the common layouts; paste your real `/context` output once and I will harden it.
- Not done by me: the live Claude Code smoke test of the guards plugin (costs your tokens), and the spec's reference-user acceptance numbers (871/551 requests; they exist only in that user's data).

## Invariants (unchanged)
- One API response = many transcript lines; requests are keyed by `message.id`; every new accumulator is keyed by line `uuid` so repeated lines never double count.
- Privacy (public repo): no real paths/names/emails in code, tests, docs or commits. New per-session fields that hold names or commands (`hookByCommand`, `failedMcpNames`) never reach `lean share`; the sentinel test is extended to prove it.
- Rules ship `official` only with a docs URL actually fetched; internal-format or heuristic-estimate rules are `unverified` and skipped by `lean fix` unless `--include-unverified`.

## File structure

```
src/summarize.js     MOD  new counters
src/metrics.js       MOD  compactCold, mcpPersistent, thinkingShare; hookInjection attribution
src/config.js        MOD  hookOwners map
src/fix.js           MOD  denyMcp op
src/rules.js         MOD  EDIT_OPS gains denyMcp
src/context.js       NEW  parseContext / formatContext
bin/lean.js          MOD  fix loads transcripts when needed; doctor --context
rules/*.json         +7 new, 2 rewritten (mcp-failing, hook-stdout-big)
.claude-plugin/marketplace.json   NEW (repo root)
plugin/.claude-plugin/icon.png    NEW
test/*               MOD/NEW as listed per task
README.md, package.json, plugin/.claude-plugin/plugin.json   MOD (version 0.3.0)
```

---

### Task 1: Summarizer counters

**Files:**
- Modify: `test/helpers.js`, `test/summarize.test.js`, `src/summarize.js`

- [ ] **Step 1: Branch**

Run: `git checkout -b plan-4-remaining`

- [ ] **Step 2: Update `test/helpers.js`** (read it first). Make these edits:

1. `assistantLine`: add a `uuid` parameter and field. Replace
```js
export function assistantLine({ id = `m${++seq}`, cr = 0, cc = 0, input = 0, out = 1, at = 0, model = 'claude-sonnet-5-5', content = [] } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: iso(at), version: '2.1.300',
```
with
```js
export function assistantLine({ id = `m${++seq}`, cr = 0, cc = 0, input = 0, out = 1, at = 0, model = 'claude-sonnet-5-5', content = [], uuid } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: iso(at), version: '2.1.300', uuid,
```
2. `req` default: replace `ts: null, gapMs: null, ...o });` with `ts: null, gapMs: null, thinking: false, visible: 0, ...o });`
3. `sess` defaults: replace `hookChars: {}, mcpFailures: 0, unsupported: false, ...o,` with
```js
  hookChars: {}, hookByCommand: {}, mcpFailures: 0, failedMcpNames: [], unsupported: false,
  skillListingChars: 0, compactions: [], scheduledFires: 0, bigBashResults: 0, firstSearchCalls: 0, ...o,
```
4. `hookLine`: replace its definition with a version that takes the command:
```js
export const hookLine = (event, chars, uuid = `h${++seq}`, command = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/a.mjs"') =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'hook_success', hookEvent: event, command, stdout: 'x'.repeat(chars), content: `${event} hook success` } });
```
5. Append:
```js
export const compactLine = (uuid, at, preTokens = 200000, trigger = 'manual') =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: iso(at), compactMetadata: { trigger, preTokens, postTokens: 10000, durationMs: 1000 } });

export const scheduledLine = (uuid, at) =>
  JSON.stringify({ type: 'system', subtype: 'scheduled_task_fire', uuid, timestamp: iso(at), taskKind: 'loop', cronKind: 'loop' });

export const skillListingLine = (uuid, chars) =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'skill_listing', content: 'x'.repeat(chars), skillCount: 3, names: ['a', 'b', 'c'] } });
```
(`cfg` gets `hookOwners` in Task 3.)

- [ ] **Step 3: Add failing tests to `test/summarize.test.js`**

Change the helpers import to also include `compactLine, scheduledLine, skillListingLine`, then append:

```js
test('compactions record size, trigger and the idle gap before them; fires and skill listing count once', () => {
  const min = 60_000;
  const s = summarizeLines([
    assistantLine({ id: 'a', cr: 100, at: 0 }),
    compactLine('c1', 20 * min, 250000, 'manual'),
    compactLine('c1', 20 * min, 250000, 'manual'), // repeated line
    scheduledLine('f1', 21 * min), scheduledLine('f1', 21 * min), scheduledLine('f2', 22 * min),
    skillListingLine('k1', 12000), skillListingLine('k2', 30000), skillListingLine('k1', 12000),
  ]);
  assert.deepEqual(s.compactions, [{ preTokens: 250000, trigger: 'manual', gapMs: 20 * min - 1000 }]);
  assert.equal(s.scheduledFires, 2);
  assert.equal(s.skillListingChars, 30000);
});

test('hook output is also kept per event and command; failed MCP servers are kept by name', () => {
  const s = summarizeLines([
    hookLine('SessionStart', 100, 'h1', 'cmdA'), hookLine('SessionStart', 50, 'h2', 'cmdA'), hookLine('UserPromptSubmit', 70, 'h3', 'cmdB'),
    mcpFailLine('m1'), mcpFailLine('m2', [{ name: 'demo', errorCode: 'x' }]), mcpFailLine('m3', [{ name: 'other' }]),
  ]);
  assert.deepEqual(s.hookByCommand, { SessionStart: { cmdA: 150 }, UserPromptSubmit: { cmdB: 70 } });
  assert.deepEqual([...s.failedMcpNames].sort(), ['demo', 'other']);
  assert.equal(s.mcpFailures, 2);
});

test('thinking and visible size accumulate per request across its lines, once per line uuid', () => {
  const think = { type: 'thinking', thinking: '', signature: 'sig' };
  const text = { type: 'text', text: 'x'.repeat(360) };
  const s = summarizeLines([
    assistantLine({ id: 'a', out: 2000, uuid: 'u1', content: [think] }),
    assistantLine({ id: 'a', out: 2000, uuid: 'u2', content: [text] }),
    assistantLine({ id: 'a', out: 2000, uuid: 'u2', content: [text] }), // repeated line
  ]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].thinking, true);
  assert.equal(s.requests[0].visible, 360);
});

test('first-turn search calls and big Bash results are counted', () => {
  const searches = Array.from({ length: 25 }, (_, i) => toolUse(`t${i}`, i % 2 ? 'Grep' : 'Glob'));
  const s = summarizeLines([
    assistantLine({ id: 'a', content: searches }),
    assistantLine({ id: 'b', content: [toolUse('b1', 'Bash'), toolUse('b2', 'Bash')] }),
    toolResultLine('b1', 'x'.repeat(25000)),
    toolResultLine('b2', 'short'),
  ]);
  assert.equal(s.firstSearchCalls, 20, 'only the first 20 tool calls of a session count');
  assert.equal(s.bigBashResults, 1);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npm test`
Expected: the four new tests FAIL; everything earlier passes.

- [ ] **Step 5: Replace `src/summarize.js`** (read it first)

```js
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Every computer-use action returns a screenshot, so all calls to the tool count.
const SCREENSHOT_TOOL = /(__computer$|screenshot)/i;
const SEARCH_TOOLS = new Set(['Grep', 'Glob']);
const BIG_RESULT_CHARS = 20000;
const FIRST_CALLS = 20;
// Line shapes verified on real transcripts (Plan 2 Task 1, Plan 4 research). Only `hook_success` is counted:
// hook_additional_context / hook_system_message / hook_non_blocking_error would double count the text.
const hookEvent = (a) => a.hookEvent || String(a.hookName || '').split(':')[0] || '?';
const HOOK_TEXT = (a) => String(a.stdout ?? a.content ?? '');

export function createSummarizer(file = '') {
  const reqs = new Map();      // message id -> request (one API response spans many lines)
  const toolNames = new Map(); // tool_use id -> tool name
  const seen = new Set();      // uuids of non-assistant lines (a resumed session repeats lines)
  const seenAsst = new Set();  // uuids of assistant lines: block accumulation must not double count
  const failedMcp = new Set(); // distinct failed MCP servers (deltas re-list them)
  let toolSeq = 0;
  let lastAssistantTs = null;
  const s = {
    file, toolVolume: {}, imageResults: 0, imageBytes: 0, screenshotCalls: 0, agentSpawns: 0, version: null,
    hookChars: {}, hookByCommand: {}, mcpFailures: 0, failedMcpNames: [], assistantLines: 0, usageLines: 0,
    skillListingChars: 0, compactions: [], scheduledFires: 0, bigBashResults: 0, firstSearchCalls: 0,
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
      const n = HOOK_TEXT(a).length;
      s.hookChars[ev] = (s.hookChars[ev] || 0) + n;
      const byCmd = (s.hookByCommand[ev] ??= {});
      const cmd = String(a.command || '');
      byCmd[cmd] = (byCmd[cmd] || 0) + n;
      return;
    }
    if (o.type === 'attachment' && a?.type === 'deferred_tools_delta') {
      for (const e of Array.isArray(a.failedMcpServers) ? a.failedMcpServers : []) failedMcp.add(typeof e?.name === 'string' ? e.name : JSON.stringify(e));
      s.mcpFailures = failedMcp.size;
      s.failedMcpNames = [...failedMcp];
      return;
    }
    if (o.type === 'attachment' && a?.type === 'skill_listing') {
      s.skillListingChars = Math.max(s.skillListingChars, String(a.content ?? '').length);
      return;
    }
    if (o.type === 'system' && o.subtype === 'compact_boundary') {
      const md = o.compactMetadata ?? {};
      const ts = o.timestamp ? Date.parse(o.timestamp) : null;
      // gap = idle time before the compaction started (boundary time minus its duration minus the last response)
      s.compactions.push({
        preTokens: md.preTokens || 0,
        trigger: md.trigger || '',
        gapMs: ts !== null && lastAssistantTs !== null ? ts - (md.durationMs || 0) - lastAssistantTs : null,
      });
      return;
    }
    if (o.type === 'system' && o.subtype === 'scheduled_task_fire') {
      s.scheduledFires++;
      return;
    }

    const m = o.message;
    if (!m) return;

    if (o.type === 'assistant') {
      s.assistantLines++;
      if (!o.isSidechain && o.timestamp) lastAssistantTs = Date.parse(o.timestamp);
      const fresh = !o.uuid || !seenAsst.has(o.uuid);
      if (o.uuid) seenAsst.add(o.uuid);
      const blocks = Array.isArray(m.content) ? m.content : [];
      let visible = 0;
      let thinking = false;
      if (fresh) {
        for (const c of blocks) {
          if (c.type === 'text') visible += (c.text || '').length;
          else if (c.type === 'tool_use') visible += JSON.stringify(c.input ?? {}).length;
          else if (c.type === 'thinking') thinking = true;
        }
      }
      if (m.usage) {
        s.usageLines++;
        const u = m.usage;
        const key = m.id || o.requestId || o.uuid;
        const prev = reqs.get(key);
        reqs.set(key, {
          ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
          cc: u.cache_creation_input_tokens || 0,
          cr: u.cache_read_input_tokens || 0,
          out: u.output_tokens || 0,
          model: m.model || '',
          ts: o.timestamp ? Date.parse(o.timestamp) : null,
          thinking: Boolean(prev?.thinking) || thinking,
          visible: (prev?.visible ?? 0) + visible,
        });
      }
      for (const c of blocks) {
        if (c.type !== 'tool_use' || toolNames.has(c.id)) continue;
        toolNames.set(c.id, c.name);
        toolSeq++;
        if (toolSeq <= FIRST_CALLS && SEARCH_TOOLS.has(c.name)) s.firstSearchCalls++;
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
        const name = toolNames.get(c.tool_use_id);
        if (name === 'Bash' && chars >= BIG_RESULT_CHARS) s.bigBashResults++;
        bump(name || '?', chars);
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

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS (the earlier `mcpFailures === 2` test still holds: servers are now keyed by name).

- [ ] **Step 7: Commit**

```bash
git add test/helpers.js test/summarize.test.js src/summarize.js docs/superpowers/plans/2026-11-14-claude-lean-remaining-rules.md
git commit -m "feat: summarizer counters for compactions, scheduled fires, skill list, thinking, big Bash results, hook sources" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Hook-source config, new metrics, seven rules

**Files:**
- Modify: `test/helpers.js`, `test/config.test.js`, `src/config.js`, `test/metrics.test.js`, `src/metrics.js`, `test/rules.test.js`, `test/share.test.js`
- Create: 7 files in `rules/`; rewrite `rules/mcp-failing.json`, `rules/hook-stdout-big.json`

- [ ] **Step 1: `cfg` helper.** In `test/helpers.js`, add `hookOwners: new Map(),` after `env: {}, plugins: [], duplicates: [],` inside `cfg`.

- [ ] **Step 2: Failing config test.** Append to `test/config.test.js`:

```js
test('hookOwners maps a hook command to the plugin whose hooks.json holds it, or to settings', () => {
  const claudeDir = dirWith({
    'settings.json': JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'my-own-hook' }] }] } }),
    'pluginA/hooks/hooks.json': JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node "${CLAUDE_PLUGIN_ROOT}/x.mjs"' }] }] } }),
  });
  mkdirSync(join(claudeDir, 'plugins'), { recursive: true });
  writeFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'a@m': [{ scope: 'user', installPath: join(claudeDir, 'pluginA') }], 'b@m': [{ installPath: join(claudeDir, 'missing') }] } }));
  const c = loadConfig({ claudeDir, cwd: dirWith(), env: {} });
  assert.equal(c.hookOwners.get('node "${CLAUDE_PLUGIN_ROOT}/x.mjs"'), 'a@m');
  assert.equal(c.hookOwners.get('my-own-hook'), 'settings hooks');
  assert.equal(c.hookOwners.size, 2);
});

test('hookOwners is empty (no crash) when installed_plugins.json is missing or broken', () => {
  assert.equal(loadConfig({ claudeDir: dirWith(), cwd: dirWith(), env: {} }).hookOwners.size, 0);
  const broken = dirWith({ 'plugins/installed_plugins.json': '{ nope' });
  assert.equal(loadConfig({ claudeDir: broken, cwd: dirWith(), env: {} }).hookOwners.size, 0);
});
```
Run `npm test`: expected FAIL (`hookOwners` undefined).

- [ ] **Step 3: Implement `hookOwners` in `src/config.js`.** Add above `loadConfig`:

```js
const commandsIn = (hooks) => Object.values(hooks ?? {}).flatMap((list) => (Array.isArray(list) ? list : [])).flatMap((e) => e?.hooks ?? []).map((h) => h?.command).filter(Boolean);

// command string -> where it comes from. A plugin hook is recorded with a literal ${CLAUDE_PLUGIN_ROOT}, so it is
// matched against each installed plugin's own hooks/hooks.json; user/project settings hooks are matched by command.
function hookOwners(claudeDir, settings) {
  const owners = new Map();
  try {
    const { plugins = {} } = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [id, entries] of Object.entries(plugins)) {
      for (const e of Array.isArray(entries) ? entries : [entries]) {
        try {
          for (const c of commandsIn(JSON.parse(readFileSync(join(e.installPath, 'hooks', 'hooks.json'), 'utf8')).hooks)) owners.set(c, id);
        } catch { /* plugin without hooks, or unreadable */ }
      }
    }
  } catch { /* no installed plugins file */ }
  for (const c of commandsIn(settings.hooks)) owners.set(c, 'settings hooks');
  return owners;
}
```
and add `hookOwners: hookOwners(claudeDir, settings),` to the object returned by `loadConfig` (after `duplicates,`).

Run `npm test`: config tests PASS.

- [ ] **Step 4: Failing metric tests.** Append to `test/metrics.test.js`:

```js
test('compactCold counts big compactions after an idle gap and sums the tokens', () => {
  const min = 60_000;
  const s = sess([req(1)], { compactions: [
    { preTokens: 250000, trigger: 'manual', gapMs: 20 * min },
    { preTokens: 250000, trigger: 'manual', gapMs: 1 * min },
    { preTokens: 30000, trigger: 'auto', gapMs: 30 * min },
    { preTokens: 300000, trigger: 'auto', gapMs: null },
  ] });
  const r = metrics.compactCold([s], { minTokens: 100000, gapMinMs: 5 * min, minCount: 1 });
  assert.equal(r.hit, true);
  assert.equal(r.weightTokens, 250000);
  assert.match(r.evidence, /1 compactions of >=100k tokens.*250k tokens/);
  assert.equal(metrics.compactCold([s], { minTokens: 100000, gapMinMs: 5 * min, minCount: 2 }).hit, false);
});

test('mcpPersistent needs the same server to fail in enough sessions and returns its name as a target', () => {
  const flaky = () => sess([req(1)], { failedMcpNames: ['demo'] });
  const r = metrics.mcpPersistent([flaky(), flaky(), flaky(), sess([req(1)], { failedMcpNames: ['once'] })], { minSessions: 3 });
  assert.equal(r.hit, true);
  assert.deepEqual(r.targets, ['demo']);
  assert.doesNotMatch(r.evidence, /demo|once/, 'evidence never names servers');
  assert.equal(metrics.mcpPersistent([flaky(), flaky()], { minSessions: 3 }).hit, false);
});

test('thinkingShare estimates hidden thinking from output size on responses that contain a thinking block', () => {
  const think = (o = {}) => req(10e3, { out: 3000, thinking: true, visible: 360, ...o });
  const many = Array.from({ length: 60 }, () => think());
  const r = metrics.thinkingShare([sess(many)], { minTokens: 100000, minShare: 0.3 });
  assert.equal(r.hit, true);
  assert.equal(r.weightTokens, 174000);
  assert.match(r.evidence, /estimate/);
  assert.equal(metrics.thinkingShare([sess(many.map(() => think({ thinking: false })))], { minTokens: 1, minShare: 0.1 }).hit, false);
  assert.equal(metrics.thinkingShare([], { minTokens: 1, minShare: 0.1 }).hit, false);
});

test('hookInjection names the biggest sources when owners are known', () => {
  const s = sess([req(1)], { hookChars: { SessionStart: 36000 }, hookByCommand: { SessionStart: { cmdA: 30000, cmdB: 6000 } } });
  const config = cfg({ hookOwners: new Map([['cmdA', 'plugin-a@m'], ['cmdB', 'settings hooks']]) });
  const r = metrics.hookInjection([s], { above: 3000, events: ['SessionStart'] }, config);
  assert.match(r.evidence, /biggest sources: plugin-a@m 83%, settings hooks 17%/);
  assert.match(metrics.hookInjection([s], { above: 3000, events: ['SessionStart'] }).evidence, /biggest sources: unknown source 100%/);
});
```
Run `npm test`: FAIL (`compactCold is not a function`, etc.).

- [ ] **Step 5: Implement in `src/metrics.js`.** Replace the existing `hookInjection` entry with:

```js
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
```
and add before the closing `};` of `metrics`:

```js
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
    const counts = new Map();
    for (const s of sessions) for (const name of s.failedMcpNames ?? []) counts.set(name, (counts.get(name) ?? 0) + 1);
    const targets = [...counts].filter(([, c]) => c >= minSessions).map(([name]) => name).sort();
    return { hit: targets.length > 0, weightTokens: 0, targets, evidence: `${targets.length} MCP server(s) failed to connect in at least ${minSessions} sessions` };
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
```
Run `npm test`: metric tests PASS (the Plan 3 `hookInjection` test still matches `~10k tokens per session`).

- [ ] **Step 6: Failing rule tests.** In `test/rules.test.js` (read it first): change `assert.equal(rules.length, 23);` to `30`, and replace these two lines in the `hook-stdout-big and mcp-failing` test
```js
  assert.equal(evaluate(pick('mcp-failing'), [sess([req(1)], { mcpFailures: 2 })], cfg()).length, 1);
  assert.equal(evaluate(pick('mcp-failing'), [sess([req(1)])], cfg()).length, 0);
```
with
```js
  const flaky = () => sess([req(1)], { failedMcpNames: ['demo'] });
  const hit = evaluate(pick('mcp-failing'), [flaky(), flaky(), flaky()], cfg());
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].targets, ['demo']);
  assert.equal(evaluate(pick('mcp-failing'), [flaky(), flaky()], cfg()).length, 0);
```
Then append:

```js
test('the seven remaining transcript rules fire and stay quiet', () => {
  const min = 60_000;
  const fire = (id, ...sessions) => evaluate(loadRules().filter((r) => r.id === id), sessions, cfg()).length;
  assert.equal(fire('skill-desc-verbose', sess([req(1)], { skillListingChars: 30000 })), 1);
  assert.equal(fire('skill-desc-verbose', sess([req(1)], { skillListingChars: 5000 })), 0);
  const compact = (preTokens, gapMs) => sess([req(1)], { compactions: [{ preTokens, trigger: 'manual', gapMs }] });
  assert.equal(fire('compact-cold', compact(250000, 20 * min)), 1);
  assert.equal(fire('compact-cold', compact(250000, 1 * min)), 0);
  assert.equal(fire('compact-cold', compact(20000, 20 * min)), 0);
  assert.equal(fire('loop-idle', sess([req(1)], { scheduledFires: 5 })), 1);
  assert.equal(fire('loop-idle', sess([req(1)], { scheduledFires: 1 })), 0);
  assert.equal(fire('verbose-output', sess([req(1)], { bigBashResults: 4 })), 1);
  assert.equal(fire('verbose-output', sess([req(1)], { bigBashResults: 1 })), 0);
  assert.equal(fire('vague-prompt-scan', sess([req(1)], { firstSearchCalls: 15 })), 1);
  assert.equal(fire('vague-prompt-scan', sess([req(1)], { firstSearchCalls: 3 })), 0);
  const rebuilds = (gapMs) => sess([0, 1, 2].map(() => req(200e3, { cc: 200e3, gapMs })));
  assert.equal(fire('cache-ttl-5m', rebuilds(20 * min)), 1);
  assert.equal(fire('cache-ttl-5m', rebuilds(2 * 60 * min)), 0, 'a 2 hour gap is past even a 1-hour TTL');
  assert.equal(fire('cache-ttl-5m', rebuilds(2 * min)), 0, 'a 2 minute gap is a mid-session rebuild, not a TTL expiry');
});

test('thinking-heavy only looks at models where thinking can be tuned (the models filter in use)', () => {
  const many = (model) => sess(Array.from({ length: 60 }, () => req(10e3, { model, out: 3000, thinking: true, visible: 360 })));
  const fire = (s) => evaluate(loadRules().filter((r) => r.id === 'thinking-heavy'), [s], cfg()).length;
  assert.equal(fire(many('claude-sonnet-4-6')), 1);
  assert.equal(fire(many('claude-sonnet-5-5')), 0, 'always-adaptive models are skipped');
  assert.equal(fire(many('claude-opus-5-5')), 0);
});
```
Run `npm test`: FAIL (rule files missing).

- [ ] **Step 7: Write the rule files.** New files (confidence/sources per the table above):

`rules/skill-desc-verbose.json`
```json
{
  "id": "skill-desc-verbose",
  "title": "The skill list sent every session is very large",
  "source": "unverified: measured from skill_listing attachments in transcripts (internal format). Budget and controls: https://code.claude.com/docs/en/env-vars (SLASH_COMMAND_TOOL_CHAR_BUDGET), https://code.claude.com/docs/en/skills (disable-model-invocation)",
  "confidence": "unverified",
  "detect": { "metric": "maxPerSession", "field": "skillListingChars", "min": 20000 },
  "fix": { "type": "advice", "text": "Every session starts with the names and descriptions of all enabled skills. Disable plugins you do not use, set disable-model-invocation: true on skills only you should trigger, and shorten long descriptions." }
}
```
`rules/compact-cold.json`
```json
{
  "id": "compact-cold",
  "title": "Large compactions after a long break",
  "source": "https://code.claude.com/docs/en/costs (/compact reads the conversation it summarizes, so compacting a large context is itself a large request); https://code.claude.com/docs/en/prompt-caching; measured from compact_boundary lines",
  "confidence": "official",
  "detect": { "metric": "compactCold", "minTokens": 100000, "gapMinMs": 300000, "minCount": 1 },
  "fix": { "type": "advice", "text": "Compact while the cache is still warm (before you step away), or /clear and start fresh. Compacting a large context after a long break has to read all of it without a warm cache." }
}
```
`rules/loop-idle.json`
```json
{
  "id": "loop-idle",
  "title": "Loops or scheduled tasks fire while the session is idle",
  "source": "https://code.claude.com/docs/en/costs (a session-scoped scheduled task fires on its interval even while the session is idle, sending your full context each time); measured from scheduled_task_fire lines",
  "confidence": "official",
  "detect": { "metric": "maxPerSession", "field": "scheduledFires", "min": 3 },
  "fix": { "type": "advice", "text": "Stop /loop and scheduled tasks you no longer need; each firing resends your whole context, even while you are away. Keep looping sessions small." }
}
```
`rules/thinking-heavy.json`
```json
{
  "id": "thinking-heavy",
  "title": "Large share of output looks like hidden thinking",
  "source": "unverified: estimate from output-token size (thinking text is mostly omitted from transcripts); settings and model behavior: https://code.claude.com/docs/en/env-vars (MAX_THINKING_TOKENS), https://code.claude.com/docs/en/settings-reference (alwaysThinkingEnabled)",
  "confidence": "unverified",
  "models": ["opus-4-6", "sonnet-4-6", "opus-4-5", "sonnet-4-5", "haiku-4-5", "opus-4-1", "claude-opus-4-2", "claude-sonnet-4-2", "3-7-sonnet"],
  "detect": { "metric": "thinkingShare", "minTokens": 100000, "minShare": 0.3 },
  "fix": { "type": "advice", "text": "Thinking is billed as output. Lower effort with /effort, or set alwaysThinkingEnabled to false, for routine work. Models that always use adaptive reasoning (Fable, Sonnet 5 and later, Haiku 5.5, Opus 4.7 and later) are excluded because thinking cannot be turned off there." }
}
```
`rules/vague-prompt-scan.json`
```json
{
  "id": "vague-prompt-scan",
  "title": "Broad search fan-out at the start of a session",
  "source": "unverified: heuristic (Grep/Glob calls among a session's first 20 tool calls); background: https://code.claude.com/docs/en/costs (write specific prompts)",
  "confidence": "unverified",
  "detect": { "metric": "maxPerSession", "field": "firstSearchCalls", "min": 12 },
  "fix": { "type": "advice", "text": "Name the file, function or directory in your first prompt, or start in plan mode, so Claude does not search across the whole repo before it begins." }
}
```
`rules/verbose-output.json`
```json
{
  "id": "verbose-output",
  "title": "Very long command output enters the context",
  "source": "https://code.claude.com/docs/en/costs (custom hooks can preprocess data before Claude sees it; example PreToolUse hook trims test output to its last 100 lines); measured from Bash results of 20,000+ characters",
  "confidence": "official",
  "detect": { "metric": "maxPerSession", "field": "bigBashResults", "min": 3 },
  "fix": { "type": "advice", "text": "Trim long command output before it reaches Claude: pipe through tail, or use a PreToolUse hook that keeps the last 100 lines (example in the costs docs)." }
}
```
`rules/cache-ttl-5m.json`
```json
{
  "id": "cache-ttl-5m",
  "title": "Cache expired within an hour (five-minute lifetime in effect)",
  "source": "https://code.claude.com/docs/en/prompt-caching (five-minute and one-hour TTLs; promptCacheTtl / CLAUDE_CODE_PROMPT_CACHE_TTL take 5m or 1h; one-hour cache writes cost more). Replaces the spec's ttl-regression, whose version claim is unverified.",
  "confidence": "official",
  "detect": { "metric": "cacheRebuilds", "minTokens": 100000, "gapMinMs": 300000, "gapMaxMs": 3600000, "minCount": 3 },
  "fix": { "type": "advice", "text": "Rebuilds after pauses of 5 to 60 minutes mean those requests had the five-minute cache lifetime. If you pause like that often, set promptCacheTtl to 1h (settings, or CLAUDE_CODE_PROMPT_CACHE_TTL). The API bills one-hour cache writes at a higher rate, so it only pays off if you regularly come back within the hour." }
}
```
Rewrite `rules/mcp-failing.json`:
```json
{
  "id": "mcp-failing",
  "title": "MCP servers keep failing to connect",
  "source": "unverified: failed servers read from transcript attachments (internal format); setting deniedMcpServers (entry {\"serverName\": ...}) documented at https://code.claude.com/docs/en/settings-reference and https://code.claude.com/docs/en/mcp",
  "confidence": "unverified",
  "needs": "transcripts",
  "detect": { "metric": "mcpPersistent", "minSessions": 3 },
  "fix": { "type": "settings", "text": "Block MCP servers that fail to connect in several sessions (deniedMcpServers). A configured but broken server still costs startup time. Delete its entry to bring it back.", "edit": { "op": "denyMcp" } }
}
```
Rewrite `rules/hook-stdout-big.json` (same detect; new fix text only):
```json
{
  "id": "hook-stdout-big",
  "title": "Hooks inject a lot of text into every session",
  "source": "unverified: measured from hook_success attachment lines in transcripts (internal format); character-based estimate (chars/3.6); sources found by matching each hook command to installed plugins' hooks/hooks.json",
  "confidence": "unverified",
  "detect": { "metric": "hookInjection", "above": 3000, "events": ["SessionStart", "UserPromptSubmit"] },
  "fix": { "type": "advice", "text": "That text stays in context and is re-read on every request. The finding lists the biggest sources (plugin or settings hook); shorten that hook's output, or disable the plugin if you do not need its hook." }
}
```

- [ ] **Step 8: Extend the share sentinel fixture** (in `test/share.test.js`, `fixture()`): add `hookByCommand: { SessionStart: { 'node SECRET_CMD': 100 } }, failedMcpNames: ['SECRET_MCP'], compactions: [{ preTokens: 1, trigger: 'x', gapMs: 1 }]` to `s1`'s overrides and `hookOwners: new Map([['node SECRET_CMD', 'SECRET_PLUGIN@m']])` to `config`. The existing "no path, name or text" assertion must still pass without changing `buildShare`.

- [ ] **Step 9: Run tests**

Run: `npm test`
Expected: all PASS (30 rules, new rule tests, share sentinel still clean).

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: seven remaining rules, persistent-MCP and hook-source detection, thinking estimate" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `denyMcp` fix op and `lean fix` loading transcripts when needed

**Files:**
- Modify: `test/fix.test.js`, `src/fix.js`, `src/rules.js`, `test/cli.test.js`, `bin/lean.js`

- [ ] **Step 1: Failing unit test.** Append to `test/fix.test.js`:

```js
test('denyMcp adds one serverName entry per failing server, idempotently, keeping existing entries', () => {
  const f = finding({ op: 'denyMcp' }, { targets: ['flaky', 'old'] });
  const plan = planFix({ deniedMcpServers: [{ serverName: 'old' }] }, [f]);
  assert.deepEqual(plan.next.deniedMcpServers, [{ serverName: 'old' }, { serverName: 'flaky' }]);
  assert.deepEqual(plan.done, ['deny MCP server flaky']);
  assert.equal(planFix(plan.next, [f]).done.length, 0);
  assert.deepEqual(planFix({}, [finding({ op: 'denyMcp' }, { targets: ['x'] })]).next, { deniedMcpServers: [{ serverName: 'x' }] });
});
```
Run `npm test`: FAIL (unknown op).

- [ ] **Step 2: Implement.** In `src/fix.js` add inside `OPS` (after `disablePlugin`):

```js
  denyMcp(s, _e, targets) {
    const out = R();
    s.deniedMcpServers ??= [];
    for (const t of targets) {
      if (s.deniedMcpServers.some((e) => e?.serverName === t)) continue;
      s.deniedMcpServers.push({ serverName: t });
      out.done.push(`deny MCP server ${t}`);
    }
    if (!s.deniedMcpServers.length) delete s.deniedMcpServers;
    return out;
  },
```
In `src/rules.js` change `EDIT_OPS` to `['setKey', 'setEnv', 'removeEnv', 'disablePlugin', 'denyMcp']`.

Run `npm test`: PASS.

- [ ] **Step 3: Failing CLI test.** Append to `test/cli.test.js`:

```js
test('fix denies an MCP server that failed in several sessions (unverified rule: needs the flag), from transcripts', () => {
  const files = {};
  for (let i = 0; i < 3; i++) files[`claude/projects/p/s${i}.jsonl`] = [assistantLine({ id: `a${i}`, cr: 10 }), mcpFailLine(`m${i}`, [{ name: 'flaky' }])].join('\n');
  const dir = tmp({ 'claude/settings.json': '{}', ...files });
  const claudeDir = join(dir, 'claude');
  const plain = lean(['fix', '--claude-dir', claudeDir], dir);
  assert.match(plain, /skipped \(unverified.*mcp-failing/);
  const dry = lean(['fix', '--include-unverified', '--claude-dir', claudeDir], dir);
  assert.match(dry, /would: deny MCP server flaky/);
  lean(['fix', '--apply', '--include-unverified', '--claude-dir', claudeDir], dir);
  assert.deepEqual(JSON.parse(readFileSync(join(claudeDir, 'settings.json'), 'utf8')).deniedMcpServers, [{ serverName: 'flaky' }]);
});
```
Add `mcpFailLine` to the helpers import at the top of `test/cli.test.js`. Run `npm test`: FAIL (fix does not read transcripts).

- [ ] **Step 4: Replace `bin/lean.js`** (read it first). Full new file:

```js
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
```
(`src/context.js` is created in Task 4; run only Task 3's CLI test after Task 4, or create an empty stub first: `export const parseContext = () => null; export const formatContext = () => '';`.)

- [ ] **Step 5: Run tests; commit**

Run: `npm test` (with the stub if Task 4 is not done yet). Expected: all PASS, including the existing fix tests (their claude dirs have no `projects`, which is now optional for `fix`).
```bash
git add -A && git commit -m "feat: denyMcp fix op; fix reads transcripts only for rules that need them" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `/context` parser

**Files:**
- Create: `test/context.test.js`, `src/context.js`
- Modify: `test/cli.test.js`

- [ ] **Step 1: Failing tests `test/context.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContext, parseContext } from '../src/context.js';

const LIST = `
claude-sonnet-5-5 · 142k/200k tokens (71%)
⛁ ⛁ ⛁ ⛁ ⛁ ⛁
⛁ System prompt: 6.2k tokens (3.1%)
⛁ System tools: 17.4k tokens (8.7%)
⛁ MCP tools: 31.5k tokens (15.8%)
⛁ Memory files: 5.1k tokens (2.6%)
⛁ Skills: 12.0k tokens (6.0%)
⛁ Messages: 8.4k tokens (4.2%)
⛶ Free space: 58k (29%)
⛝ Autocompact buffer: 33k tokens (16.5%)
`;

const TABLE = `
| Category | Tokens | Share |
| MCP tools | 31.5k tokens | 15.8% |
| Skills | 12,000 tokens | 6.0% |
`;

test('parseContext reads list-style output: ranks categories, finds the total, drops free space and buffers', () => {
  const p = parseContext(LIST);
  assert.deepEqual(p.total, { used: 142000, limit: 200000 });
  assert.deepEqual(p.items.map((i) => i.label), ['MCP tools', 'System tools', 'Skills', 'Messages', 'System prompt', 'Memory files']);
  assert.equal(p.items[0].tokens, 31500);
});

test('parseContext reads table-style rows and thousands separators', () => {
  const p = parseContext(TABLE);
  assert.deepEqual(p.items, [{ label: 'MCP tools', tokens: 31500 }, { label: 'Skills', tokens: 12000 }]);
  assert.equal(p.total, null);
});

test('parseContext ignores ANSI colors, blank and unrelated text', () => {
  assert.deepEqual(parseContext('\u001b[31mSkills: 2k tokens\u001b[0m\nhello world\n\n'), { items: [{ label: 'Skills', tokens: 2000 }], total: null });
  assert.deepEqual(parseContext(''), { items: [], total: null });
  assert.deepEqual(parseContext('nothing useful here'), { items: [], total: null });
});

test('formatContext ranks with shares and points at the fix for known categories', () => {
  const out = formatContext(parseContext(LIST), 'ctx.txt');
  assert.match(out, /Fixed overhead breakdown \(from the \/context output in ctx\.txt\)/);
  assert.match(out, /31\.5k\s+MCP tools .*disable MCP servers/);
  assert.match(out, /12\.0k\s+Skills .*disable plugins/);
  assert.match(out, /142\.0k of 200\.0k tokens used/);
});

test('formatContext says so when nothing was recognised', () => {
  assert.match(formatContext({ items: [], total: null }, 'ctx.txt'), /No token lines recognised in ctx\.txt/);
});
```
Append a CLI test to `test/cli.test.js`:
```js
test('doctor --context prints the overhead breakdown from a pasted /context file', () => {
  const dir = tmp({ 'ctx.txt': '⛁ MCP tools: 31.5k tokens (15.8%)\n⛁ Skills: 12.0k tokens (6.0%)\n' });
  const out = lean(['doctor', '--claude-dir', join(dir, 'claude'), '--file', bigSession(), '--context', join(dir, 'ctx.txt')], dir);
  assert.match(out, /Fixed overhead breakdown/);
  assert.match(out, /MCP tools/);
  const j = JSON.parse(lean(['doctor', '--json', '--claude-dir', join(dir, 'claude'), '--file', bigSession(), '--context', join(dir, 'ctx.txt')], dir));
  assert.equal(j.context.items[0].label, 'MCP tools');
});
```
Run `npm test`: FAIL.

- [ ] **Step 2: Write `src/context.js`**

```js
const ANSI = /\u001b\[[0-9;]*m/g;
const SKIP = /free space|autocompact buffer|^total$/i;
const HINTS = [
  [/mcp/i, 'disable MCP servers you do not need (/mcp)'],
  [/skill/i, 'disable plugins or skills you do not use'],
  [/memory|claude\.md/i, 'shorten CLAUDE.md / MEMORY.md; move workflows into skills'],
];
const num = (n, unit) => Math.round(parseFloat(n.replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[unit.toLowerCase()] ?? 1));
const k = (n) => `${(n / 1000).toFixed(1)}k`;

// Tolerant parser: any line shaped like "<label> ... <number>[k|m] tokens" is a category; a line shaped like
// "<used>/<limit> tokens" is the total. The /context layout is not documented, so this is deliberately loose.
export function parseContext(text) {
  const items = [];
  let total = null;
  for (const raw of String(text).replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.replace(/[│┃║|⛁⛶⛀⛝⛃●○·•■□▫▪]/g, ' ').replace(/\s+/g, ' ').trim();
    const t = line.match(/([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)\s*tokens/);
    if (t && total === null) {
      total = { used: num(t[1], t[2]), limit: num(t[3], t[4]) };
      continue;
    }
    const m = line.match(/^(.+?)[:\-–]?\s+([\d.,]+)\s*([kKmM]?)\s*tokens\b/);
    if (!m) continue;
    const label = m[1].replace(/[:\-–\s]+$/, '').trim();
    if (!label || SKIP.test(label)) continue;
    items.push({ label, tokens: num(m[2], m[3]) });
  }
  return { items: items.sort((a, b) => b.tokens - a.tokens), total };
}

export function formatContext({ items, total }, source) {
  if (!items.length) return `No token lines recognised in ${source}. Paste the output of /context into a text file and pass it with --context.`;
  const sum = items.reduce((t, i) => t + i.tokens, 0) || 1;
  const out = [`Fixed overhead breakdown (from the /context output in ${source}):`];
  if (total) out.push(`  ${k(total.used)} of ${k(total.limit)} tokens used`);
  for (const i of items) {
    const hint = HINTS.find(([re]) => re.test(i.label));
    out.push(`  ${k(i.tokens).padStart(7)}  ${i.label.padEnd(16)} ${String(Math.round((i.tokens / sum) * 100)).padStart(3)}%${hint ? `  -> ${hint[1]}` : ''}`);
  }
  return out.join('\n');
}
```
Run `npm test`: PASS. Check the exact-format assertions (`31.5k   MCP tools ... disable MCP servers`, `142.0k of 200.0k tokens used`) against real output and adjust the regexes in the test, not the facts.

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat: lean doctor --context parses a pasted /context breakdown" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Marketplace manifest, icon, version sync

**Files:**
- Create: `.claude-plugin/marketplace.json`, `plugin/.claude-plugin/icon.png`
- Modify: `test/plugin.test.js`, `package.json`, `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Failing tests.** Append to `test/plugin.test.js`:

```js
const repoRoot = fileURLToPath(new URL('../', import.meta.url));

test('marketplace manifest lists the plugin, uses a non-reserved name, and versions are in sync', () => {
  const mk = JSON.parse(readFileSync(join(repoRoot, '.claude-plugin', 'marketplace.json'), 'utf8'));
  assert.match(mk.name, /^[a-z0-9-]+$/);
  assert.doesNotMatch(mk.name, /^(claude|anthropic|anthropics|cc-plugin)(-|$)/, 'reserved marketplace name');
  assert.ok(mk.owner?.name);
  const entry = mk.plugins.find((p) => p.name === 'lean-guards');
  assert.ok(entry, 'lean-guards is listed');
  assert.equal(entry.source, './plugin');
  const manifest = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.equal(manifest.name, entry.name);
  assert.equal(manifest.version, JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')).version, 'plugin and package versions match');
});

test('the plugin ships a square PNG icon', () => {
  const png = readFileSync(join(root, '.claude-plugin', 'icon.png'));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  assert.equal(w, h);
  assert.ok(w >= 512 && w <= 2048);
  assert.ok(png.length < 2 * 1024 * 1024);
});
```
Run `npm test`: FAIL (files missing).

- [ ] **Step 2: Write `.claude-plugin/marketplace.json`**

```json
{
  "name": "lean-tools",
  "description": "Tools that find and stop what burns your Claude Code usage limit.",
  "owner": { "name": "claude-lean contributors" },
  "plugins": [
    {
      "name": "lean-guards",
      "source": "./plugin",
      "description": "Silent-by-default guards: context size, idle cache rebuilds, big images and screenshot loops."
    }
  ]
}
```

- [ ] **Step 3: Generate the icon** with a throwaway script outside the repo (zero dependencies, `node:zlib`):

```js
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const W = 512;
const px = (x, y) => {
  const bar = x >= 130 && x < 200 && y >= 110 && y < 400;        // vertical bar of an "L"
  const foot = x >= 130 && x < 390 && y >= 330 && y < 400;       // foot of the "L"
  const dot = (x - 340) ** 2 + (y - 170) ** 2 < 45 ** 2;         // a dot: "lean"
  if (bar || foot) return [245, 247, 250];
  if (dot) return [52, 211, 153];
  return [31, 41, 55];
};
const raw = Buffer.alloc(W * (W * 3 + 1));
for (let y = 0; y < W; y++) {
  raw[y * (W * 3 + 1)] = 0;
  for (let x = 0; x < W; x++) raw.set(px(x, y), y * (W * 3 + 1) + 1 + x * 3);
}
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type, data) => {
  const t = Buffer.from(type);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, sum]);
};
const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(W, 4); ihdr[8] = 8; ihdr[9] = 2;
writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
```
Run: `node <temp>/make-icon.mjs plugin/.claude-plugin/icon.png`.

- [ ] **Step 4: Bump versions** to `0.3.0` in `package.json` and `plugin/.claude-plugin/plugin.json`.

- [ ] **Step 5: Verify and commit**

Run: `npm test` (expected PASS), then `claude plugin validate ./plugin` and `claude plugin validate .`.
Expected: both pass (the icon warning is gone). If the marketplace validator rejects the name or schema, fix the manifest and re-run; do not weaken the test.
```bash
git add -A && git commit -m "feat: marketplace manifest and plugin icon; bump to 0.3.0" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Verify on real data

- [ ] **Step 1: Dedupe still holds.** Run the Plan 2 acceptance script (`accept.mjs` in the scratchpad) or an equivalent: for the three largest real transcripts `requests === distinct message ids`, `unsupported: false`.

- [ ] **Step 2: Calibrate the compaction gap.** Print, for each of the real compactions (5 in the reference history), `preTokens` and the computed `gapMs` in minutes (numbers only). Sanity check: manual `/compact` after a pause should show a gap, back-to-back work should show a small one. If every gap is ~0 because the compaction's own summary response is logged before the boundary, change `lastAssistantTs` to exclude assistant lines logged inside the compaction (for example only count the response that precedes the user line that started it) and add a regression test with that line order. Do not ship `compact-cold` until the numbers look plausible.

- [ ] **Step 3: Full report.** `node bin/lean.js doctor`: new findings appear only where the data supports them; `hook-stdout-big` shows "biggest sources" with plugin ids; no crash; note the run time.

- [ ] **Step 4: Fix dry run.** `node bin/lean.js fix --include-unverified`: shows `deny MCP server <name>` only for servers that failed in 3+ sessions; confirm the real `settings.json` is byte-identical afterwards (hash before/after) since nothing is applied.

- [ ] **Step 5: Share leak scan.** `node bin/lean.js share --out <temp>/share.json`, then
```bash
grep -niE "${USERNAME:-$USER}|Users|\.jsonl|@|mcp__|settings hooks" <temp>/share.json || echo "no leaks found"
```
Expected: `no leaks found` (also add every real plugin and MCP server name from your own setup to the pattern when you run it).

- [ ] **Step 6: Record**
```bash
git commit --allow-empty -m "test: Plan 4 verified on real transcripts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: README, privacy scan, finish

- [ ] **Step 1: Update `README.md`** (read it first): add the 7 new rules and the rewritten `mcp-failing` (now "keeps failing in 3+ sessions"; `lean fix` can block it with `deniedMcpServers`, needs `--include-unverified`) to the tables; document `lean doctor --context <file>` (paste `/context` output into a file; the layout is assumed, say so); document hook-source attribution in `hook-stdout-big`; document install for others: `claude plugin marketplace add <github-owner>/claude-lean` then `claude plugin install lean-guards@lean-tools`; list `cache-ttl-5m` as the replacement for the spec's `ttl-regression` and state plainly that `server-side-drain` is intentionally not built and why. Update the confidence sentence: which rules are `unverified` now (`plugin-count`, `mcp-failing`, `hook-stdout-big`, `skill-desc-verbose`, `vague-prompt-scan`, `thinking-heavy`). Use `~/.claude` and `<github-owner>`; no real names or paths.

- [ ] **Step 2: Privacy scan**
```bash
git add -A && git grep --cached -nIF -e "${USERNAME:-$USER}" -e "$(git config user.email)" -- . ; git grep --cached -nIiE "[A-Za-z]:[\\/]+Users" -- . ; echo scan-done
```
Expected: only `scan-done`.

- [ ] **Step 3: `npm test`** (all PASS), then commit:
```bash
git commit -am "docs: README for remaining rules, MCP fix, /context and marketplace install" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 4: Finish the branch** with superpowers:finishing-a-development-branch (tests first, then merge / PR / keep / discard; pushing to the public remote is your call).

---

## Self-review (against the spec and your request)

- **Spec rules still missing → now covered:** `skill-desc-verbose`, `compact-cold`, `loop-idle`, `thinking-heavy`, `vague-prompt-scan`, `verbose-output` (Task 2), `ttl-regression` as `cache-ttl-5m` (Task 2, deviation stated). `server-side-drain` consciously not built (stated with reason). Rule count 30 (spec 31 minus drain).
- **Plan 2 follow-ups:** `disableMcp` as `denyMcp` (Task 3, `unverified` so opt-in); hooks get source attribution instead of an auto-disable (stated); `/context` paste (Task 4); marketplace + icon (Task 5).
- **Models filter in real use:** `thinking-heavy` (Task 2) with a test proving 4.6 fires and 5.x is skipped.
- **Dedupe invariant:** every new accumulator is `uuid`-keyed or `message.id`-merged; Task 1 tests feed repeated lines and split responses; Task 6 Step 1 re-checks real data.
- **Privacy:** `hookByCommand`, `failedMcpNames`, `compactions` stay out of `lean share` (sentinel fixture extended in Task 2 Step 8, leak scan in Task 6 Step 5, scan in Task 7).
- **Placeholder scan:** none (the stub note in Task 3 Step 4 names exact code). **Name consistency:** `hookOwners`, `hookByCommand`, `failedMcpNames`, `skillListingChars`, `compactions`, `scheduledFires`, `bigBashResults`, `firstSearchCalls`, metrics `compactCold/mcpPersistent/thinkingShare`, op `denyMcp`, rule ids, and `needs: "transcripts"` match across tests, code and rules.
- **Not done by me:** live smoke test of the guards plugin; reference-user acceptance numbers.
