const ANSI = /\u001b\[[0-9;]*m/g;
const SKIP = /free space|autocompact buffer|^total$/i;
const HINTS = [
  [/mcp/i, 'disable MCP servers you do not need (/mcp)'],
  [/skill/i, 'disable plugins or skills you do not use'],
  [/memory|claude\.md/i, 'shorten CLAUDE.md / MEMORY.md; move workflows into skills'],
];
const num = (n, unit) => Math.round(parseFloat(n.replace(/,/g, '')) * ({ k: 1e3, m: 1e6 }[unit.toLowerCase()] ?? 1));
const k = (n) => `${(n / 1000).toFixed(1)}k`;
const byTokens = (a, b) => b.tokens - a.tokens;

// "3.3k", "~480", "12,000 tokens", "10" -> tokens (first number in the cell), or null.
const cellTokens = (cell) => {
  const m = String(cell).match(/~?\s*([\d][\d.,]*)\s*([kKmM]?)/);
  return m ? num(m[1], m[2]) : null;
};
const cells = (line) => line.split('|').map((c) => c.trim()).filter((c, i, a) => !(c === '' && (i === 0 || i === a.length - 1)));

// Parses the output of `claude -p "/context"` (Markdown tables) and, loosely, older list-style layouts
// ("<label>: 6.2k tokens"). Returns { items, total, details }: `items` are the top-level categories,
// `details` the per-section tables (skills, MCP tools, memory files, ...), both sorted by size.
export function parseContext(text) {
  const items = [];
  const details = {};
  let total = null;
  let section = '';
  let tokenCol = -1; // inside a table: which column holds the tokens

  const add = (section_, label, tokens) => {
    if (!label || tokens === null || SKIP.test(label)) return;
    if (!section_ || /by category/i.test(section_)) items.push({ label, tokens });
    else (details[section_] ??= []).push({ label, tokens });
  };

  for (const raw of String(text).replace(ANSI, '').split(/\r?\n/)) {
    const heading = raw.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (heading) { section = heading[1]; tokenCol = -1; continue; }

    if (raw.trim().startsWith('|')) {
      const row = cells(raw);
      if (row.length && row.every((c) => /^:?-{2,}:?$/.test(c))) continue; // |---|---|
      if (tokenCol === -1) {
        const col = row.findIndex((c) => /token/i.test(c));
        if (col !== -1) tokenCol = col; // header row
        else if (row.length >= 2) add(section, row[0], cellTokens(row[1])); // headerless table
        continue;
      }
      add(section, row[0], cellTokens(row[tokenCol]));
      continue;
    }
    tokenCol = -1;

    const line = raw.replace(/\*\*|[│┃║⛁⛶⛀⛝⛃●○·•■□▫▪]/g, ' ').replace(/\s+/g, ' ').trim();
    const t = line.match(/([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)\s*tokens/i) || line.match(/^tokens:\s*([\d.,]+)\s*([kKmM]?)\s*\/\s*([\d.,]+)\s*([kKmM]?)/i);
    if (t && total === null) {
      total = { used: num(t[1], t[2]), limit: num(t[3], t[4]) };
      continue;
    }
    const m = line.match(/^(.+?)[:\-–]?\s+([\d.,]+)\s*([kKmM]?)\s*tokens\b/i);
    if (m) add('', m[1].replace(/[:\-–\s]+$/, '').trim(), num(m[2], m[3]));
  }
  for (const name of Object.keys(details)) details[name].sort(byTokens);
  return { items: items.sort(byTokens), total, details };
}

export function formatContext({ items, total, details = {} }, source) {
  if (!items.length) return `No token lines recognised in ${source}. Run claude -p "/context" > ctx.txt (or paste the /context output into a file) and pass it with --context.`;
  const sum = items.reduce((t, i) => t + i.tokens, 0) || 1;
  const out = [`Fixed overhead breakdown (from the /context output in ${source}):`];
  if (total) out.push(`  ${k(total.used)} of ${k(total.limit)} tokens used`);
  for (const i of items) {
    const hint = HINTS.find(([re]) => re.test(i.label));
    out.push(`  ${k(i.tokens).padStart(7)}  ${i.label.padEnd(24)} ${String(Math.round((i.tokens / sum) * 100)).padStart(3)}%${hint ? `  -> ${hint[1]}` : ''}`);
  }
  for (const [name, rows] of Object.entries(details)) {
    if (rows.length) out.push(`  Biggest entries in ${name}: ${rows.slice(0, 5).map((r) => `${r.label} ~${r.tokens}`).join(', ')}`);
  }
  return out.join('\n');
}
