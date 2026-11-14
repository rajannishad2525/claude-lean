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
