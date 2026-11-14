# claude-lean — design

Working name; rename freely. Date: 2026-11-14.

## Problem

Claude Code users hit usage limits fast. Measured on one real user (two largest
sessions, 1,422 requests after de-duplicating transcript lines by message id;
one API response is written as several lines): 49% and 63% of requests ran with
>500k context; cache-read was 99.8% of all tokens processed (751M read vs 1.1M
output); a fixed ~103-106k overhead sat in front of every first prompt; 75
subagent spawns in one session; 14 large cache rebuilds in one session (9 after
gaps >5 min). An earlier draft double-counted multi-line responses; that is why
`summarize.js` must de-duplicate. Existing tools each fix one slice (RTK = Bash output, caveman =
output style, context-mode = tool output, pxpipe = text-as-image) and none
catches context growth, image loops, cache-busters, or plugin bloat. Part of the
drain is server-side (issues #38335, #108534) and no client tool can fix it, but
a tool can *show* that it is not the user's doing.

## Goals

1. Explain, from the user's own transcripts, where tokens went, ranked, with
   the rule and source behind each finding.
2. Fix the safe, config-level causes automatically (with backup).
3. Stop the runtime causes while a session is running, without adding tokens.
4. Let anyone add a new cause as one small JSON file (community catalog).

## Non-goals (v1)

- Rebuilding `/usage` (it already breaks down skill/subagent/plugin/MCP spend).
  claude-lean covers what it does not: cross-session aggregation, image and
  cache-buster detection, auto-fix, guards.
- Proxy / request rewriting (pxpipe-style). Rejected: invasive, and the Claude
  5.5 family reads dense rendered pixels poorly per pxpipe's own README.
- Codex / Gemini CLI support, GUI, before/after benchmark, telemetry.

## Shape

Node, zero runtime dependencies, Claude Code only. Three parts sharing one
`rules/` catalog:

```
claude-lean/
  rules/*.json          # one file per cause
  src/summarize.js      # transcript -> summary object (streaming)
  src/doctor.js         # summary + config -> findings -> report
  src/fix.js            # settings.json edits, backup, --dry-run default
  bin/lean.js           # lean doctor | lean fix | lean share
  plugin/               # Claude Code plugin: hooks only
  test/                 # fixtures + one test per rule
```

## Rule format

```json
{
  "id": "ctx-bloat-500k",
  "title": "Context grew past 500k tokens",
  "source": "measured; docs: code.claude.com/docs/en/costs",
  "confidence": "official | measured | unverified",
  "detect": { "metric": "requestsAboveCtx", "above": 500000, "minShare": 0.2 },
  "models": ["*"],
  "saving": "share of cache-read tokens spent above threshold",
  "fix": { "type": "advice", "text": "/clear between tasks; /compact at ~150k while the cache is warm" }
}
```

`fix.type` is `advice` (printed only) or `settings` (an edit `lean fix` may
apply). Rules declare which models they apply to (e.g. thinking-effort advice
is skipped where the model cannot disable thinking).

## Summary object (what rules see)

Built by streaming `~/.claude/projects/*/*.jsonl` once. Aggregates only; no
paths, commands, or file contents leave `summarize.js`.

- per-request context size (from real `usage` fields), cache_creation, gap to
  previous request, model, client version
- cache rebuilds: size, whether preceded by idle gap (>5 min and >50 min) or by
  none (mid-session cache-buster)
- tool-result volume by tool (chars/3.6, labelled *estimate*); image-result
  count and the per-session screenshot/scroll call count
- subagent spawn count; requests with no user message during long idle gaps
- first-request context size per session (fixed overhead)
- thinking-block volume per turn; model per request
- config facts: enabled plugins, duplicate plugin names, MCP servers and
  connect failures, hook definitions and measured hook stdout size,
  CLAUDE.md and MEMORY.md size, relevant settings and env vars

Token numbers from `usage` are exact; anything derived from characters is
labelled as an estimate in the report.

## Rule catalog (v1 seed, ~30)

Sources: [M] measured on the reference user, [O] official docs
(costs, prompt-caching), [B] blog, [I] GitHub issue. [B] and [I] rules ship with
`confidence: unverified` and are shown with that tag.

| id | Cause | Detect | Fix |
|---|---|---|---|
| ctx-300k / ctx-500k | Context past 300k / 500k [M,O] | share of requests above | `/clear`, `/compact` at ~150k |
| overhead-high | First-request context >60k [M] | per-session first request | trim plugins, hooks, CLAUDE.md/MEMORY.md; read `/context` |
| plugin-duplicate | Same plugin/skills enabled twice [M] | duplicate names | disable one (settings) |
| plugin-count | Many plugins' always-on skill descriptions [O] | count + description size | disable unused (settings) |
| skill-desc-verbose | Long skill descriptions [B] | description length | `disable-model-invocation`, shorten |
| mcp-failing | MCP servers that time out at start [M] | connect failures | remove/disable (settings) |
| hook-stdout-big | UserPromptSubmit/SessionStart hook injects text each turn [B,M] | measured stdout x prompts | shorten/remove (settings) |
| claudemd-big | CLAUDE.md >200 lines [O] | line count | move workflows to skills |
| memory-index-big | Large MEMORY.md loaded each session [M] | bytes | prune/archive |
| image-read-big | Large image Read results [M] | image result count/size | crop, mobile viewport, one shot |
| screenshot-loop | Many screenshot/scroll calls in a session [M] | count threshold | separate short browser session |
| subagent-spawns | Many subagent spawns [M,O] | count per session | only for real parallel work; smaller model |
| subagent-ttl | Subagents default to 5m cache TTL [O] | setting absent | `subagentPromptCacheTtl` |
| agent-teams | Teams ~7x tokens [O] | config | small teams, close idle |
| cache-idle-rebuild | Cache rebuilt after idle gap [M,O] | rebuild after >TTL gap | `/clear` after breaks; TTL setting |
| cache-buster | Rebuild with no idle gap: `/model`, effort, fast mode, MCP/plugin toggle mid-session [O] | rebuild, gap <5 min | change at session start |
| compact-cold | `/compact` on a cold session is itself a huge request [O] | compaction request after gap | compact while warm, else `/clear` |
| loop-idle | `/loop` or scheduled tasks firing while idle [O] | requests with no user msg | stop them |
| crossession-inbound | Cross-session messages open turns while idle [O] | setting absent | `crossSessionInbound: "hold"` |
| goal-checkin | Goal check-ins, up to 3 idle turns [O] | env absent | `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0` |
| idle-compaction | Background idle compaction [O] | setting | `idleCompaction: false` |
| prompt-suggestions | Extra request per turn [O] | setting | turn off |
| autoupdate-rebuild | Upgrade rebuilds cache [O] | env absent | `DISABLE_AUTOUPDATER=1` |
| thinking-heavy | Thinking billed as output on trivial turns [O] | thinking volume vs turn size | `/effort` (skipped on models that cannot disable thinking) |
| opus-default | Opus where Sonnet suffices [O,I] | model share | `/model` |
| caching-disabled | `DISABLE_PROMPT_CACHING*` set [O] | env | remove |
| vague-prompt-scan | Broad Grep/Glob fan-out on first turn [O] | heuristic | plan mode, specific prompts |
| verbose-output | Long test/log output into context [O] | large Bash results | tail hook (last 100 lines) |
| ttl-regression | Client stopped requesting 1h TTL (2.1.218+) [I] | version + rebuild after >5 min gap | upgrade; `promptCacheTtl` |
| server-side-drain | Limit drained while local token volume fell [I] | trend of volume vs reported usage (user supplies) | none: reported as "not your usage" |

## Doctor output

Terminal report: ranked findings (rule, evidence numbers, confidence tag,
estimated share), then a "not explained by local usage" note when applicable.
`--json` for tooling. Reads `/context` output only if the user pastes it; never
guesses composition of the fixed overhead.

## Fix

Edits only plugin/MCP/hook enablement and the named settings/env keys.
Timestamped backup of `settings.json`; `--dry-run` is the default, `--apply`
writes. Everything else stays advice.

## Guards (plugin hooks)

Hard rule: a hook prints at most one line, and nothing when all is well. A
guard that costs tokens defeats the tool.

- context watchdog: one line at ~150k and ~300k suggesting `/compact` or `/clear`
- image guard (PreToolUse on Read): large png/jpg denied with a crop/downscale hint
- screenshot-loop guard: warn after N browser screenshot/scroll calls
- idle guard: one line when the gap exceeds the cache TTL ("next prompt rebuilds the cache; consider /clear")

Thresholds configurable in a small JSON file; defaults from the reference data.

## Privacy

Local only, no network, no telemetry. Transcripts can contain secrets, so
reports contain aggregates only. `lean share` emits anonymized aggregate stats
(no paths, commands, or text) so users can contribute data for new rules.

## Testing

- one synthetic-transcript fixture and one test per rule (detect fires / does
  not fire); no frameworks, `node --test`
- acceptance: run on the reference user's two real transcripts; must report
  871 and 551 requests, 49% and 63% of requests above 500k context, and
  first-request context of ~105.9k and ~102.8k tokens
- guard tests: each hook prints <=1 line and is silent on the happy path

## Known limits / open items

- Cache-TTL facts differ between sources (5m vs 1h on subscription, version
  regression claims); rules citing them carry `unverified` until checked
  against the installed client version.
- Transcript schema is Claude Code internal and may change; `summarize.js`
  must fail soft and report "unsupported format" rather than wrong numbers.
- Final project name and license undecided.
