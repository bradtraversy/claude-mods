# Impact Map

Impact Map opens a pane that records the most recent files Claude touched during the current session.

![Impact Map showing recently read, edited, and created files](../docs/images/impact-map.png)

## Install

```bash
claude plugin install impact-map@traversy-mods
```

Restart the session or enter `/reload-plugins` after installation.

## How it works

Impact Map labels each file as:

- `READ` when Claude uses the Read tool
- `EDITED` when Claude uses the Edit tool
- `CREATED` when Claude uses the Write tool

The pane keeps the 14 most recent unique file paths. Reading or changing the same file again moves it to the newest position.

Edited and created files are clickable. Selecting one opens a Diff pane with Claude Code's native unified-diff highlighting. Tracked files use the current working-tree diff against `HEAD`. Untracked files are shown as newly added files.

The Diff pane reflects the file's current Git state, not a private history of only Claude's edits. If you or another tool changed the same file, those changes appear too. Read-only files are not clickable because they have no change to display.

Claude Code has one docked pane area. If another pane mod is also open, the panes appear as tabs in that area rather than side by side.

## Test Impact Map

1. Install and load `impact-map`.
2. Ask Claude to read two files and edit one of them.
3. Watch the Impact Map pane update.
4. Select the edited file and confirm that its highlighted diff opens in a new pane tab.
5. If the Impact Map pane is closed, enter `/impact-map` to reopen it.

## Source

[`hooks/register.tsx`](./hooks/register.tsx)

[Back to the mod index](../README.md#included-mods)
