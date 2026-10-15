# Claude Code Mods

A collection of personal Claude Code mods by Brad Traversy. These mods add useful session information, interface customizations, safety demonstrations, and verification tools to Claude Code.

Every mod is a small, independent Claude Code plugin written in TypeScript. Install only the ones you want, or run all six together.

> [!IMPORTANT]
> Mods run inside Claude Code with your user permissions. They can see session events, start processes, access files, and make network requests. Read the source before installing any mod, including these.

## What is a mod?

A mod is a Claude Code plugin with JavaScript or TypeScript event handlers. Claude Code calls those handlers when something happens, such as:

- A session starts
- Claude calls a tool
- A command is submitted
- Part of the interface is rendered
- Context usage changes

A handler can observe the event, change it, or handle it completely. That makes mods different from normal settings hooks. A mod can draw interface elements, replace existing tool rows, register slash commands, share state between handlers, and intercept a tool call before it runs.

These mods work in:

- Claude Code in a terminal
- Local sessions in the Code tab of the Claude Desktop app
- SSH sessions in the Code tab when plugins are available on the remote host

Visual elements do not appear in the VS Code chat panel, `claude -p`, Agent SDK sessions, or cloud sessions. Plugins are not available in WSL sessions opened through the desktop app.

## Requirements

- Claude Code 2.1.287 or newer for terminal use
- A desktop app version that includes Claude Code 2.1.286 or newer for the Code tab
- Git, so Claude Code can clone this marketplace
- GitHub CLI, authenticated with `gh auth login`, only if you want Verification Ledger to display remote GitHub Actions runs

Check your terminal version:

```bash
claude --version
```

In the desktop Code tab, enter `/status` and check the Claude Code version.

## Quick start

### 1. Add the marketplace

Run this in your shell:

```bash
claude plugin marketplace add bradtraversy/claude-mods
```

You can also enter this in a Claude Code session:

```text
/plugin marketplace add bradtraversy/claude-mods
```

### 2. Install the mods you want

Install one mod:

```bash
claude plugin install session-hud@traversy-mods
```

Install all six:

```bash
claude plugin install session-hud@traversy-mods
claude plugin install impact-map@traversy-mods
claude plugin install tool-cards@traversy-mods
claude plugin install safe-shell@traversy-mods
claude plugin install quality-console@traversy-mods
claude plugin install verification-ledger@traversy-mods
```

Inside an interactive session, the same commands start with `/plugin install` instead of `claude plugin install`.

### 3. Load the mods

Start a new Claude Code session. If a session was already open when you installed or updated a mod, enter:

```text
/reload-plugins
```

Run `/plugin` and open the Installed tab to confirm that the mods are enabled.

## Use the same mods in terminal and desktop

Claude Code in the terminal and local sessions in the desktop Code tab share user-scoped plugin settings. Install a mod once at user scope and it is available in both places.

For the desktop app:

1. Open the Code tab.
2. Start a local session.
3. Enter `/reload-plugins`, or start a new session after installation.
4. Enter `/plugin` and confirm the mod is listed as active.

You can also use the desktop plugin manager. Click the plus button beside the prompt, choose Plugins, and use Manage plugins to enable or disable an installed mod.

## Included mods

| Mod | What it does | How to open or test it |
| --- | --- | --- |
| Session HUD | Shows session usage and opens a detailed context breakdown | Click `Details` beside the context meter |
| Impact Map | Tracks touched files and opens current Git diffs | Select an edited or created file in the Impact Map |
| Tool Cards | Replaces normal tool-use rows with compact status cards | Ask Claude to read a file or run a command |
| Safe Shell | Demonstrates a confirmation gate for a marked Bash command | Ask Claude to run `echo __SAFE_SHELL_DEMO__` |
| Quality Console | Validates a local mod from inside Claude Code | Enter `/mod-check <path>` |
| Verification Ledger | Tracks local checks, Git state, and GitHub Actions | Enter `/checks` |

## Session HUD

Session HUD draws a compact band above the prompt with:

- Current context usage
- A visual progress bar
- Session cost when Claude Code reports one
- The first available rate-limit window, such as the five-hour limit

Click `Details` beside the progress bar to open a Context Breakdown pane. Claude Code counts the current context and shows:

- A color-coded meter for your personal context target
- Clean progress bars for messages, system content, tool schemas, memory, skills, and agents
- Messages as one conversation total
- Loaded MCP tokens grouped by server, with tool details available from a server picker
- Free space and the automatic compaction buffer

The full breakdown runs only when you click `Details` or press Refresh. It does not poll in the background. Claude Code provides a reliable total for Messages, but it does not provide a reliable token count for every individual message.

