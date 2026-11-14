# claude-lean Guards Plugin + `lean share` Implementation Plan (Plan 3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin with four silent-by-default guards (context watchdog, idle guard, image guard, screenshot-loop guard) plus `lean share` (anonymized aggregate stats), so the tool stops runtime causes, not only reports them.

**Architecture:** All guard logic is pure functions in `plugin/lib/guards.mjs` (decisions take plain values, so they are unit-testable without Claude). Three tiny hook scripts read the hook JSON from stdin, call a decision function and print at most one JSON line. Everything the plugin needs lives inside `plugin/` (an installed plugin is copied alone, so it cannot import `../src`). `lean share` reuses the existing summaries/rules and emits only counts and rule ids.

**Tech Stack:** Node >= 18, zero dependencies, `node:test`. Plugin files use `.mjs` (an installed plugin has no `package.json`, so `.js` would be parsed as CommonJS and `import` would fail).

**Verified against the official hooks/plugin docs (fetched 2026-11-14):**
- `UserPromptSubmit` plain stdout is **injected into Claude's context** (costs tokens). The user-only channel is the JSON field `systemMessage`; it is delivered for `UserPromptSubmit`, `PreToolUse` and `PostToolUse` (discarded only for Setup, InstructionsLoaded, MessageDisplay, Notification, ConfigChange). So every guard prints **`{"systemMessage": "..."}`, never plain text**.
- `PreToolUse` deny: `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"..."}}`. The reason goes to Claude; this is the one guard that talks to the model, and it is short.
- Hook input is JSON on stdin with `session_id`, `transcript_path`, `cwd`, `tool_name`, `tool_input`. Exit 2 blocks, so **guards always exit 0**.
- Plugin layout: manifest `.claude-plugin/plugin.json`, hooks in `hooks/hooks.json`, `${CLAUDE_PLUGIN_ROOT}` for scripts, `CLAUDE_PLUGIN_DATA` (persistent dir, exported to the hook process) for state, `timeout` in seconds. Matcher: only letters/digits/`_`/`-`/space/`,`/`|` means exact names; anything else is an unanchored JavaScript regex (`mcp__.*` style).
- Cache TTL is 5 min or 1 hour depending on plan/auth (prompt-caching page), so the idle threshold is configurable (default 5) and the idle guard only fires when the context is big enough to matter.

**Deviations / scope decisions (flag at approval):**
- Idle guard and context watchdog share **one `UserPromptSubmit` hook** so a prompt can never print two lines (idle wins). Four guards, three scripts.
- Image guard **denies** large image reads (as the spec says). `disable: ["image"]` or a larger `imageMaxKB` turns it off.
- Not in this plan: the ~8 spec rules still unbuilt (`skill-desc-verbose`, `compact-cold`, `loop-idle`, `thinking-heavy`, `vague-prompt-scan`, `verbose-output`, `ttl-regression`, `server-side-drain`), `disableMcp`/`disableHook` fix ops, a marketplace manifest. License stays MIT and the name stays `claude-lean` (your decision to change later; nothing here depends on it).
- A real "does Claude Code load this plugin" check needs a live session; Task 5 runs what can be automated and gives you a 2-minute manual smoke test.

**Invariants:**
- A guard prints **at most one line and nothing when all is well**, and never throws or blocks (all code paths end in exit 0). Tests enforce both.
- Privacy (public repo): no real paths, names or emails in code, tests or docs; tests use `os.tmpdir()`. `lean share` output must contain no path, command, text, plugin name or env var name; a sentinel test enforces it.
- Transcript requests are still de-duplicated by `message.id` in `lean share` (it reuses `summarize.js`). The guards read only the **last** assistant usage line, so multi-line responses do not matter there, but sidechain (subagent) and `<synthetic>` lines are skipped.

---

## File structure

```
plugin/
  .claude-plugin/plugin.json
  hooks/hooks.json
  hooks/prompt-guard.mjs        # UserPromptSubmit: idle guard + context watchdog
  hooks/image-guard.mjs         # PreToolUse(Read): large image deny
  hooks/screenshot-guard.mjs    # PostToolUse: screenshot/scroll loop warning
  lib/guards.mjs                # thresholds, decisions, tail reader, state
  thresholds.json               # defaults
src/share.js                    # NEW  buildShare(sessions, config, findings)
bin/lean.js                     # MOD  `lean share [--out file]`
test/guards.test.js             # NEW
test/hooks.test.js              # NEW
test/plugin.test.js             # NEW
test/share.test.js              # NEW
README.md, package.json         # MOD
```

---

### Task 1: Branch, thresholds and pure decisions

**Files:**
- Create: `plugin/thresholds.json`, `plugin/lib/guards.mjs`, `test/guards.test.js`

- [ ] **Step 1: Create the branch**

Run: `git checkout -b plan-3-guards-share`
Expected: `Switched to a new branch 'plan-3-guards-share'`.

