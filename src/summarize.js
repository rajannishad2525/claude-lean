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
// mcp__<server>__<tool> -> <server>; a plugin server looks like mcp__plugin_<plugin>_<server>__<tool>.
const mcpServer = (toolName) => /^mcp__(.+?)__/.exec(toolName || '')?.[1] ?? null;
const mcpToolPrefix = (serverName) => serverName.replace(/[^a-zA-Z0-9_-]/g, '_');

export function createSummarizer(file = '') {
  const reqs = new Map();      // message id -> request (one API response spans many lines)
  const toolNames = new Map(); // tool_use id -> tool name
  const seen = new Set();      // uuids of non-assistant lines (a resumed session repeats lines)
  const seenAsst = new Set();  // uuids of assistant lines: block accumulation must not double count
  const failedMcp = new Set(); // distinct failed MCP servers (deltas re-list them)
  const mcpSeen = new Set();   // MCP servers that did connect in this session (their tools were added or used)
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
      for (const n of Array.isArray(a.addedNames) ? a.addedNames : []) {
        const srv = mcpServer(n);
        if (srv) mcpSeen.add(srv);
      }
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
        const srv = mcpServer(c.name);
        if (srv) mcpSeen.add(srv);
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
    // A server listed as failed that later connected in the same session is not a persistent failure.
    const failedMcpNames = [...failedMcp].filter((n) => !mcpSeen.has(mcpToolPrefix(n)));
    return { ...s, failedMcpNames, mcpConnected: [...mcpSeen], mcpFailures: failedMcpNames.length, requests, firstCtx: requests[0]?.ctx ?? 0, unsupported };
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
