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
  # Tooling note kept in sync with CLAUDE.md: prefer the GitHub MCP tools
  # (mcp__github__create_pull_request / mcp__github__merge_pull_request),
  # fall back to the REST API via curl with $GITHUB_TOKEN only when MCP
  # tools are unavailable.
  cat <<'ENDJSON'
{
  "decision": "block",
  "reason": "REMINDER: You just ran git push. Per CLAUDE.md you MUST now create a PR and merge it to main (exception: archive/* branches are never PR'd or merged). Use the GitHub MCP tools (mcp__github__create_pull_request, then mcp__github__merge_pull_request). Only if MCP tools are unavailable, fall back to the GitHub REST API via curl against https://api.github.com/repos/drumorgan/valigia authenticated with $GITHUB_TOKEN. Do NOT skip this step."
}
ENDJSON
fi

exit 0
