// PreToolUse on Read: deny very large image reads (they stay in context and are re-read every request).
import { imageDecision, loadThresholds, readStdin } from '../lib/guards.mjs';

try {
  const input = JSON.parse(readStdin());
  const reason = input.tool_name === 'Read'
    ? imageDecision({ path: input.tool_input?.file_path, cwd: input.cwd, th: loadThresholds() })
    : null;
  if (reason) {
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } })}\n`);
  }
} catch { /* a guard must never break a session */ }