- [ ] **Step 2: Write the failing tests `test/guards.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageDecision, loadThresholds, promptDecision, shotDecision } from '../plugin/lib/guards.mjs';

const th = { ctxWarn: [150000, 300000], idleMinutes: 5, idleMinCtx: 100000, imageMaxKB: 500, screenshotWarnEvery: 30, disable: [] };
const MIN = 60_000;

test('loadThresholds returns defaults, merges a valid override and ignores wrong types', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-th-'));
  assert.deepEqual(loadThresholds(dir), th);
  writeFileSync(join(dir, 'claude-lean.json'), JSON.stringify({ idleMinutes: 60, imageMaxKB: 'big', unknown: 1, disable: ['image'] }));
  const t = loadThresholds(dir);
  assert.equal(t.idleMinutes, 60);
  assert.equal(t.imageMaxKB, 500, 'wrong type ignored');
  assert.deepEqual(t.disable, ['image']);
  assert.equal(t.unknown, undefined);
  writeFileSync(join(dir, 'claude-lean.json'), '{ nope');
  assert.deepEqual(loadThresholds(dir), th, 'broken override falls back to defaults');
});

test('context watchdog warns once per level and resets when context shrinks', () => {
  let d = promptDecision({ ctx: 100e3, gapMs: 1000, level: 0, th });
  assert.equal(d.message, null);
  assert.equal(d.level, 0);
  d = promptDecision({ ctx: 160e3, gapMs: 1000, level: 0, th });
  assert.match(d.message, /context is 160k tokens.*\/compact/);
  assert.equal(d.level, 1);
  d = promptDecision({ ctx: 170e3, gapMs: 1000, level: 1, th });
  assert.equal(d.message, null, 'same level is not repeated');
  d = promptDecision({ ctx: 320e3, gapMs: 1000, level: 1, th });
  assert.match(d.message, /context is 320k tokens.*\/clear/);
  assert.equal(d.level, 2);
  d = promptDecision({ ctx: 20e3, gapMs: 1000, level: 2, th });
  assert.equal(d.message, null);
  assert.equal(d.level, 0, 'level resets after /clear or /compact');
});

test('idle guard needs a long gap AND a big context, and wins over the context warning', () => {
  assert.match(promptDecision({ ctx: 200e3, gapMs: 12 * MIN, level: 1, th }).message, /idle for 12 min.*200k/);
  assert.equal(promptDecision({ ctx: 50e3, gapMs: 12 * MIN, level: 0, th }).message, null);
  assert.equal(promptDecision({ ctx: 200e3, gapMs: 2 * MIN, level: 1, th }).message, null);
  assert.equal(promptDecision({ ctx: 200e3, gapMs: null, level: 1, th }).message, null);
  const both = promptDecision({ ctx: 320e3, gapMs: 12 * MIN, level: 0, th });
  assert.match(both.message, /idle/);
  assert.equal(both.level, 2, 'level still advances so the next prompt does not repeat it');
});

test('disabled guards stay silent and every message is a single line', () => {
  assert.equal(promptDecision({ ctx: 320e3, gapMs: 12 * MIN, level: 0, th: { ...th, disable: ['idle', 'context'] } }).message, null);
  for (const [ctx, gapMs, level] of [[160e3, 1, 0], [320e3, 1, 1], [200e3, 12 * MIN, 1]]) {
    assert.doesNotMatch(promptDecision({ ctx, gapMs, level, th }).message, /\n/);
  }
});

test('imageDecision blocks big images only', () => {
  const big = () => 2_400_000;
  const small = () => 100_000;
  assert.match(imageDecision({ path: '/x/a.PNG', th, sizeOf: big }), /image is 2344 KB \(limit 500 KB\)/);
  assert.equal(imageDecision({ path: '/x/a.png', th, sizeOf: small }), null);
  assert.equal(imageDecision({ path: '/x/notes.txt', th, sizeOf: big }), null);
  assert.equal(imageDecision({ path: '/x/a.png', th: { ...th, disable: ['image'] }, sizeOf: big }), null);
  assert.equal(imageDecision({ path: '/x/missing.png', th, sizeOf: () => { throw new Error('ENOENT'); } }), null);
  assert.equal(imageDecision({ path: undefined, th }), null);
});

test('shotDecision counts screenshot tools and warns every N calls', () => {
  let count = 0;
  const msgs = [];
  for (let i = 0; i < 60; i++) {
    const d = shotDecision({ tool: 'mcp__claude-in-chrome__computer', count, th });
    count = d.count;
    if (d.message) msgs.push(d.message);
  }
  assert.equal(count, 60);
  assert.equal(msgs.length, 2);
  assert.match(msgs[0], /30 screenshot/);
  assert.deepEqual(shotDecision({ tool: 'Bash', count: 5, th }), { count: 5, message: null });
  assert.equal(shotDecision({ tool: 'mcp__plugin_playwright_playwright__browser_take_screenshot', count: 0, th }).count, 1);
  assert.deepEqual(shotDecision({ tool: 'mcp__x__computer', count: 29, th: { ...th, disable: ['screenshot'] } }), { count: 29, message: null });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../plugin/lib/guards.mjs'`.

- [ ] **Step 4: Write `plugin/thresholds.json`**

```json
{
  "ctxWarn": [150000, 300000],
  "idleMinutes": 5,
  "idleMinCtx": 100000,
  "imageMaxKB": 500,
  "screenshotWarnEvery": 30,
  "disable": []
}
```