The context percentage uses a configurable personal target. It does not change Claude's actual context window or automatic compaction behavior.

### Change the context target

Open [`session-hud/hooks/config.ts`](./session-hud/hooks/config.ts):

```ts
export const CONTEXT_MAX_TOKENS = 300_000
```

Change `300_000` to the number you want to treat as 100 percent. For example:

```ts
export const CONTEXT_MAX_TOKENS = 200_000
```

The meter is green below 70 percent, yellow from 70 through 89 percent, and red at 90 percent or higher. Its visual fill stops at 100 percent, but the numeric percentage can go higher.

### Test Session HUD

1. Install and load `session-hud`.
2. Send a prompt so Claude Code records session usage.
3. Look directly above the prompt box.
4. Confirm that context, cost, and the available rate limit appear.
5. Click `Details` beside the progress bar.
6. Confirm that the Context pane shows categories and any connected MCP tool schemas.

Source: [`session-hud/hooks/register.tsx`](./session-hud/hooks/register.tsx)

## Impact Map

Impact Map opens a pane that records the most recent files Claude touched during the current session.

It labels each file as:

- `READ` when Claude uses the Read tool
- `EDITED` when Claude uses the Edit tool
- `CREATED` when Claude uses the Write tool

The pane keeps the 14 most recent unique file paths. Reading or changing the same file again moves it to the newest position.

Edited and created files are clickable. Selecting one opens a Diff pane with Claude Code's native unified-diff highlighting. Tracked files use the current working-tree diff against `HEAD`. Untracked files are shown as newly added files.

The Diff pane reflects the file's current Git state, not a private history of only Claude's edits. If you or another tool changed the same file, those changes appear too. Read-only files are not clickable because they have no change to display.

### Test Impact Map

1. Install and load `impact-map`.
2. Ask Claude to read two files and edit one of them.
3. Watch the Impact Map pane update.
4. Select the edited file and confirm that its highlighted diff opens in a new pane tab.
5. If the Impact Map pane is closed, enter `/impact-map` to reopen it.

Claude Code has one docked pane area. If Verification Ledger is also open, the two panes appear as tabs in that area rather than side by side.

Source: [`impact-map/hooks/register.tsx`](./impact-map/hooks/register.tsx)

## Tool Cards

Tool Cards replaces Claude Code's standard tool-use row with a bordered card that emphasizes the current state, tool name, and target.

Possible states are:

- `RUNNING`
- `DONE`
- `FAILED`
- `STOPPED`

For file tools, the card displays the file path. For Bash, it displays the command. It also handles tools that expose a `path` or `pattern` field.

### Test Tool Cards

1. Install and load `tool-cards`.
2. Ask Claude to read a file.
3. Watch the card change from `RUNNING` to `DONE`.
4. Ask Claude to run a command that fails if you want to see the `FAILED` state.

The green `DONE` label is part of this mod. Disable Tool Cards from `/plugin` to return to Claude Code's normal tool rows.

Source: [`tool-cards/hooks/register.tsx`](./tool-cards/hooks/register.tsx)

## Safe Shell

Safe Shell is a harmless demonstration of a `tool.check` handler. It shows how a mod can stop before a Bash command runs and ask the user to approve or cancel it.

This version looks only for the marker:

```text
__SAFE_SHELL_DEMO__
```

It does not attempt to identify real dangerous commands. That limited behavior is intentional, so the demo cannot accidentally become a false promise of shell security.

### Test Safe Shell

1. Install and load `safe-shell`.
2. Ask Claude to run this exact command:

   ```bash
   echo __SAFE_SHELL_DEMO__
   ```

3. Claude Code should show a confirmation prompt from Safe Shell before the command runs.
4. Choose whether to continue or cancel.
5. Run a normal command such as `git status` and confirm that Safe Shell does not interfere.

Source: [`safe-shell/hooks/register.ts`](./safe-shell/hooks/register.ts)

## Quality Console

Quality Console adds a `/mod-check` command that runs Claude Code's official static validator against a local mod directory.

Use it from a Claude Code session:

```text
/mod-check /absolute/path/to/a-mod
```

If you omit the path, it validates the current working directory:

```text
/mod-check
```

The command displays `PASS`, `FAIL`, or `ERROR` followed by the validator output. Validation checks the manifest, hook events, matchers, API calls, imports, and statically detectable capabilities. It does not execute the mod.

### Test Quality Console

1. Install and load `quality-console`.
2. Clone this repository if you do not already have a local mod to check.
3. Enter `/mod-check` with the absolute path to one of the mod directories.
4. Confirm that the result starts with `PASS`.

