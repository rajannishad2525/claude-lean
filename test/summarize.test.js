import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLines } from '../src/summarize.js';
import { assistantLine, toolUse, toolResultLine, imageBlock } from './helpers.js';

test('lines sharing a message id count as one request, last usage wins', () => {
  const lines = [
    assistantLine({ id: 'a', cr: 100, out: 1, content: [{ type: 'text', text: 'hi' }] }),
    assistantLine({ id: 'a', cr: 100, out: 50, content: [toolUse('t1', 'Bash')] }),
    assistantLine({ id: 'b', cr: 200, at: 1000 }),
  ];
  const s = summarizeLines(lines, 'f.jsonl');
  assert.equal(s.requests.length, 2);
  assert.equal(s.requests[0].out, 50);
  assert.equal(s.firstCtx, 100);
});

test('ctx is input + cache_read + cache_creation and gapMs is time since previous request', () => {
  const lines = [
    assistantLine({ id: 'a', input: 5, cr: 100, cc: 10, at: 0 }),
    assistantLine({ id: 'b', cr: 300, at: 90_000 }),
  ];
  const s = summarizeLines(lines);
  assert.equal(s.requests[0].ctx, 115);
  assert.equal(s.requests[0].gapMs, null);
  assert.equal(s.requests[1].gapMs, 90_000);
});

test('counts agent spawns, screenshot calls and image results; ignores repeated tool_use ids', () => {
  const lines = [
    assistantLine({ id: 'a', content: [toolUse('t1', 'Agent'), toolUse('t2', 'mcp__claude-in-chrome__computer'), toolUse('t3', 'Bash')] }),
    assistantLine({ id: 'a', content: [toolUse('t1', 'Agent')] }),
    toolResultLine('t2', [imageBlock(400)]),
    toolResultLine('t3', 'plain text output'),
  ];
  const s = summarizeLines(lines);
  assert.equal(s.agentSpawns, 1);
  assert.equal(s.screenshotCalls, 1);
  assert.equal(s.imageResults, 1);
  assert.equal(s.imageBytes, 300);
  assert.equal(s.toolVolume.Bash.chars, 'plain text output'.length);
  assert.equal(s.toolVolume['mcp__claude-in-chrome__computer'].n, 1);
});

test('garbage and empty lines are skipped, version is captured', () => {
  const s = summarizeLines(['', 'not json', '{"type":"summary"}', assistantLine({ id: 'a' })]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.version, '2.1.300');
});
