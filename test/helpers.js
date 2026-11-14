let seq = 0;
const iso = (ms) => new Date(ms).toISOString();

export function assistantLine({ id = `m${++seq}`, cr = 0, cc = 0, input = 0, out = 1, at = 0, model = 'claude-sonnet-5-5', content = [] } = {}) {
  return JSON.stringify({
    type: 'assistant', timestamp: iso(at), version: '2.1.300',
    message: { id, model, usage: { input_tokens: input, cache_read_input_tokens: cr, cache_creation_input_tokens: cc, output_tokens: out }, content },
  });
}

export const toolUse = (id, name, input = {}) => ({ type: 'tool_use', id, name, input });

export function toolResultLine(toolUseId, content) {
  return JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] } });
}

export const imageBlock = (b64len) => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(b64len) } });

// A request as produced by summarize.js (for metric tests).
export const req = (ctx, o = {}) => ({ ctx, cc: 0, cr: 0, out: 0, model: 'claude-sonnet-5-5', ts: null, gapMs: null, ...o });

// A session summary as produced by summarize.js (for metric tests).
export const sess = (requests, o = {}) => ({
  file: 'x.jsonl', requests, firstCtx: requests[0]?.ctx ?? 0,
  screenshotCalls: 0, agentSpawns: 0, imageResults: 0, imageBytes: 0, toolVolume: {}, version: null,
  hookChars: {}, mcpFailures: 0, unsupported: false, ...o,
});

export const hookLine = (event, chars, uuid = `h${++seq}`) =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'hook_success', hookEvent: event, stdout: 'x'.repeat(chars), content: `${event} hook success` } });

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
