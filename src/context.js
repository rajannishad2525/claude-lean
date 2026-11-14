const ANSI = /\u001b\[[0-9;]*m/g;
const SKIP = /free space|autocompact buffer|^total$/i;
const HINTS = [
  [/mcp/i, 'disable MCP servers you do not need (/mcp)'],
  [/skill/i, 'disable plugins or skills you do not use'],
  [/memory|claude\.md/i, 'shorten CLAUDE.md / MEMORY.md; move workflows into skills'],
];
const num = (n, unit) => Math.round(parseFloat(n.replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[unit.toLowerCase()] ?? 1));
const k = (n) => `${(n / 1000).toFixed(1)}k`;

// Tolerant parser: any line shaped like "<label> ... <number>[k|m] tokens" is a category; a line shaped like
// "<used>/<limit> tokens" is the total. The /context layout is not documented, so this is deliberately loose.
export function parseContext(text) {
  const items = [];
  let total = null;
  for (const raw of String(text).replace(ANSI, '').split(/\r?\n/)) {
    const line = raw.replace(/[│┃║|⛁⛶⛀⛝⛃●○·•■□▫▪]/g, ' ').replace(/\s+/g, ' ').trim();
    const t = line.match(/([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)\s*tokens/);
    if (t && total === null) {
      total = { used: num(t[1], t[2]), limit: num(t[3], t[4]) };
      continue;
    }
    const m = line.match(/^(.+?)[:\-–]?\s+([\d.,]+)\s*([kKmM]?)\s*tokens\b/);
    if (!m) continue;
    const label = m[1].replace(/[:\-–\s]+$/, '').trim();
    if (!label || SKIP.test(label)) continue;
    items.push({ label, tokens: num(m[2], m[3]) });
  }
  return { items: items.sort((a, b) => b.tokens - a.tokens), total };
}

export function formatContext({ items, total }, source) {
  if (!items.length) return `No token lines recognised in ${source}. Paste the output of /context into a text file and pass it with --context.`;
  const sum = items.reduce((t, i) => t + i.tokens, 0) || 1;
  const out = [`Fixed overhead breakdown (from the /context output in ${source}):`];
  if (total) out.push(`  ${k(total.used)} of ${k(total.limit)} tokens used`);
  for (const i of items) {
    const hint = HINTS.find(([re]) => re.test(i.label));
    out.push(`  ${k(i.tokens).padStart(7)}  ${i.label.padEnd(16)} ${String(Math.round((i.tokens / sum) * 100)).padStart(3)}%${hint ? `  -> ${hint[1]}` : ''}`);
  }
  return out.join('\n');
}
