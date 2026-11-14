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

node bin/lean.js fix                         # dry run: shows what would change, writes nothing
node bin/lean.js fix --apply                 # backs up settings.json, then writes
node bin/lean.js fix --include-unverified    # also act on rules whose setting names are not confirmed in docs
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
| `hook-stdout-big` | Hooks inject a lot of text per session (estimate from characters) |
| `mcp-failing` | MCP servers that failed to connect |

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

Each finding carries a confidence tag: `official` (the setting and claim are in Anthropic's docs; the source line links the page), `measured` (computed from your transcripts), `unverified` (not confirmed in the docs; currently `hook-stdout-big`, `mcp-failing`, `plugin-count`, which rest on an internal transcript format or a threshold chosen here).

## What `lean fix` changes

- Only the **user-level `settings.json`** (`<claude dir>/settings.json`): `enabledPlugins` entries and the named settings/env keys in the table above. Nothing else.
- **Dry run is the default.** `--apply` first copies the file to `settings.json.lean-backup-<timestamp>`, then writes. Running it again changes nothing.
- A `settings.json` that is not valid JSON is never touched.
- If a setting lives somewhere `lean fix` does not edit (your shell, or a project settings file), it says `manual:` and leaves it alone.
- It never edits MCP servers, hooks, CLAUDE.md, memory files or project settings. Those findings stay advice.
- Rules tagged `unverified` are skipped unless you pass `--include-unverified`.

## What it does not do (yet)

- It has no runtime guards. Those are planned (see `docs/superpowers/specs/`), not built.
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
