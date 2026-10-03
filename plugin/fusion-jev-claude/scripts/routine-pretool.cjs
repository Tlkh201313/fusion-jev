// Guidance only. Host permissions and inputs are unchanged.
if (/^(off|0|false|no)$/i.test(process.env.FUSION_HOOKS || '')) process.exit(0);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; if (input.length > 1048576) process.exit(0); });
process.stdin.on('error', () => process.exit(0));
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(input);
    if (!event || (event.hook_event_name && event.hook_event_name !== 'PreToolUse')) return;
    const args = event.tool_input;
    if (!args || typeof args !== 'object') return;
    let additionalContext;
    if (['Read', 'Grep', 'Glob'].includes(event.tool_name)) {
      if (event.tool_name === 'Read' && (args.pages || /\.(png|jpe?g|gif|webp|pdf|ipynb)$/i.test(args.file_path || ''))) return;
      additionalContext = 'Use fusion_inspect first for supported text reads, lists and searches, including one small read. Pass the project absolute root. Native tools are fallback after failure or for unsupported operations.';
    } else if (event.tool_name === 'Bash' && typeof args.command === 'string' && args.command.trim()) {
      if (/^(?:npx\s+-y\s+)?fusion-jev(?:@[\w.+-]+)?\s+(?:run|evidence|setup|doctor|config|stdio|http)\b/.test(args.command.trim())) return;
      additionalContext = "Run this host-chosen command through fusion-jev run -- program argv...; use --raw for short exact output. Preserve cwd and argv. PowerShell: quote '--'. If unavailable, use the pinned npx form in the MCP instructions.";
    }
    if (additionalContext) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } }) + '\n');
  } catch { /* malformed input does not block host work */ }
});
