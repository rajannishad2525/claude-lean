// UserPromptSubmit: idle guard + context watchdog. Prints at most one {"systemMessage": ...} line.
// systemMessage reaches the user only; plain stdout would be added to Claude's context and cost tokens.
import { lastUsage, loadState, loadThresholds, promptDecision, readStdin, saveState } from '../lib/guards.mjs';

try {
  const input = JSON.parse(readStdin());
  const u = input.transcript_path ? lastUsage(input.transcript_path) : null;
  if (u) {
    const state = loadState(input.session_id);
    const gapMs = u.ts === null ? null : Date.now() - u.ts;
    const d = promptDecision({ ctx: u.ctx, gapMs, level: state.level ?? 0, th: loadThresholds() });
    if (d.level !== (state.level ?? 0)) saveState(input.session_id, { ...state, level: d.level });
    if (d.message) process.stdout.write(`${JSON.stringify({ systemMessage: d.message })}\n`);
  }
} catch { /* a guard must never break a session */ }