Example:

```text
/mod-check /path/to/claude-mods/session-hud
```

Source: [`quality-console/hooks/register.ts`](./quality-console/hooks/register.ts)

## Verification Ledger

Verification Ledger opens a Checks pane that combines three kinds of evidence:

- Local verification commands run by Claude through the Bash tool
- Current Git branch, commit, working-tree state, and upstream state
- GitHub Actions runs for the current commit

Open it with:

```text
/checks
```

The pane does not open automatically, so it does not compete with Impact Map until you ask for it. When both panes are open, Claude Code places them in tabs within the same docked pane area.

### Recognized local commands

The ledger recognizes common commands in these categories:

- Verify: `npm run verify`, `pnpm verify`, `yarn verify`, `bun verify`, and `./scripts/verify`
- Tests: package test scripts, Vitest, Jest, Pytest, `cargo test`, and `go test`
- Lint: package lint scripts, ESLint, Biome, Ruff, golangci-lint, and Cargo Clippy
- Typecheck: package typecheck scripts, `tsc --noEmit`, Mypy, and Pyright
- Build: package build scripts, `cargo build`, and `go build`

The command must be run by Claude through its Bash tool. A command run manually in a separate terminal is not a Claude Code event, so the mod cannot observe it.

### Pass, fail, and stale results

Verification Ledger stores the latest result in each category for the current session.

- `PASS` means the recognized command completed successfully.
- `FAIL` means it returned an error.
- `STALE` means files, the current commit, or the recorded session revision changed after the check ran.

Local results reset when the mod reloads or a new session starts. The ledger is a live session display, not a permanent audit database.

### GitHub Actions support

Remote checks require the GitHub CLI:

```bash
gh --version
gh auth status
```

If needed, authenticate it:

```bash
gh auth login
```

While the Checks pane is open, the mod runs this read-only query for the current commit every 15 seconds:

```bash
gh run list --commit <commit-sha> --limit 8 --json name,status,conclusion,url,headSha,workflowName
```

The pane displays workflow links and the states `RUNNING`, `PASS`, `FAIL`, or `SKIPPED`. It also shows a toast when a previously running workflow passes or fails.

If `gh` is missing, not authenticated, or the repository is not hosted on GitHub, the remote section reports that GitHub CI is unavailable. Local checks and Git state still work.

### Change the polling interval

Open [`verification-ledger/hooks/config.ts`](./verification-ledger/hooks/config.ts):

```ts
export const CI_POLL_INTERVAL_MS = 15_000
export const MAX_CI_RUNS = 8
```

Change the values to control how often the open pane refreshes and how many workflow runs it displays.

### Test Verification Ledger

1. Install and load `verification-ledger` in a Git repository.
2. Enter `/checks`.
3. Ask Claude to run the project's test command.
4. Confirm that `Tests` appears with `PASS` or `FAIL`.
5. Ask Claude to edit a file.
6. Reopen or refresh `/checks` and confirm that the earlier result is `STALE`.
7. Push a commit with GitHub Actions configured.
8. Leave the pane open and watch the workflow move from `RUNNING` to its final state.

Source: [`verification-ledger/hooks/register.tsx`](./verification-ledger/hooks/register.tsx)

## How the mods work together

The mods have separate responsibilities, so their interface elements do not duplicate each other:

- Session HUD owns the band above the prompt.
- Tool Cards owns tool-use rows in the transcript.
- Impact Map owns a file-activity pane.
- Verification Ledger owns a checks pane.
- Quality Console owns `/mod-check`.
- Safe Shell owns only its marked-command confirmation.

Impact Map and Verification Ledger share Claude Code's single docked pane area as separate tabs. All other mods use different interface regions or event types.

## Develop locally from scratch

You do not need Node.js, a bundler, or a dependency installation. Claude Code loads TypeScript mod files directly and supplies the test runner.

### 1. Clone the repository

```bash
git clone https://github.com/bradtraversy/claude-mods.git
cd claude-mods
```

### 2. Validate the marketplace and every mod

```bash
claude plugin validate .
claude plugin validate ./session-hud
claude plugin validate ./impact-map
claude plugin validate ./tool-cards
claude plugin validate ./safe-shell
claude plugin validate ./quality-console
claude plugin validate ./verification-ledger
```

Validation reads the mod without executing it. Review the reported `hooks:` and `calls:` lines to see what it handles and which Claude Code APIs it uses.

### 3. Run the automated tests

```bash
claude plugin test ./session-hud
claude plugin test ./impact-map
claude plugin test ./tool-cards
claude plugin test ./safe-shell
claude plugin test ./quality-console
claude plugin test ./verification-ledger
```

