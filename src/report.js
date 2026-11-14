export function formatReport(findings, sessions, warnings = []) {
  const requests = sessions.reduce((t, s) => t + s.requests.length, 0);
  const out = [`claude-lean doctor: ${sessions.length} sessions, ${requests} requests`, ''];
  for (const w of warnings) out.push(`warning: ${w}`);
  if (warnings.length) out.push('');
  if (!sessions.length) out.push('No supported transcripts were analysed, so transcript-based rules did not run.', '');
  else if (!findings.length) out.push('No known causes found.', '');
  findings.forEach((f, i) => {
    const fixable = f.rule.fix.type === 'settings' ? ' [lean fix can apply this]' : '';
    out.push(
      `${i + 1}. [${f.rule.confidence}] ${f.rule.title}`,
      `   found:  ${f.evidence}`,
      `   fix:    ${f.rule.fix.text}${fixable}`,
      `   source: ${f.rule.source}`,
      '',
    );
  });
  out.push('Token counts come from the usage fields in your transcripts. Local data only; nothing is sent anywhere.');
  return out.join('\n');
}
