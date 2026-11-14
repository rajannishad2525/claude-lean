# claude-lean

Find out what is making Claude Code burn your usage limit, using your own session transcripts.

`lean doctor` reads `~/.claude/projects/*/*.jsonl` locally, de-duplicates requests, and tells you which known causes show up in *your* history, ranked, with the evidence, a fix, and a source for each.

```
$ node bin/lean.js doctor

claude-lean doctor: 12 sessions, 3120 requests

1. [official] Context grew past 300k tokens
   found:  80% of 871 requests ran above 300k context (409M cache-read tokens there)
   fix:    Run /clear between unrelated tasks and /compact at about 150k ...
   source: measured on transcripts; https://code.claude.com/docs/en/costs
...
```

(Example output; numbers come from your own transcripts.)

## Why

Every tool call is another API request, and every request re-reads the whole conversation. On the histories this was built from, about half of all requests ran above 500k tokens of context, and over 99% of tokens processed were cache reads, not new work. Existing tools each cover one slice (shell output, output style, tool output). This one looks across your whole history and names the cause.

## Use

Needs Node 18+. No dependencies.

```bash
git clone <this repo> && cd claude-lean
node bin/lean.js doctor                      # all sessions under ~/.claude/projects
node bin/lean.js doctor --json               # machine readable
node bin/lean.js doctor --file session.jsonl # specific session(s)
node bin/lean.js doctor --dir /path/to/projects
node bin/lean.js doctor --claude-dir /path/to/.claude   # use another Claude config dir
node bin/lean.js doctor --context ctx.txt    # also break down the fixed overhead from a pasted /context output

node bin/lean.js fix                         # dry run: shows what would change, writes nothing
node bin/lean.js fix --apply                 # backs up settings.json, then writes
node bin/lean.js fix --include-unverified    # also act on rules whose setting names are not confirmed in docs

node bin/lean.js share                       # anonymized aggregate stats (prints JSON, sends nothing)
node bin/lean.js share --out stats.json

claude --plugin-dir ./plugin                 # try the guards plugin (see "Guards plugin" below)
```

## What it detects

Transcript rules (computed from your history):

| Rule | Cause |
|---|---|
| `ctx-300k`, `ctx-500k` | Context grew very large; history is re-read on every request |
| `overhead-high` | Large fixed overhead before your first prompt |
| `cache-idle-rebuild` | Cache rebuilt after an idle gap |
| `cache-buster` | Cache rebuilt mid-session (model/effort/MCP/plugin changes, compaction) |
| `image-read-big` | Many image results kept in context |
| `screenshot-loop` | Screenshot/scroll loops in browser sessions |
| `subagent-spawns` | Many subagent spawns in one session |
| `opus-default` | Most requests used an Opus model |
| `hook-stdout-big` | Hooks inject a lot of text per session (estimate from characters); the finding names the biggest sources (plugin or settings hook) |
| `mcp-failing` | MCP servers that failed to connect in several sessions and never connected in any (intermittent startup timeouts are not flagged) |
| `skill-desc-verbose` | The skill list sent every session is very large (it is capped at ~30,000 characters, so a full list means skills are being cut) |
| `compact-cold` | Large compactions after a long break, without a warm cache |
| `loop-idle` | `/loop` or scheduled tasks firing while the session is idle |
| `thinking-heavy` | A large share of output looks like hidden thinking (estimate; only models where thinking can be tuned: Opus/Sonnet 4.6 and older) |
| `vague-prompt-scan` | Many Grep/Glob calls among a session's first 20 tool calls |
| `verbose-output` | Very long Bash output (20,000+ characters) entering the context |
| `cache-ttl-5m` | Cache rebuilt after a 5 to 60 minute pause, so the five-minute lifetime was in effect (`promptCacheTtl: "1h"` helps, but one-hour writes cost more). Replaces the spec's `ttl-regression`, whose version claim is unverified. |

`server-side-drain` (limit drained while your local usage fell) is intentionally not built: it needs your reported plan usage and a documented limit formula, and a "this is not your usage" verdict without them would be a guess.

Config rules (computed from your settings, env and memory files):

| Rule | Cause | `lean fix` |
|---|---|---|
| `plugin-duplicate` | Same plugin enabled from more than one marketplace | disables the extra copies |
| `plugin-count` | Many plugins enabled | advice |
| `claudemd-big` | CLAUDE.md over 200 lines | advice |
| `memory-index-big` | MEMORY.md at its 200-line / 25KB load limit | advice |
| `autoupdate-rebuild` | Auto-update can rebuild the cache mid-work | sets `DISABLE_AUTOUPDATER=1` |
| `caching-disabled` | `DISABLE_PROMPT_CACHING*` set | removes it from `settings.json` env |
| `crossession-inbound` | Cross-session messages can open turns while idle | sets `crossSessionInbound: "hold"` |
| `goal-checkin` | Goal check-ins can run while idle | sets `CLAUDE_CODE_GOAL_CHECKIN_MINUTES=0` |
| `idle-compaction` | Background idle compaction | sets `idleCompaction: false` |
| `prompt-suggestions` | Extra request after each response | sets `promptSuggestionEnabled: false` |
| `subagent-ttl` | Separate cache TTL for subagent requests | advice (a longer TTL is billed higher) |
| `agent-teams` | Agent teams use about 7x the tokens in plan mode | advice |