- [ ] **Step 5: Write `plugin/lib/guards.mjs`**

```js
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const DEFAULTS = new URL('../thresholds.json', import.meta.url);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
// Same pattern the doctor uses: every computer-use call returns a screenshot.
const SHOT = /(__computer$|screenshot)/i;
const k = (n) => `${Math.round(n / 1000)}k`;

// Defaults from thresholds.json, overridden by <claude config dir>/claude-lean.json.
// Only known keys with the same type are accepted; anything else (or a broken file) is ignored.
export function loadThresholds(configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  const th = JSON.parse(readFileSync(DEFAULTS, 'utf8'));
  try {
    const o = JSON.parse(readFileSync(join(configDir, 'claude-lean.json'), 'utf8'));
    for (const key of Object.keys(th)) {
      if (key in o && typeof o[key] === typeof th[key] && Array.isArray(o[key]) === Array.isArray(th[key])) th[key] = o[key];
    }
  } catch { /* no override file, or not valid JSON: keep defaults */ }
  return th;
}

// ctx = tokens in the last request, gapMs = time since the last response (null if unknown),
// level = highest context warning already shown in this session. Returns { message, level }.
export function promptDecision({ ctx, gapMs, level, th }) {
  const lvl = th.ctxWarn.filter((t) => ctx >= t).length;
  let message = null;
  if (!th.disable.includes('idle') && gapMs !== null && gapMs >= th.idleMinutes * 60_000 && ctx >= th.idleMinCtx) {
    message = `claude-lean: idle for ${Math.round(gapMs / 60_000)} min; the next prompt may rebuild a ${k(ctx)}-token cache. Consider /clear.`;
  } else if (!th.disable.includes('context') && lvl > level) {
    message = lvl === th.ctxWarn.length
      ? `claude-lean: context is ${k(ctx)} tokens. /clear if the task is done, or /compact now.`
      : `claude-lean: context is ${k(ctx)} tokens. Consider /compact while the cache is warm.`;
  }
  return { message, level: lvl };
}

// Returns the reason to deny the Read, or null. sizeOf is injectable for tests.
export function imageDecision({ path, cwd, th, sizeOf = (p) => statSync(p).size }) {
  if (th.disable.includes('image') || !IMAGE.test(path || '')) return null;
  let size;
  try { size = sizeOf(isAbsolute(path) ? path : resolve(cwd || '.', path)); } catch { return null; }
  if (size <= th.imageMaxKB * 1024) return null;
  return `claude-lean: image is ${Math.round(size / 1024)} KB (limit ${th.imageMaxKB} KB). Downscale or crop it first, or raise imageMaxKB in claude-lean.json.`;
}

export function shotDecision({ tool, count, th }) {
  if (th.disable.includes('screenshot') || !SHOT.test(tool || '')) return { count, message: null };
  const n = count + 1;
  const message = n % th.screenshotWarnEvery === 0
    ? `claude-lean: ${n} screenshot/scroll calls in this session. Use find/read_page instead, or move browser work to a short separate session.`
    : null;
  return { count: n, message };
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS (6 new tests).

- [ ] **Step 7: Commit**

```bash
git add plugin/thresholds.json plugin/lib/guards.mjs test/guards.test.js
git commit -m "feat: guard thresholds and pure decision functions" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Transcript tail reader and session state

The watchdog must be cheap: real transcripts reach hundreds of MB, so it reads only the end of the file.

**Files:**
- Modify: `plugin/lib/guards.mjs`, `test/guards.test.js`

- [ ] **Step 1: Add failing tests to `test/guards.test.js`**

Replace the two import lines at the top with:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { imageDecision, lastUsage, loadState, loadThresholds, promptDecision, saveState, shotDecision } from '../plugin/lib/guards.mjs';
```

Append:

```js
const usageLine = ({ id, cr, cc = 0, at, side = false, model = 'claude-sonnet-5-5' }) => JSON.stringify({
  type: 'assistant', timestamp: new Date(at).toISOString(), isSidechain: side,
  message: { id, model, usage: { input_tokens: 1, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: 1 } },
});
const transcript = (lines) => {
  const f = join(mkdtempSync(join(tmpdir(), 'lean-tail-')), 't.jsonl');
  writeFileSync(f, `${lines.join('\n')}\n`);
  return f;
};

test('lastUsage reads ctx and time from the last real assistant line, skipping sidechain and synthetic', () => {
  const f = transcript([
    usageLine({ id: 'a', cr: 100e3, at: 1000 }),
    usageLine({ id: 'b', cr: 200e3, cc: 5e3, at: 2000 }),
    usageLine({ id: 'c', cr: 999e3, at: 3000, side: true }),
    usageLine({ id: 'd', cr: 0, at: 4000, model: '<synthetic>' }),
    JSON.stringify({ type: 'user', message: { content: 'hi' } }),
  ]);
  assert.deepEqual(lastUsage(f), { ctx: 205001, ts: 2000 });
});

test('lastUsage works on a transcript far bigger than the tail window (cut first line is dropped)', () => {
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } });
  const f = transcript([usageLine({ id: 'old', cr: 50e3, at: 1 }), ...Array.from({ length: 400 }, () => filler), usageLine({ id: 'new', cr: 300e3, at: 5000 })]);
  assert.equal(lastUsage(f).ctx, 300001);
});

