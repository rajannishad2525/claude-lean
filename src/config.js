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
    facts: {
      pluginCount: plugins.length,
      duplicatePluginCount: duplicates.length,
      claudeMdLines: Math.max(lineCount(join(claudeDir, 'CLAUDE.md')), lineCount(join(cwd, 'CLAUDE.md'))),
      memoryIndexBytes: Math.max(0, ...memorySizes),
    },
  };
}
