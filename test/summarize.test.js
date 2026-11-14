import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeLines } from '../src/summarize.js';
import { assistantLine, toolUse, toolResultLine, imageBlock, hookLine, mcpFailLine, compactLine, scheduledLine, skillListingLine } from './helpers.js';

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

test('hook output and MCP failures are counted once per uuid, never per response line', () => {
  const lines = [
    hookLine('SessionStart', 100, 'h1'),
    hookLine('SessionStart', 100, 'h1'), // same line repeated (resumed session)
    hookLine('UserPromptSubmit', 50, 'h2'),
    mcpFailLine('m1'),
    mcpFailLine('m1'),                       // repeated line
    mcpFailLine('m2'),                       // same server re-listed in a later delta
    mcpFailLine('m3', [{ name: 'other' }]),  // a second, different server
    assistantLine({ id: 'a', cr: 10 }), // one response, two lines
    assistantLine({ id: 'a', cr: 10, out: 5 }),
  ];
  const s = summarizeLines(lines);
  assert.deepEqual(s.hookChars, { SessionStart: 100, UserPromptSubmit: 50 });
  assert.equal(s.mcpFailures, 2, 'distinct failed servers, not delta lines');
  assert.equal(s.requests.length, 1);
});

test('assistant lines with no usage data mark the transcript unsupported', () => {
  const noUsage = JSON.stringify({ type: 'assistant', timestamp: new Date(0).toISOString(), message: { id: 'a', content: [] } });
  const bad = summarizeLines([noUsage, noUsage]);
  assert.equal(bad.unsupported, true);
  assert.equal(bad.requests.length, 0);
  assert.equal(summarizeLines([assistantLine({ id: 'a' })]).unsupported, false);
  assert.equal(summarizeLines([]).unsupported, false);
});

test('compactions record size, trigger and the idle gap before them; fires and skill listing count once', () => {
  const min = 60_000;
  const s = summarizeLines([
    assistantLine({ id: 'a', cr: 100, at: 0 }),
    compactLine('c1', 20 * min, 250000, 'manual'),
    compactLine('c1', 20 * min, 250000, 'manual'), // repeated line
    scheduledLine('f1', 21 * min), scheduledLine('f1', 21 * min), scheduledLine('f2', 22 * min),
    skillListingLine('k1', 12000), skillListingLine('k2', 30000), skillListingLine('k1', 12000),
  ]);
  assert.deepEqual(s.compactions, [{ preTokens: 250000, trigger: 'manual', gapMs: 20 * min - 1000 }]);
  assert.equal(s.scheduledFires, 2);
  assert.equal(s.skillListingChars, 30000);
});

test('hook output is also kept per event and command; failed MCP servers are kept by name', () => {
  const s = summarizeLines([
    hookLine('SessionStart', 100, 'h1', 'cmdA'), hookLine('SessionStart', 50, 'h2', 'cmdA'), hookLine('UserPromptSubmit', 70, 'h3', 'cmdB'),
    mcpFailLine('m1'), mcpFailLine('m2', [{ name: 'demo', errorCode: 'x' }]), mcpFailLine('m3', [{ name: 'other' }]),
  ]);
  assert.deepEqual(s.hookByCommand, { SessionStart: { cmdA: 150 }, UserPromptSubmit: { cmdB: 70 } });
  assert.deepEqual([...s.failedMcpNames].sort(), ['demo', 'other']);
  assert.equal(s.mcpFailures, 2);
});

test('thinking and visible size accumulate per request across its lines, once per line uuid', () => {
  const think = { type: 'thinking', thinking: '', signature: 'sig' };
  const text = { type: 'text', text: 'x'.repeat(360) };
  const s = summarizeLines([
    assistantLine({ id: 'a', out: 2000, uuid: 'u1', content: [think] }),
    assistantLine({ id: 'a', out: 2000, uuid: 'u2', content: [text] }),
    assistantLine({ id: 'a', out: 2000, uuid: 'u2', content: [text] }), // repeated line
  ]);
  assert.equal(s.requests.length, 1);
  assert.equal(s.requests[0].thinking, true);
  assert.equal(s.requests[0].visible, 360);
});

test('first-turn search calls and big Bash results are counted', () => {
  const searches = Array.from({ length: 25 }, (_, i) => toolUse(`t${i}`, i % 2 ? 'Grep' : 'Glob'));
  const s = summarizeLines([
    assistantLine({ id: 'a', content: searches }),
    assistantLine({ id: 'b', content: [toolUse('b1', 'Bash'), toolUse('b2', 'Bash')] }),
    toolResultLine('b1', 'x'.repeat(25000)),
    toolResultLine('b2', 'short'),
  ]);
  assert.equal(s.firstSearchCalls, 20, 'only the first 20 tool calls of a session count');
  assert.equal(s.bigBashResults, 1);
});
