import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const DEFAULTS = new URL('../thresholds.json', import.meta.url);
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;
// Same pattern the doctor uses: every computer-use call returns a screenshot.
const SHOT = /(__computer$|screenshot)/i;
const k = (n) => `${Math.round(n / 1000)}k`;

// Defaults from thresholds.json, overridden by <claude config dir>/claude-lean.json.
// Only known keys with the same type are accepted; anything else (or a broken file) is ignored.
export function loadThresholds(configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')) {
  const th = JSON.parse(readFileSync(DEFAULTS, 'utf8'));
  try {
    const o = JSON.parse(readFileSync(join(configDir, 'claude-lean.json'), 'utf8'));
    for (const key of Object.keys(th)) {
      if (key in o && typeof o[key] === typeof th[key] && Array.isArray(o[key]) === Array.isArray(th[key])) th[key] = o[key];
    }
  } catch { /* no override file, or not valid JSON: keep defaults */ }
  return th;
}

// ctx = tokens in the last request, gapMs = time since the last response (null if unknown),
// level = highest context warning already shown in this session. Returns { message, level }.
export function promptDecision({ ctx, gapMs, level, th }) {
  const lvl = th.ctxWarn.filter((t) => ctx >= t).length;
  let message = null;
  if (!th.disable.includes('idle') && gapMs !== null && gapMs >= th.idleMinutes * 60_000 && ctx >= th.idleMinCtx) {
    message = `claude-lean: idle for ${Math.round(gapMs / 60_000)} min; the next prompt may rebuild a ${k(ctx)}-token cache. Consider /clear.`;
  } else if (!th.disable.includes('context') && lvl > level) {
    message = lvl === th.ctxWarn.length
      ? `claude-lean: context is ${k(ctx)} tokens. /clear if the task is done, or /compact now.`
      : `claude-lean: context is ${k(ctx)} tokens. Consider /compact while the cache is warm.`;
  }
  return { message, level: lvl };
}

// Returns the reason to deny the Read, or null. sizeOf is injectable for tests.
export function imageDecision({ path, cwd, th, sizeOf = (p) => statSync(p).size }) {
  if (th.disable.includes('image') || !IMAGE.test(path || '')) return null;
  let size;
  try { size = sizeOf(isAbsolute(path) ? path : resolve(cwd || '.', path)); } catch { return null; }
  if (size <= th.imageMaxKB * 1024) return null;
  return `claude-lean: image is ${Math.round(size / 1024)} KB (limit ${th.imageMaxKB} KB). Downscale or crop it first, or raise imageMaxKB in claude-lean.json.`;
}

export function shotDecision({ tool, count, th }) {
  if (th.disable.includes('screenshot') || !SHOT.test(tool || '')) return { count, message: null };
  const n = count + 1;
  const message = n % th.screenshotWarnEvery === 0
    ? `claude-lean: ${n} screenshot/scroll calls in this session. Use find/read_page instead, or move browser work to a short separate session.`
    : null;
  return { count: n, message };
}
