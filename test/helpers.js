let seq = 0;
const iso = (ms) => new Date(ms).toISOString();

export function assistantLine({ id = `m${++seq}`, cr = 0, cc = 0, input = 0, out = 1, at = 0, model = 'claude-sonnet-5-5', content = [], uuid } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: iso(at), version: '2.1.300', uuid,
    message: { id, model, usage: { input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: out }, content },
  });
}

export const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

export function toolResultLine(toolUseId, content) {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
}

export const imageBlock = (b64len) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(b64len) } });

// A request as produced by summarize.js (for metric tests).
export const req = (ctx, o = {}) => ({ ctx, cc: 0, cr: 0, out: 0, model: 'claude-sonnet-5-5', ts: null, gapMs: null, thinking: false, visible: 0, ...o });

// A session summary as produced by summarize.js (for metric tests).
export const sess = (requests, o = {}) => ({
  file: 'x.jsonl', requests, firstCtx: requests[0]?.ctx ?? 0,
  screenshotCalls: 0, agentSpawns: 0, imageResults: 0, imageBytes: 0, toolVolume: {}, version: null,
  hookChars: {}, hookByCommand: {}, mcpFailures: 0, failedMcpNames: [], unsupported: false,
  skillListingChars: 0, compactions: [], scheduledFires: 0, bigBashResults: 0, firstSearchCalls: 0, ...o,
});

export const hookLine = (event, chars, uuid = `h${++seq}`, command = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/a.mjs"') =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'hook_success', hookEvent: event, command, stdout: 'x'.repeat(chars), content: `${event} hook success` } });

export const compactLine = (uuid, at, preTokens = 200000, trigger = 'manual') =>
  JSON.stringify({ type: 'system', subtype: 'compact_boundary', uuid, timestamp: iso(at), compactMetadata: { trigger, preTokens, postTokens: 10000, durationMs: 1000 } });

export const scheduledLine = (uuid, at) =>
  JSON.stringify({ type: 'system', subtype: 'scheduled_task_fire', uuid, timestamp: iso(at), taskKind: 'loop', cronKind: 'loop' });

export const skillListingLine = (uuid, chars) =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'skill_listing', content: 'x'.repeat(chars), skillCount: 3, names: ['a', 'b', 'c'] } });

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
