import test from 'node:test';
import assert from 'node:assert/strict';
import { formatContext, parseContext } from '../src/context.js';

const LIST = `
claude-sonnet-5-5 · 142k/200k tokens (71%)
⛁ ⛁ ⛁ ⛁ ⛁ ⛁
⛁ System prompt: 6.2k tokens (3.1%)
⛁ System tools: 17.4k tokens (8.7%)
⛁ MCP tools: 31.5k tokens (15.8%)
⛁ Memory files: 5.1k tokens (2.6%)
⛁ Skills: 12.0k tokens (6.0%)
⛁ Messages: 8.4k tokens (4.2%)
⛶ Free space: 58k (29%)
⛝ Autocompact buffer: 33k tokens (16.5%)
`;

const TABLE = `
| Category | Tokens | Share |
| MCP tools | 31.5k tokens | 15.8% |
| Skills | 12,000 tokens | 6.0% |
`;

test('parseContext reads list-style output: ranks categories, finds the total, drops free space and buffers', () => {
  const p = parseContext(LIST);
  assert.deepEqual(p.total, { used: 142000, limit: 200000 });
  assert.deepEqual(p.items.map((i) => i.label), ['MCP tools', 'System tools', 'Skills', 'Messages', 'System prompt', 'Memory files']);
  assert.equal(p.items[0].tokens, 31500);
});

test('parseContext reads table-style rows and thousands separators', () => {
  const p = parseContext(TABLE);
  assert.deepEqual(p.items, [{ label: 'MCP tools', tokens: 31500 }, { label: 'Skills', tokens: 12000 }]);
  assert.equal(p.total, null);
});

test('parseContext ignores ANSI colors, blank and unrelated text', () => {
  assert.deepEqual(parseContext('\u001b[31mSkills: 2k tokens\u001b[0m\nhello world\n\n'), { items: [{ label: 'Skills', tokens: 2000 }], total: null });
  assert.deepEqual(parseContext(''), { items: [], total: null });
  assert.deepEqual(parseContext('nothing useful here'), { items: [], total: null });
});

test('formatContext ranks with shares and points at the fix for known categories', () => {
  const out = formatContext(parseContext(LIST), 'ctx.txt');
  assert.match(out, /Fixed overhead breakdown \(from the \/context output in ctx\.txt\)/);
  assert.match(out, /31\.5k\s+MCP tools .*disable MCP servers/);
  assert.match(out, /12\.0k\s+Skills .*disable plugins/);
  assert.match(out, /142\.0k of 200\.0k tokens used/);
});

test('formatContext says so when nothing was recognised', () => {
  assert.match(formatContext({ items: [], total: null }, 'ctx.txt'), /No token lines recognised in ctx\.txt/);
});
