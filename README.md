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
```

## What it detects (v0.1)

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

Each finding carries a confidence tag: `official` (documented by Anthropic), `measured` (computed from your transcripts), `unverified` (blog/issue claims, not used by the current rules).

## What it does not do (yet)

- It does not edit your settings and has no runtime guards. Those are planned (see `docs/superpowers/specs/`), not built.
- It cannot see the composition of the fixed overhead; run `/context` for that.
- Some limit drain is server-side and cannot be fixed on the client.
- The transcript format is internal to Claude Code and may change. Counts are checked by tests on synthetic transcripts, and the request count is the number of distinct `message.id` values (one response spans several lines).

## Privacy

Everything runs locally. No network access, no telemetry. The report prints aggregates only (counts, percentages), never file paths, commands, or message text.

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

Run `npm test`. Pull requests that add a documented cause are welcome.

## License

MIT
