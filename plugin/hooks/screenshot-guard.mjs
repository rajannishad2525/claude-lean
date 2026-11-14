// PostToolUse on screenshot-producing tools: warn the user every Nth call in a session.
import { loadState, loadThresholds, readStdin, saveState, shotDecision } from '../lib/guards.mjs';

try {
  const input = JSON.parse(readStdin());
  const state = loadState(input.session_id);
  const d = shotDecision({ tool: input.tool_name, count: state.shots ?? 0, th: loadThresholds() });
  if (d.count !== (state.shots ?? 0)) saveState(input.session_id, { ...state, shots: d.count });
  if (d.message) process.stdout.write(`${JSON.stringify({ systemMessage: d.message })}\n`);
} catch { /* a guard must never break a session */ }