The interface tests mount each visual mod on simulated terminal and desktop surfaces.

### 4. Load one mod for a development session

```bash
claude --plugin-dir ./session-hud
```

Claude Code watches a directory loaded with `--plugin-dir` and reloads the hooks module after changes. Run `/plugin` to confirm that the mod loaded.

You can load multiple development directories by repeating the flag:

```bash
claude \
  --plugin-dir ./session-hud \
  --plugin-dir ./impact-map \
  --plugin-dir ./tool-cards
```

### 5. Use the local checkout in terminal and desktop

Register the clone itself as a local marketplace:

```bash
claude plugin marketplace add /absolute/path/to/claude-mods
```

Then install any mod from `traversy-mods`. A marketplace added from a local directory reads these relative plugin directories in place, so edits appear after a new session starts or after `/reload-plugins`.

This is the easiest development setup for sharing the exact same working directory between terminal sessions and local desktop Code sessions.

## Anatomy of each mod

Every directory follows the same basic structure:

```text
mod-name/
├── .claude-plugin/
│   ├── plugin.json
│   └── types/
│       ├── .gitignore
│       └── tsconfig.json
├── hooks/
│   ├── hooks.json
│   ├── config.ts       # only when the mod has user-editable settings
│   └── register.tsx    # register.ts when JSX is not needed
├── tests/
│   └── mod-name.test.ts
└── tsconfig.json
```

### `plugin.json`

The plugin manifest provides the mod name, version, description, and author.

### `hooks.json`

This file points Claude Code to the TypeScript module that registers the event handlers.

### `register.ts` or `register.tsx`

The module imports the `Register` type from `claude-code` and exports a `register` function:

```ts
import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', ($, event, next) => {
    return next(event)
  })
}
```

The `Register` type comes from declarations generated by Claude Code in `.claude-plugin/types/`. Those declarations also provide types for `$`, `event`, and `next`, which removes the red lines an editor would otherwise show for the `claude-code` import and handler parameters.

Do not install a package named `claude-code` from npm for these types. Load the mod once with `--plugin-dir`, and Claude Code writes declarations that match the version you are actually running.

### Tests

Tests import from `claude-code/testing`. They fire events without running a real tool, network request, or Claude session.

## Updating

Update one installed mod from the shell:

```bash
claude plugin update session-hud@traversy-mods
```

Then restart the session or enter `/reload-plugins`.

Developers working from a local marketplace do not need an update command. Pull the repository and reload the plugins.

## Disable or uninstall a mod

Open `/plugin`, select the Installed tab, and disable or uninstall the mod.

From the shell:

```bash
claude plugin disable session-hud@traversy-mods
claude plugin uninstall session-hud@traversy-mods
```

## Troubleshooting

### The mod does not appear

- Check `claude --version` or `/status`.
- Run `/plugin` and confirm the mod is installed and enabled.
- Enter `/reload-plugins` after installing or editing it.
- Make sure the current workspace is trusted.
- Make sure Claude Code was not started with `--safe-mode` or `--bare`.
- Check that `disableAllHooks` is not enabled in your Claude Code settings.

### The editor shows red lines under `claude-code` or handler parameters

Load the mod once in an interactive session:

```bash
claude --plugin-dir ./path-to-mod
```

Claude Code generates `.claude-plugin/types/` and a compatible `tsconfig.json`. Make sure your editor has opened the mod directory or a parent workspace that includes it.

### A visual mod works in the terminal but not another surface

Mods can run hooks in more places than they can draw. Use a terminal or a local session in the desktop Code tab for these interface mods. The VS Code chat panel and non-interactive sessions do not display custom panes, bands, or replaced rows.

### GitHub Actions do not appear

- Run `gh --version`.
- Run `gh auth status`.
- Confirm the current repository has a GitHub remote.
- Confirm a workflow run exists for the exact current commit.
- Keep the Checks pane open or press its Refresh button.

## Security notes

Claude Code mods are not sandboxed. Before loading a mod, run:

```bash
claude plugin validate ./path-to-mod
```

Read the reported handlers and API calls, then inspect the source. A mod can potentially read files and environment variables, start processes, make network requests, observe prompts and tool calls, alter session behavior, and spend model usage.

The mods in this repository are intentionally small enough to inspect directly.

## Documentation

- [Claude Code mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [Test a mod](https://code.claude.com/docs/en/plugins/mods/test)
- [Create a plugin marketplace](https://code.claude.com/docs/en/plugins/create-marketplace)
- [Host and maintain a marketplace](https://code.claude.com/docs/en/plugins/host-marketplace)

## License

MIT
