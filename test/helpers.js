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
  screenshotCalls: 0, agentSpawns: 0, imageResults: 0, imageBytes: 0, toolVolume: {}, version: null, ...o,
});