test('lastUsage widens the window when the last usage line is far from the end', () => {
  const huge = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(300 * 1024) } });
  assert.equal(lastUsage(transcript([usageLine({ id: 'a', cr: 120e3, at: 7 }), huge])).ctx, 120001);
});

test('lastUsage returns null when there is no usage, or the file is empty or missing', () => {
  assert.equal(lastUsage(transcript([JSON.stringify({ type: 'user', message: { content: 'hi' } })])), null);
  assert.equal(lastUsage(transcript([])), null);
  assert.equal(lastUsage(join(tmpdir(), 'lean-does-not-exist.jsonl')), null);
});

test('state round-trips per session, sanitizes the session id and survives a missing dir', () => {
  process.env.CLAUDE_PLUGIN_DATA = join(mkdtempSync(join(tmpdir(), 'lean-state-')), 'nested');
  assert.deepEqual(loadState('s1'), {});
  saveState('s1', { level: 2 });
  assert.deepEqual(loadState('s1'), { level: 2 });
  saveState('../evil', { level: 1 });
  assert.ok(existsSync(join(process.env.CLAUDE_PLUGIN_DATA, '___evil.json')), 'no path traversal');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `lastUsage` / `loadState` are not exported.

- [ ] **Step 3: Update `plugin/lib/guards.mjs`**

Replace its first three import lines with:

```js
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
```

Append to the end of the file:

```js
// Reads the last `bytes` of a file as lines. The first line is dropped when the cut lands mid-line.
function readTail(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } finally {
    closeSync(fd);
  }
}

// Context size and time of the last real assistant response, or null. Skips subagent (sidechain)
// and <synthetic> lines. One response spans several lines with identical usage, so the last line is enough.
export function lastUsage(path) {
  try {
    for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
      const { lines, whole } = readTail(path, bytes);
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        const u = o?.message?.usage;
        if (o?.type === 'assistant' && u && !o.isSidechain && o.message.model !== '<synthetic>') {
          return {
            ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            ts: o.timestamp ? Date.parse(o.timestamp) : null,
          };
        }
      }
      if (whole) break;
    }
  } catch { /* missing or unreadable transcript: no data, stay silent */ }
  return null;
}

// Per-session state (highest context level warned, screenshot count). Best effort: failures are ignored.
// ponytail: read-modify-write is not atomic, parallel tool calls can lose a count; fine for a warning.
const stateFile = (id) => join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'claude-lean'), `${String(id).replace(/[^\w-]/g, '_')}.json`);

export function loadState(sessionId) {
  try { return JSON.parse(readFileSync(stateFile(sessionId), 'utf8')); } catch { return {}; }
}

export function saveState(sessionId, state) {
  try {
    const file = stateFile(sessionId);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  } catch { /* ignore */ }
}

export const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add plugin/lib/guards.mjs test/guards.test.js
git commit -m "feat: cheap transcript tail reader and per-session guard state" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Hook scripts, manifest, hooks.json

**Files:**
- Create: `test/hooks.test.js`, `test/plugin.test.js`, `plugin/hooks/prompt-guard.mjs`, `plugin/hooks/image-guard.mjs`, `plugin/hooks/screenshot-guard.mjs`, `plugin/hooks/hooks.json`, `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Write the failing tests `test/hooks.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS = fileURLToPath(new URL('../plugin/hooks/', import.meta.url));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISABLE_|CLAUDE_)/.test(k)));

function sandbox(override = null) {
  const root = mkdtempSync(join(tmpdir(), 'lean-hook-'));
  const cfg = join(root, 'cfg');
  mkdirSync(cfg);
  if (override) writeFileSync(join(cfg, 'claude-lean.json'), JSON.stringify(override));
  return { root, env: { ...baseEnv, CLAUDE_PLUGIN_DATA: join(root, 'data'), CLAUDE_CONFIG_DIR: cfg } };
}
function run(script, input, env) {
  const r = spawnSync(process.execPath, [join(HOOKS, script)], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env });
  assert.equal(r.status, 0, `${script} must always exit 0 (stderr: ${r.stderr})`);
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.ok(lines.length <= 1, `${script} printed ${lines.length} lines`);
  return lines.length ? JSON.parse(lines[0]) : null;
}
function transcriptWith({ root, ctx, ageMs }) {
  const file = join(root, 't.jsonl');
  writeFileSync(file, `${JSON.stringify({
    type: 'assistant', timestamp: new Date(Date.now() - ageMs).toISOString(),
    message: { id: 'a', model: 'claude-sonnet-5-5', usage: { input_tokens: 1, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0, output_tokens: 1 } },
  })}\n`);
  return file;
}

test('prompt-guard is silent on the happy path', () => {
  const { root, env } = sandbox();
  assert.equal(run('prompt-guard.mjs', { session_id: 's', transcript_path: transcriptWith({ root, ctx: 50e3, ageMs: 60_000 }) }, env), null);
});

test('prompt-guard warns once per context level, through systemMessage only', () => {
  const { root, env } = sandbox();
  const input = { session_id: 's', transcript_path: transcriptWith({ root, ctx: 160e3, ageMs: 60_000 }) };
  const out = run('prompt-guard.mjs', input, env);
  assert.deepEqual(Object.keys(out), ['systemMessage']);
  assert.match(out.systemMessage, /context is 160k tokens/);
  assert.equal(run('prompt-guard.mjs', input, env), null, 'same level is not repeated');
});

test('prompt-guard warns about an idle gap with a big context', () => {
  const { root, env } = sandbox();
  const out = run('prompt-guard.mjs', { session_id: 's', transcript_path: transcriptWith({ root, ctx: 200e3, ageMs: 10 * 60_000 }) }, env);
  assert.match(out.systemMessage, /idle for 10 min/);
});

test('prompt-guard honors claude-lean.json (idle disabled, higher context levels)', () => {
  const { root, env } = sandbox({ disable: ['idle'], ctxWarn: [500000] });
  assert.equal(run('prompt-guard.mjs', { session_id: 's', transcript_path: transcriptWith({ root, ctx: 200e3, ageMs: 10 * 60_000 }) }, env), null);
});

test('every guard stays silent and exits 0 on garbage, empty or unusable input', () => {
  const { root, env } = sandbox();
  for (const script of ['prompt-guard.mjs', 'image-guard.mjs', 'screenshot-guard.mjs']) {
    assert.equal(run(script, '', env), null);
    assert.equal(run(script, 'not json', env), null);
    assert.equal(run(script, {}, env), null);
  }
  assert.equal(run('prompt-guard.mjs', { session_id: 's', transcript_path: join(root, 'missing.jsonl') }, env), null);
});

test('image-guard denies a big image Read with a hookSpecificOutput deny and allows the rest', () => {
  const { root, env } = sandbox();
  writeFileSync(join(root, 'big.png'), Buffer.alloc(600 * 1024));
  writeFileSync(join(root, 'small.png'), Buffer.alloc(10 * 1024));
  const deny = run('image-guard.mjs', { tool_name: 'Read', cwd: root, tool_input: { file_path: 'big.png' } }, env);
  assert.equal(deny.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(deny.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /image is 600 KB/);
  assert.equal(run('image-guard.mjs', { tool_name: 'Read', cwd: root, tool_input: { file_path: 'small.png' } }, env), null);
  assert.equal(run('image-guard.mjs', { tool_name: 'Bash', cwd: root, tool_input: { file_path: 'big.png' } }, env), null);
});

test('screenshot-guard warns every Nth screenshot call in a session, per session', () => {
  const { env } = sandbox({ screenshotWarnEvery: 3 });
  const call = (session, tool = 'mcp__claude-in-chrome__computer') => run('screenshot-guard.mjs', { session_id: session, tool_name: tool }, env);
  assert.equal(call('s1'), null);
  assert.equal(call('s1'), null);
  assert.match(call('s1').systemMessage, /3 screenshot/);
  assert.equal(call('s2'), null, 'another session has its own count');
  assert.equal(call('s1', 'Bash'), null, 'non-screenshot tools are not counted');
});
```

- [ ] **Step 2: Write the failing tests `test/plugin.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../plugin/', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

test('manifest and hooks.json are valid and every command points at a real script', () => {
  const m = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.match(m.name, /^[a-z0-9-]+$/);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  const h = JSON.parse(read('hooks/hooks.json'));
  assert.deepEqual(Object.keys(h.hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptSubmit']);
  const handlers = Object.values(h.hooks).flatMap((entries) => entries.flatMap((e) => e.hooks));
  assert.equal(handlers.length, 3);
  for (const c of handlers) {
    assert.equal(c.type, 'command');
    assert.ok(c.timeout > 0 && c.timeout <= 10, 'short timeout');
    const [, script] = c.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w-]+\.mjs)"$/) ?? [];
    assert.ok(script && existsSync(join(root, script)), `command does not point at a script: ${c.command}`);
  }
});

test('matchers follow the documented syntax and hit the intended tools only', () => {
  const h = JSON.parse(read('hooks/hooks.json')).hooks;
  assert.equal(h.PreToolUse[0].matcher, 'Read'); // exact tool name
  const re = new RegExp(h.PostToolUse[0].matcher); // contains other characters, so it is an unanchored regex
  for (const yes of ['mcp__claude-in-chrome__computer', 'mcp__plugin_playwright_playwright__browser_take_screenshot']) assert.ok(re.test(yes), yes);
  for (const no of ['Bash', 'Read', 'mcp__github__search_repositories']) assert.ok(!re.test(no), no);
});

test('plugin code is .mjs so it runs without a package.json (installed plugins are copied alone)', () => {
  for (const dir of ['hooks', 'lib']) {
    for (const f of readdirSync(join(root, dir))) {
      if (f === 'hooks.json') continue;
      assert.match(f, /\.mjs$/, `${dir}/${f}`);
    }
  }
  assert.ok(!/from '\.\.\/\.\.\/src/.test(read('hooks/prompt-guard.mjs')), 'plugin must not import repo code outside plugin/');
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL (scripts and manifest do not exist yet).

- [ ] **Step 4: Write the three hook scripts**

`plugin/hooks/prompt-guard.mjs`
```js
// UserPromptSubmit: idle guard + context watchdog. Prints at most one {"systemMessage": ...} line.
// systemMessage reaches the user only; plain stdout would be added to Claude's context and cost tokens.
import { lastUsage, loadState, loadThresholds, promptDecision, readStdin, saveState } from '../lib/guards.mjs';

try {
  const input = JSON.parse(readStdin());
  const u = input.transcript_path ? lastUsage(input.transcript_path) : null;
  if (u) {
    const state = loadState(input.session_id);
    const gapMs = u.ts === null ? null : Date.now() - u.ts;
    const d = promptDecision({ ctx: u.ctx, gapMs, level: state.level ?? 0, th: loadThresholds() });
    if (d.level !== (state.level ?? 0)) saveState(input.session_id, { ...state, level: d.level });
    if (d.message) process.stdout.write(`${JSON.stringify({ systemMessage: d.message })}\n`);
  }
} catch { /* a guard must never break a session */ }
```

`plugin/hooks/image-guard.mjs`
```js
// PreToolUse on Read: deny very large image reads (they stay in context and are re-read every request).
import { imageDecision, loadThresholds, readStdin } from '../lib/guards.mjs';

try {
  const input = JSON.parse(readStdin());
  const reason = input.tool_name === 'Read'
    ? imageDecision({ path: input.tool_input?.file_path, cwd: input.cwd, th: loadThresholds() })
    : null;
  if (reason) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
  }
} catch { /* a guard must never break a session */ }
```

`plugin/hooks/screenshot-guard.mjs`
```js
// PostToolUse on screenshot-producing tools: warn the user every Nth call in a session.
import { loadState, loadThresholds, readStdin, saveState, shotDecision } from '../lib/guards.mjs';

try {
  const input = JSON.parse(readStdin());
  const state = loadState(input.session_id);
  const d = shotDecision({ tool: input.tool_name, count: state.shots ?? 0, th: loadThresholds() });
  if (d.count !== (state.shots ?? 0)) saveState(input.session_id, { ...state, shots: d.count });
  if (d.message) process.stdout.write(`${JSON.stringify({ systemMessage: d.message })}\n`);
} catch { /* a guard must never break a session */ }
```

- [ ] **Step 5: Write `plugin/hooks/hooks.json` and `plugin/.claude-plugin/plugin.json`**

`plugin/hooks/hooks.json`
```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/prompt-guard.mjs\"", "timeout": 5 }] }
    ],
    "PreToolUse": [
      { "matcher": "Read", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/image-guard.mjs\"", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "mcp__.*__computer|.*screenshot.*", "hooks": [{ "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/screenshot-guard.mjs\"", "timeout": 5 }] }
    ]
  }
}
```

`plugin/.claude-plugin/plugin.json`
```json
{
  "name": "claude-lean-guards",
  "version": "0.2.0",
  "description": "Silent-by-default guards that warn before Claude Code burns your usage limit: context size, idle cache rebuilds, big images and screenshot loops."
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add plugin test/hooks.test.js test/plugin.test.js
git commit -m "feat: guard plugin (context/idle watchdog, image guard, screenshot-loop guard)" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: `lean share`

**Files:**
- Create: `test/share.test.js`, `src/share.js`
- Modify: `bin/lean.js`

- [ ] **Step 1: Write the failing tests `test/share.test.js`**

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildShare } from '../src/share.js';
import { evaluate, loadRules } from '../src/rules.js';
import { assistantLine, cfg, req, sess, toolUse } from './helpers.js';

