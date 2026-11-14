import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../plugin/', import.meta.url));
const read = (p) => readFileSync(join(root, p), 'utf8');

test('manifest and hooks.json are valid and every command points at a real script', () => {
  const m = JSON.parse(read('.claude-plugin/plugin.json'));
  assert.match(m.name, /^[a-z0-9-]+$/);
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  const h = JSON.parse(read('hooks/hooks.json'));
  assert.deepEqual(Object.keys(h.hooks).sort(), ['PostToolUse', 'PreToolUse', 'UserPromptSubmit']);
  const handlers = Object.values(h.hooks).flatMap((entries) => entries.flatMap((e) => e.hooks));
  assert.equal(handlers.length, 3);
  for (const c of handlers) {
    assert.equal(c.type, 'command');
    assert.ok(c.timeout > 0 && c.timeout <= 10, 'short timeout');
    const [, script] = c.command.match(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(hooks\/[\w-]+\.mjs)"$/) ?? [];
    assert.ok(script && existsSync(join(root, script)), `command does not point at a script: ${c.command}`);
  }
});

test('matchers follow the documented syntax and hit the intended tools only', () => {
  const h = JSON.parse(read('hooks/hooks.json')).hooks;
  assert.equal(h.PreToolUse[0].matcher, 'Read'); // exact tool name
  const re = new RegExp(h.PostToolUse[0].matcher); // contains other characters, so it is an unanchored regex
  for (const yes of ['mcp__claude-in-chrome__computer', 'mcp__plugin_playwright_playwright__browser_take_screenshot']) assert.ok(re.test(yes), yes);
  for (const no of ['Bash', 'Read', 'mcp__github__search_repositories']) assert.ok(!re.test(no), no);
});

test('plugin code is .mjs so it runs without a package.json (installed plugins are copied alone)', () => {
  for (const dir of ['hooks', 'lib']) {
    for (const f of readdirSync(join(root, dir))) {
      if (f === 'hooks.json') continue;
      assert.match(f, /\.mjs$/, `${dir}/${f}`);
    }
  }
  for (const f of readdirSync(join(root, 'hooks')).filter((x) => x.endsWith('.mjs'))) {
    assert.ok(!/from '\.\.\/\.\.\/src/.test(read(`hooks/${f}`)), `${f} must not import repo code outside plugin/`);
  }
});