Each finding carries a confidence tag: `official` (the setting and claim are in Anthropic's docs; the source line links the page), `measured` (computed from your transcripts), `unverified` (not confirmed in the docs; currently `hook-stdout-big`, `mcp-failing`, `skill-desc-verbose`, `vague-prompt-scan`, `thinking-heavy`, `plugin-count`, which rest on an internal transcript format, an estimate, or a threshold chosen here).

`lean doctor --context ctx.txt` reads the text of a `/context` run that you paste into a file and ranks what fills the window (MCP tools, skills, memory files, ...). Anthropic does not document that output's layout, so the parser is deliberately loose; if it misses your lines it says so instead of guessing.

## What `lean fix` changes

- Only the **user-level `settings.json`** (`<claude dir>/settings.json`): `enabledPlugins` entries and the named settings/env keys in the table above. Nothing else.
- **Dry run is the default.** `--apply` first copies the file to `settings.json.lean-backup-<timestamp>`, then writes. Running it again changes nothing.
- A `settings.json` that is not valid JSON is never touched.
- If a setting lives somewhere `lean fix` does not edit (your shell, or a project settings file), it says `manual:` and leaves it alone.
- The one MCP edit: `mcp-failing` can add a server to `deniedMcpServers` (`{"serverName": ...}`), only for a server that failed in 3+ sessions and never connected in any, and only with `--include-unverified` (its detection reads an internal transcript format). Delete the entry to bring the server back.
- It never edits hooks, CLAUDE.md, memory files or project settings. Those findings stay advice (`hook-stdout-big` tells you which plugin or settings hook is the biggest source instead).
- Rules tagged `unverified` are skipped unless you pass `--include-unverified`.

## Guards plugin

`plugin/` is a Claude Code plugin (`lean-guards`) with four guards. They are silent unless something is wrong, and each prints **one line at most**.

| Guard | When | What it does |
|---|---|---|
| Context watchdog | each prompt | one line at ~150k and again at ~300k tokens of context, suggesting `/compact` or `/clear` (once per level; resets after `/clear` or `/compact`) |
| Idle guard | each prompt | one line when you come back after longer than the cache lifetime to a large context ("the next prompt may rebuild a 200k-token cache") |
| Image guard | before `Read` | denies reading a very large image (over 500 KB by default) with a hint to crop or downscale |
| Screenshot-loop guard | after screenshot tools | one line every 30 screenshot/scroll calls in a session |

Warnings go to you through the hook's `systemMessage` field, so they do **not** enter Claude's context and cost no tokens. (Plain hook stdout on `UserPromptSubmit` would be added to the context.) The one exception is the image guard's deny reason, which Claude reads so it can adapt. Guards never block your prompts and never fail a session: on any error they print nothing and exit 0.

Try it without installing: `claude --plugin-dir ./plugin`. To stop, stop passing the flag.

Install it from this repository's marketplace (replace `<github-owner>` with the account that hosts the repo):

```bash
claude plugin marketplace add <github-owner>/claude-lean
claude plugin install lean-guards@lean-tools
```

Optional settings go in `~/.claude/claude-lean.json` (all keys optional; wrong types are ignored):

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

`disable` takes any of `"context"`, `"idle"`, `"image"`, `"screenshot"`. The prompt-cache lifetime is 5 minutes or 1 hour depending on your plan and sign-in method; if you have the 1-hour cache, set `idleMinutes` to 60.

## `lean share`

`lean share` prints (or writes with `--out`) a small JSON file so people can compare notes or contribute data for new rules. It contains only: counts (sessions, requests, per-session maxima), shares and percentages, size buckets, how many plugins you have enabled, and the ids and confidence tags of the rules that fired. It contains **no** file paths, commands, message text, plugin names, environment variable names or dates, and the rule evidence strings are left out on purpose. Read it before you post it; claude-lean never sends it anywhere.

## What it does not do (yet)

- It cannot see the composition of the fixed overhead; run `/context` for that.
- Some limit drain is server-side and cannot be fixed on the client.
- The transcript format is internal to Claude Code and may change. One API response is written as several lines; the request count is the number of distinct `message.id` values. If a transcript has assistant lines with no usage data, `lean doctor` prints an "unsupported format" warning and leaves that file out instead of reporting wrong numbers.

## Privacy

Everything runs locally. No network access, no telemetry. Reports contain counts and percentages from your transcripts, plus names from your own settings where a finding is about them (for example a duplicated plugin). `lean fix` prints the path of the settings file it edits. Nothing is sent anywhere.

## Add a rule

A rule is one JSON file in `rules/` that names a metric from `src/metrics.js` and its parameters:

```json
{
  "id": "ctx-500k",
  "title": "Context grew past 500k tokens",
  "source": "where the claim comes from",
  "confidence": "official",
  "detect": { "metric": "shareRequestsAboveCtx", "above": 500000, "minShare": 0.1 },
  "fix": { "type": "advice", "text": "what to do about it" }
}
```

Optional fields: `"models": ["opus"]` limits the rule to requests whose model name contains one of those substrings (default `["*"]`; a rule with no matching request is skipped). A rule `lean fix` can apply uses `"fix": { "type": "settings", "text": "...", "edit": { "op": "setKey", "key": "...", "value": ... } }`, where `op` is one of `setKey`, `setEnv`, `removeEnv`, `disablePlugin`; such a rule must be detectable from config alone. New rules start as `"confidence": "unverified"` with a source that says so, and become `official` only with a docs URL in `source`.

Run `npm test`. Pull requests that add a documented cause are welcome.

## License

MIT