const opus = (n, ctx, o = {}) => Array.from({ length: n }, () => req(ctx, { model: 'claude-opus-5-5', ...o }));

function fixture() {
  const s1 = sess([req(100e3, { model: 'claude-opus-5-5' }), ...opus(9, 600e3, { cr: 600e3 }), ...opus(15, 40e3)], {
    file: '/home/secret/project/s1.jsonl', hookChars: { SessionStart: 36000 }, imageResults: 12, screenshotCalls: 40, agentSpawns: 3, mcpFailures: 1,
    toolVolume: { SECRET_TOOL: { n: 1, chars: 5 } },
  });
  const s2 = sess(Array.from({ length: 25 }, () => req(40e3, { model: 'claude-sonnet-5-5' })));
  const config = cfg({
    facts: { pluginCount: 19, duplicatePluginCount: 1, claudeMdLines: 250, memoryIndexBytes: 30720 },
    plugins: ['SECRET_PLUGIN@secret-market'], duplicates: [['SECRET_PLUGIN@a', 'SECRET_PLUGIN@b']],
    env: { SECRET_ENV: '1' }, userSettingsPath: '/home/secret/.claude/settings.json',
  });
  const sessions = [s1, s2];
  return { sessions, config, findings: evaluate(loadRules(), sessions, config) };
}

