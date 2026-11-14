import { copyFileSync, existsSync, writeFileSync } from 'node:fs';

const R = (done = [], manual = []) => ({ done, manual });

// Each op edits the settings copy in place and says what it did. Only these ops exist (see EDIT_OPS in rules.js).
const OPS = {
  setKey(s, e) {
    if (JSON.stringify(s[e.key]) === JSON.stringify(e.value)) return R();
    s[e.key] = e.value;
    return R([`set ${e.key} = ${JSON.stringify(e.value)}`]);
  },
  setEnv(s, e) {
    s.env ??= {};
    if (s.env[e.name] === String(e.value)) return R();
    s.env[e.name] = String(e.value);
    return R([`set env ${e.name} = "${e.value}"`]);
  },
  removeEnv(s, _e, targets) {
    const out = R();
    for (const t of targets) {
      if (s.env && t in s.env) {
        delete s.env[t];
        out.done.push(`remove env ${t}`);
      } else {
        out.manual.push(`${t} is set outside settings.json (shell or project settings); remove it there`);
      }
    }
    return out;
  },
  disablePlugin(s, _e, targets) {
    const out = R();
    for (const t of targets) {
      if (s.enabledPlugins?.[t] === true) {
        s.enabledPlugins[t] = false;
        out.done.push(`disable plugin ${t}`);
      } else {
        out.manual.push(`${t} is enabled outside user settings.json; disable it there`);
      }
    }
    return out;
  },
  denyMcp(s, _e, targets) {
    const out = R();
    s.deniedMcpServers ??= [];
    for (const t of targets) {
      if (s.deniedMcpServers.some((e) => e?.serverName === t)) continue;
      s.deniedMcpServers.push({ serverName: t });
      out.done.push(`deny MCP server ${t}`);
    }
    if (!s.deniedMcpServers.length) delete s.deniedMcpServers;
    return out;
  },
};

// Pure: returns { next, done, manual, skipped }. Never touches the disk.
export function planFix(settings, findings, { includeUnverified = false } = {}) {
  const plan = { next: structuredClone(settings), done: [], manual: [], skipped: [] };
  for (const f of findings) {
    const { rule } = f;
    if (rule.fix.type !== 'settings') continue;
    if (rule.confidence === 'unverified' && !includeUnverified) {
      plan.skipped.push(rule.id);
      continue;
    }
    const r = OPS[rule.fix.edit.op](plan.next, rule.fix.edit, f.targets ?? []);
    plan.done.push(...r.done);
    plan.manual.push(...r.manual);
  }
  return plan;
}

// Writes only when the plan changed something. Returns the backup path, or null (no backup needed or nothing written).
export function applyFix(path, plan, now = new Date()) {
  if (!plan.done.length) return null;
  let backup = null;
  if (existsSync(path)) {
    backup = `${path}.lean-backup-${now.toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(path, backup);
  }
  writeFileSync(path, `${JSON.stringify(plan.next, null, 2)}\n`);
  return backup;
}
