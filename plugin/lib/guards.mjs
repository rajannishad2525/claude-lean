import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
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

// Reads the last `bytes` of a file as lines. The first line is dropped when the cut lands mid-line.
function readTail(path, bytes) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return { lines, whole: start === 0 };
  } finally {
    closeSync(fd);
  }
}

// Context size and time of the last real assistant response, or null. Skips subagent (sidechain)
// and <synthetic> lines. One response spans several lines with identical usage, so the last line is enough.
export function lastUsage(path) {
  try {
    for (const bytes of [256 * 1024, 4 * 1024 * 1024]) {
      const { lines, whole } = readTail(path, bytes);
      for (let i = lines.length - 1; i >= 0; i--) {
        let o;
        try { o = JSON.parse(lines[i]); } catch { continue; }
        const u = o?.message?.usage;
        if (o?.type === 'assistant' && u && !o.isSidechain && o.message.model !== '<synthetic>') {
          return {
            ctx: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
            ts: o.timestamp ? Date.parse(o.timestamp) : null,
          };
        }
      }
      if (whole) break;
    }
  } catch { /* missing or unreadable transcript: no data, stay silent */ }
  return null;
}

// Per-session state (highest context level warned, screenshot count). Best effort: failures are ignored.
// ponytail: read-modify-write is not atomic, parallel tool calls can lose a count; fine for a warning.
const stateFile = (id) => join(process.env.CLAUDE_PLUGIN_DATA || join(tmpdir(), 'claude-lean'), `${String(id).replace(/[^\w-]/g, '_')}.json`);

export function loadState(sessionId) {
  try { return JSON.parse(readFileSync(stateFile(sessionId), 'utf8')); } catch { return {}; }
}

export function saveState(sessionId, state) {
  try {
    const file = stateFile(sessionId);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(state));
  } catch { /* ignore */ }
}

export const readStdin = () => { try { return readFileSync(0, 'utf8'); } catch { return ''; } };