test('buildShare reports aggregates only', () => {
  const { sessions, config, findings } = fixture();
  const s = buildShare(sessions, config, findings);
  assert.equal(s.schema, 1);
  assert.equal(s.sessions, 2);
  assert.equal(s.requests, 50);
  assert.equal(s.shareAbove300k, 0.18);
  assert.equal(s.shareAbove500k, 0.18);
  assert.equal(s.medianFirstCtxK, 100);
  assert.equal(s.hookTokensPerSessionK, 5);
  assert.deepEqual(s.maxPerSession, { imageResults: 12, screenshotCalls: 40, agentSpawns: 3, mcpFailures: 1 });
  assert.equal(s.modelShare.opus, 0.5);
  assert.deepEqual(s.config, { pluginCount: 19, duplicatePluginCount: 1, claudeMdLines: '>200', memoryIndexKB: 30 });
  assert.ok(s.findings.some((f) => f.id === 'plugin-duplicate'));
  assert.ok(s.findings.every((f) => Object.keys(f).sort().join() === 'confidence,id,weightMtok'));
});

test('buildShare output contains no path, name or text from the inputs', () => {
  const { sessions, config, findings } = fixture();
  assert.ok(findings.some((f) => /SECRET/.test(f.evidence)), 'sanity: the evidence does hold a plugin name, share must drop it');
  assert.doesNotMatch(JSON.stringify(buildShare(sessions, config, findings)), /SECRET|secret|Users|jsonl/);
});

