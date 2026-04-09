#!/bin/bash
# PostToolUse hook: reminds Claude to create and merge a PR after git push

# Read tool input from stdin
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Check if this was a git push command
if echo "$COMMAND" | grep -qE "git push"; then
  # Output a reminder message back to Claude.
  # PostToolUse hooks use decision:"block" to surface `reason` to Claude
  # as a prompt; "allow" is PreToolUse-only and silently does nothing here.
  # Valigia's CLAUDE.md forbids mcp__github__* and gh CLI — reminder must
  # point Claude at the GitHub REST API via curl with $GITHUB_TOKEN.
  cat <<'ENDJSON'
{
  "decision": "block",
  "reason": "REMINDER: You just ran git push. Per CLAUDE.md you MUST now create a PR and merge it to main. GitHub MCP tools and the gh CLI are NOT available in this project — use the GitHub REST API via curl against https://api.github.com/repos/drumorgan/valigia authenticated with $GITHUB_TOKEN. Do NOT skip this step."
}
ENDJSON
fi

exit 0
