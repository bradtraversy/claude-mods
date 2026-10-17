# Tool Cards

Tool Cards replaces Claude Code's standard tool-use row with a compact diagnostic card that makes the current state, tool, target, timing, and result easy to scan.

![Tool Cards showing a completed Bash command](../docs/images/tool-cards.png)

## Install

```bash
claude plugin install tool-cards@traversy-mods
```

Restart the session or enter `/reload-plugins` after installation.

## States

- `RUNNING`
- `DONE`
- `FAILED`
- `STOPPED`

Each tool family has its own compact marker, so Bash, file operations, searches, agents, and MCP tools are easy to distinguish without relying on color alone. Running tools show live elapsed time. Completed tools keep their final duration when Tool Cards observed the call from its start.

Claude Code normally collapses consecutive reads, searches, and listings into a summary line. Tool Cards keeps those groups expanded so completed cards remain visible in the transcript.

## Result details

Tool Cards adds a concise result line when the tool returns structured information:

- Reads show how many lines were returned.
- Edits and writes show added and removed line counts when Claude Code provides a Git diff.
- Bash commands show output line counts, background task ids, or the number of changed files.
- Completed agents show token and tool-call totals.

Bash output and edit patches have a `Details` control. Failed calls open their details automatically so the error is visible immediately. Large output is capped to keep the transcript responsive, and oversized diffs report that they cannot be displayed instead of rendering a partial hunk.

For file tools, the card displays the file path. For Bash, it displays the command. It also handles tools that expose a `path` or `pattern` field.

## Test Tool Cards

1. Install and load `tool-cards`.
2. Ask Claude to read a file.
3. Watch the card change from `RUNNING` to `DONE` and retain its elapsed time.
4. Ask Claude to edit a tracked file and confirm that its added and removed line counts appear.
5. Open `Details` and confirm that the highlighted diff appears inside the card.
6. Ask Claude to run a command that fails and confirm that its output opens automatically in the `FAILED` card.
7. Interrupt a running command and confirm that `STOPPED` uses the muted inactive color rather than the green success color.
8. Run several reads or searches and confirm that their completed cards remain visible instead of collapsing into a summary line.

The green `DONE` label is part of this mod. Disable Tool Cards from `/plugin` to return to Claude Code's normal tool rows.

## Source

[`hooks/register.tsx`](./hooks/register.tsx)

[Back to the mod index](../README.md#included-mods)