test('buildShare copes with no sessions', () => {
  const s = buildShare([], cfg(), []);
  assert.equal(s.requests, 0);
  assert.equal(s.shareAbove300k, 0);
  assert.equal(s.medianFirstCtxK, 0);
});

const BIN = fileURLToPath(new URL('../bin/lean.js', import.meta.url));
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(DISABLE_|CLAUDE_)/.test(k)));

test('lean share prints sanitized JSON, nothing from the transcript or settings leaks, and --out writes a file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lean-share-'));
  const put = (p, c) => { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), c); return join(dir, p); };
  put('claude/settings.json', JSON.stringify({ enabledPlugins: { 'SECRET_PLUGIN@m1': true, 'SECRET_PLUGIN@m2': true }, env: { SECRET_ENV: '1' } }));
  put('claude/CLAUDE.md', 'SECRET_INSTRUCTIONS\n');
  const lines = Array.from({ length: 30 }, (_, i) => assistantLine({ id: `r${i}`, cr: 400e3, at: i * 1000, content: [toolUse(`t${i}`, 'Bash', { command: 'SECRET_CMD' })] }));
  const file = put('s.jsonl', lines.join('\n'));
  const args = ['share', '--claude-dir', join(dir, 'claude'), '--file', file];
  const run = (extra = []) => execFileSync(process.execPath, [BIN, ...args, ...extra], { encoding: 'utf8', cwd: dir, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });

  const out = run();
  const j = JSON.parse(out);
  assert.equal(j.schema, 1);
  assert.equal(j.requests, 30);
  assert.equal(j.config.duplicatePluginCount, 1);
  assert.doesNotMatch(out, /SECRET|secret/);

  const outFile = join(dir, 'share.json');
  assert.equal(run(['--out', outFile]), '');
  assert.ok(existsSync(outFile));
  assert.deepEqual(JSON.parse(readFileSync(outFile, 'utf8')), j);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test`
Expected: FAIL, `Cannot find module '../src/share.js'`.

- [ ] **Step 3: Write `src/share.js`**

```js
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
```

- [ ] **Step 4: Wire the CLI in `bin/lean.js`**

Three exact edits.

1. Imports: replace
```js
import { existsSync, readdirSync } from 'node:fs';
```
with
```js
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
```
and after `import { applyFix, planFix } from '../src/fix.js';` add
```js
import { buildShare } from '../src/share.js';
```

2. Usage check: replace
```js
if (cmd !== 'doctor' && cmd !== 'fix') {
  console.error('usage: lean doctor [--json] [--claude-dir <dir>] [--dir <projects dir>] [--file <session.jsonl>]...\n       lean fix [--apply] [--include-unverified] [--claude-dir <dir>]');
```
with
```js
if (cmd !== 'doctor' && cmd !== 'fix' && cmd !== 'share') {
  console.error('usage: lean doctor [--json] [--claude-dir <dir>] [--dir <projects dir>] [--file <session.jsonl>]...\n       lean fix [--apply] [--include-unverified] [--claude-dir <dir>]\n       lean share [--out <file>] [--claude-dir <dir>] [--dir <projects dir>] [--file <session.jsonl>]...');
```

3. Before `if (flag('--json')) {` add:
```js
if (cmd === 'share') {
  const out = JSON.stringify(buildShare(sessions, config, findings), null, 2);
  const file = values('--out')[0];
  if (file) writeFileSync(file, `${out}\n`);
  else console.log(out);
  console.error('Review this before sharing. It holds only counts and rule ids; nothing was sent anywhere.');
  process.exit(0);
}

```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add test/share.test.js src/share.js bin/lean.js
git commit -m "feat: lean share emits anonymized aggregate stats" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Verify on real data (no new files)

- [ ] **Step 1: Guard speed and behavior on the largest real transcript**

Run (replace `<big.jsonl>` with your largest real session; use a temp data dir):
```bash
D=$(mktemp -d); printf '{"session_id":"probe","transcript_path":"<big.jsonl>"}' | CLAUDE_PLUGIN_DATA="$D" bash -c 'time node plugin/hooks/prompt-guard.mjs'
```
Expected: exits 0, prints at most one JSON line with `systemMessage` (a big session should print a context warning), and finishes in well under a second. Run it a second time with the same `D`: expected no output (state remembered).

- [ ] **Step 2: `lean share` on the whole real history and a leak scan**

Run: `node bin/lean.js share > "$TMPDIR/share.json"; echo "$?"`
Expected: exit 0; the file is JSON with `schema: 1`.
Then scan it for anything personal, using values read from the environment (never typed into a file):
```bash
grep -niE "${USERNAME:-$USER}|Users|\.jsonl|superpowers|claude-scholar|@" "$TMPDIR/share.json" || echo "no leaks found"
```
Expected: `no leaks found`. If anything matches, fix `buildShare` before continuing.

- [ ] **Step 3: Plugin validation, if the CLI offers it**

Run: `claude plugin --help` and look for a `validate` subcommand. If present, run `claude plugin validate ./plugin`. Expected: no errors. If it does not exist, skip and say so in the final report.

- [ ] **Step 4: Manual smoke test for you (2 minutes, cannot be automated)**

```bash
claude --plugin-dir ./plugin
```
Create `~/.claude/claude-lean.json` with `{"idleMinutes": 0, "idleMinCtx": 1, "ctxWarn": [1000]}`, send one short prompt, then another: the second prompt should show a one-line claude-lean message in the terminal (not in Claude's reply). Delete the file afterwards. This confirms the exec/matcher/`systemMessage` path on your Claude Code version; automated tests only cover the scripts.

- [ ] **Step 5: Record**

```bash
git commit --allow-empty -m "test: Plan 3 verified on real transcripts" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: README, version, privacy scan

**Files:**
- Modify: `README.md`, `package.json`

- [ ] **Step 1: Bump `package.json` version** from `0.1.0` to `0.2.0` (matches `plugin/.claude-plugin/plugin.json`).

- [ ] **Step 2: Read `README.md`, then update it** (keep its tone):
  - Replace the bullet "It has no runtime guards. Those are planned..." with nothing (guards now exist), and add a **Guards plugin** section: what each guard does; that it is silent unless something is wrong and prints one line at most; that messages go to you only (`systemMessage`), never into Claude's context, except the image guard whose deny reason is read by Claude; install for a trial with `claude --plugin-dir ./plugin`; thresholds file `~/.claude/claude-lean.json` with every key (`ctxWarn`, `idleMinutes`, `idleMinCtx`, `imageMaxKB`, `screenshotWarnEvery`, `disable: ["context"|"idle"|"image"|"screenshot"]`); note that `idleMinutes` should be 60 on the 1-hour cache TTL; how to uninstall (just stop passing `--plugin-dir`).
  - Add **`lean share`**: `node bin/lean.js share [--out file]`; the exact list of fields it contains (counts, shares, buckets, rule ids; no paths, commands, text, plugin or env names, dates); that it only prints/writes locally and sends nothing; ask users to read it before posting.
  - Add the new commands to the Use block. Use `~/.claude` in every example, no real paths or names.

- [ ] **Step 3: Privacy scan of the whole tracked tree**

Run:
```bash
git add -A && git grep --cached -nIF -e "${USERNAME:-$USER}" -e "$(git config user.email)" -- . ; git grep --cached -nIiE "[A-Za-z]:[\\/]+Users" -- . ; echo scan-done
```
Expected: only `scan-done`. (The test fixtures use neutral `/home/secret/...` sentinel paths for exactly this reason.)

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "docs: README for guards plugin and lean share; bump to 0.2.0" -m "Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Finish the branch** with superpowers:finishing-a-development-branch (tests first, then ask merge / PR / keep / discard; pushing to the public remote is your call).

---

## Self-review (against the spec and your request)

- **Guards (spec "Guards" section):** context watchdog at ~150k/~300k, idle guard on TTL gap, image guard (PreToolUse on Read, denied with a hint), screenshot-loop guard after N calls; configurable thresholds in a small JSON file; "a hook prints at most one line, and nothing when all is well": Tasks 1-3, enforced by `run()` in `hooks.test.js` (every call asserts exit 0 and ≤1 line) and the silent-happy-path tests.
- **"A guard that costs tokens defeats the tool":** Task header documents why `systemMessage` (user-only) and not stdout; `prompt-guard` test asserts the output has exactly the key `systemMessage`.
- **`lean share` (spec "Privacy"):** Task 4, sentinel tests at unit and CLI level, `--out` and stdout paths.
- **Acceptance/real data:** Task 5 (speed, one-line behavior, leak scan on your real history, manual smoke test for what only a live Claude Code can confirm).
- **Invariants:** exit 0 always (tests), `.mjs` inside `plugin/` only (test), no personal strings (Task 6 scan), de-dup untouched (`share` reuses `summarize.js` output).
- **Placeholder scan:** none; `<big.jsonl>` in Task 5 is a runtime input, not a code placeholder. **Name consistency:** `loadThresholds/promptDecision/imageDecision/shotDecision/lastUsage/loadState/saveState/readStdin` (guards.mjs), `buildShare` (share.js) match across tests, scripts and CLI.
- **Not covered (stated above):** 8 unbuilt spec rules, `disableMcp`/`disableHook`, marketplace manifest, license/name change.
