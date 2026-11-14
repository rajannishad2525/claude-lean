import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function readSettings(path) {
  if (!existsSync(path)) return { value: {}, error: false };
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return isObj(v) ? { value: v, error: false } : { value: {}, error: true };
  } catch {
    return { value: {}, error: true };
  }
}

const merge = (a, b) => ({ ...a, ...b, env: { ...a.env, ...b.env }, enabledPlugins: { ...a.enabledPlugins, ...b.enabledPlugins } });
const lineCount = (p) => { try { const t = readFileSync(p, 'utf8').trimEnd(); return t ? t.split('\n').length : 0; } catch { return 0; } };
const bytes = (p) => { try { return statSync(p).size; } catch { return 0; } };

const commandsIn = (hooks) => Object.values(hooks ?? {}).flatMap((list) => (Array.isArray(list) ? list : [])).flatMap((e) => e?.hooks ?? []).map((h) => h?.command).filter(Boolean);

// command string -> where it comes from. A plugin hook is recorded with a literal ${CLAUDE_PLUGIN_ROOT}, so it is
// matched against each installed plugin's own hooks/hooks.json; user/project settings hooks are matched by command.
function hookOwners(claudeDir, settings) {
  const owners = new Map();
  try {
    const { plugins = {} } = JSON.parse(readFileSync(join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const [id, entries] of Object.entries(plugins)) {
      for (const e of Array.isArray(entries) ? entries : [entries]) {
        try {
          for (const c of commandsIn(JSON.parse(readFileSync(join(e.installPath, 'hooks', 'hooks.json'), 'utf8')).hooks)) owners.set(c, id);
        } catch { /* plugin without hooks, or unreadable */ }
      }
    }
  } catch { /* no installed plugins file */ }
  for (const c of commandsIn(settings.hooks)) owners.set(c, 'settings hooks');
  return owners;
}

// Facts about the user's setup. `settings`/`env` are merged user+project layers (for detection);
// `userSettings` is the user file alone (the only thing `lean fix` ever writes).
export function loadConfig({ claudeDir = join(homedir(), '.claude'), cwd = process.cwd(), env = process.env } = {}) {
  const userSettingsPath = join(claudeDir, 'settings.json');
  const user = readSettings(userSettingsPath);
  const layers = [user.value, readSettings(join(cwd, '.claude', 'settings.json')).value, readSettings(join(cwd, '.claude', 'settings.local.json')).value];
  const settings = layers.reduce(merge, {});

  const plugins = Object.entries(settings.enabledPlugins).filter(([, on]) => on === true).map(([id]) => id).sort();
  const byName = new Map();
  for (const id of plugins) {
    const name = id.split('@')[0];
    byName.set(name, [...(byName.get(name) ?? []), id]);
  }
  const duplicates = [...byName.values()].filter((ids) => ids.length > 1);

  const projects = join(claudeDir, 'projects');
  const memorySizes = existsSync(projects) ? readdirSync(projects).map((d) => bytes(join(projects, d, 'memory', 'MEMORY.md'))) : [];

  return {
    userSettingsPath,
    userSettings: user.value,
    userSettingsError: user.error,
    settings,
    env: { ...env, ...settings.env },
    plugins,
    duplicates,
    hookOwners: hookOwners(claudeDir, settings),
    facts: {
      pluginCount: plugins.length,
      duplicatePluginCount: duplicates.length,
      claudeMdLines: Math.max(lineCount(join(claudeDir, 'CLAUDE.md')), lineCount(join(cwd, 'CLAUDE.md'))),
      memoryIndexBytes: Math.max(0, ...memorySizes),
    },
  };
}
