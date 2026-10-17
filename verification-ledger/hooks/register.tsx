import type { EngineInterface, Register } from 'claude-code'
import { CI_POLL_INTERVAL_MS, MAX_CI_RUNS } from './config.ts'

const PANE = 'verification-ledger'
const CHECK_ORDER: CheckKind[] = ['verify', 'test', 'lint', 'typecheck', 'build']

type CheckKind = 'verify' | 'test' | 'lint' | 'typecheck' | 'build'
type ResultStatus = 'pass' | 'fail'
type DisplayStatus = ResultStatus | 'stale' | 'running' | 'skipped'

type LocalCheck = {
  kind: CheckKind
  label: string
  command: string
  status: ResultStatus
  completedAt: number
  fingerprint: string
  revision: number
}

type GitSnapshot = {
  root: string | null
  branch: string
  head: string
  shortHead: string
  fingerprint: string
  dirtyFiles: number
  ahead: number | null
  behind: number | null
}

type CiRun = {
  name: string
  status: string
  conclusion: string
  url: string
  headSha: string
}

type CommandResult = {
  exitCode: number
  stdout: string
}

type LedgerSummary = {
  headline: string
  detail: string
  color: 'success' | 'error' | 'warning' | 'inactive'
}

const checks = new Map<CheckKind, LocalCheck>()
let git: GitSnapshot = emptyGitSnapshot()
let ciRuns: CiRun[] = []
let ciMessage = 'Open this pane to load GitHub CI.'
let ciRefreshedAt: number | null = null
let revision = 0
let refreshTask: Promise<void> | null = null
let pollStarted = false
let didAutoOpen = false
let sessionGeneration = 0

function emptyGitSnapshot(): GitSnapshot {
  return {
    root: null,
    branch: '',
    head: '',
    shortHead: '',
    fingerprint: '',
    dirtyFiles: 0,
    ahead: null,
    behind: null,
  }
}

function clearSessionState(): void {
  sessionGeneration += 1
  checks.clear()
  git = emptyGitSnapshot()
  ciRuns = []
  ciMessage = 'Open this pane to load GitHub CI.'
  ciRefreshedAt = null
  revision = 0
  refreshTask = null
  didAutoOpen = false
}

function classifyCheck(command: string): { kind: CheckKind; label: string } | null {
  const value = command.toLowerCase()

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?verify\b|(?:^|\s)\.\/scripts\/verify\b/.test(value)) {
    return { kind: 'verify', label: 'Verify' }
  }

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?:\s|:|$)|\b(?:vitest|jest|pytest|cargo\s+test|go\s+test)\b/.test(value)) {
    return { kind: 'test', label: 'Tests' }
  }

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?:\s|:|$)|\b(?:eslint|biome\s+check|ruff\s+check|golangci-lint|cargo\s+clippy)\b/.test(value)) {
    return { kind: 'lint', label: 'Lint' }
  }

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck\b|\b(?:tsc\s+--noemit|mypy|pyright)\b/.test(value)) {
    return { kind: 'typecheck', label: 'Typecheck' }
  }

  if (/\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?:\s|:|$)|\b(?:cargo|go)\s+build\b/.test(value)) {
    return { kind: 'build', label: 'Build' }
  }

  return null
}

async function run(
  $: EngineInterface,
  argv: readonly string[],
  cwd: string,
): Promise<CommandResult> {
  try {
    const result = await $.process.run(argv, { cwd, timeoutMs: 10_000 })
    return { exitCode: result.exitCode, stdout: result.stdout.trim() }
  } catch {
    return { exitCode: 1, stdout: '' }
  }
}

async function readGitSnapshot($: EngineInterface): Promise<GitSnapshot> {
  const cwd = await $.session.cwd()
  const rootResult = await run($, ['git', 'rev-parse', '--show-toplevel'], cwd)
  if (rootResult.exitCode !== 0 || !rootResult.stdout) return emptyGitSnapshot()

  const root = rootResult.stdout
  const [branchResult, headResult, shortHeadResult, statusResult, upstreamResult] = await Promise.all([
    run($, ['git', 'branch', '--show-current'], root),
    run($, ['git', 'rev-parse', 'HEAD'], root),
    run($, ['git', 'rev-parse', '--short', 'HEAD'], root),
    run($, ['git', 'status', '--porcelain=v1'], root),
    run($, ['git', 'rev-parse', '--verify', '@{upstream}'], root),
  ])

  const status = statusResult.stdout
  let ahead: number | null = null
  let behind: number | null = null

  if (upstreamResult.exitCode === 0) {
    const counts = await run($, ['git', 'rev-list', '--left-right', '--count', 'HEAD...@{upstream}'], root)
    if (counts.exitCode === 0) {
      const values = counts.stdout.split(/\s+/)
      const left = Number(values[0])
      const right = Number(values[1])
      if (Number.isFinite(left) && Number.isFinite(right)) {
        ahead = left
        behind = right
      }
    }
  }

  return {
    root,
    branch: branchResult.stdout || '(detached)',
    head: headResult.stdout,
    shortHead: shortHeadResult.stdout,
    fingerprint: `${headResult.stdout}\n${status}`,
    dirtyFiles: status ? status.split('\n').filter(Boolean).length : 0,
    ahead,
    behind,
  }
}

async function refreshLocal(
  $: EngineInterface,
  generation = sessionGeneration,
): Promise<boolean> {
  const snapshot = await readGitSnapshot($)
  if (generation !== sessionGeneration) return false

  git = snapshot
  $.ui.invalidate('ui.render')
  return true
}

function ciStatus(run: CiRun): DisplayStatus {
  if (run.status !== 'completed') return 'running'
  if (run.conclusion === 'success') return 'pass'
  if (run.conclusion === 'neutral' || run.conclusion === 'skipped') return 'skipped'
  return 'fail'
}

function ciOverall(runs: readonly CiRun[]): 'none' | 'running' | 'pass' | 'fail' {
  if (runs.length === 0) return 'none'
  if (runs.some(run => ciStatus(run) === 'fail')) return 'fail'
  if (runs.some(run => ciStatus(run) === 'running')) return 'running'
  return 'pass'
}

async function refreshCi(
  $: EngineInterface,
  generation = sessionGeneration,
): Promise<void> {
  const snapshot = git

  if (!snapshot.root || !snapshot.head) {
    const refreshedAt = await $.clock.now()
    if (generation !== sessionGeneration) return

    ciRuns = []
    ciMessage = 'GitHub CI requires a Git repository with a commit.'
    ciRefreshedAt = refreshedAt
    return
  }

  const previous = ciOverall(ciRuns)
  const result = await run(
    $,
    [
      'gh',
      'run',
      'list',
      '--commit',
      snapshot.head,
      '--limit',
      String(MAX_CI_RUNS),
      '--json',
      'name,status,conclusion,url,headSha,workflowName',
    ],
    snapshot.root,
  )

  const refreshedAt = await $.clock.now()
  if (generation !== sessionGeneration) return
  ciRefreshedAt = refreshedAt

  if (result.exitCode !== 0) {
    ciRuns = []
    ciMessage = 'GitHub CI is unavailable. Check the remote and gh authentication.'
    return
  }

  try {
    const parsed = JSON.parse(result.stdout) as Array<{
      name?: unknown
      workflowName?: unknown
      status?: unknown
      conclusion?: unknown
      url?: unknown
      headSha?: unknown
    }>

    ciRuns = parsed
      .filter(item => item && typeof item === 'object')
      .map(item => ({
        name: typeof item.workflowName === 'string' && item.workflowName
          ? item.workflowName
          : typeof item.name === 'string' && item.name
            ? item.name
            : 'Workflow',
        status: typeof item.status === 'string' ? item.status : 'unknown',
        conclusion: typeof item.conclusion === 'string' ? item.conclusion : '',
        url: typeof item.url === 'string' ? item.url : '',
        headSha: typeof item.headSha === 'string' ? item.headSha : '',
      }))
      .filter(run => !run.headSha || run.headSha === snapshot.head)
      .slice(0, MAX_CI_RUNS)

    ciMessage = ciRuns.length === 0
      ? `No GitHub Actions runs found for ${snapshot.shortHead}.`
      : ''
  } catch {
    ciRuns = []
    ciMessage = 'GitHub returned CI data that the ledger could not read.'
  }

  const current = ciOverall(ciRuns)
  if (previous === 'running' && current === 'pass') {
    $.ui.toast(`GitHub CI passed for ${snapshot.shortHead}.`)
  } else if (previous === 'running' && current === 'fail') {
    $.ui.toast(`GitHub CI failed for ${snapshot.shortHead}.`)
  }
}

function refreshAll($: EngineInterface): Promise<void> {
  if (refreshTask) return refreshTask

  const generation = sessionGeneration
  let task: Promise<void>
  task = (async () => {
    const refreshed = await refreshLocal($, generation)
    if (refreshed) await refreshCi($, generation)
  })().finally(() => {
    if (refreshTask === task) refreshTask = null
    if (generation === sessionGeneration) $.ui.invalidate('ui.render')
  })
  refreshTask = task

  $.ui.invalidate('ui.render')
  return task
}

async function maybeAutoOpen($: EngineInterface): Promise<void> {
  if (didAutoOpen) return

  const generation = sessionGeneration
  await $.ui.open({
    id: PANE,
    title: 'Checks',
    closeOnEscape: true,
    columns: 56,
  })
  if (generation !== sessionGeneration) return
  didAutoOpen = true
  void refreshAll($)
}

async function pollIfOpen($: EngineInterface): Promise<void> {
  const panes = await $.ui.panes()
  if (panes.some(pane => pane.id === PANE)) await refreshAll($)
}

function localStatus(check: LocalCheck): DisplayStatus {
  if (check.revision !== revision) return 'stale'
  if (git.fingerprint && check.fingerprint !== git.fingerprint) return 'stale'
  return check.status
}

function statusColor(status: DisplayStatus): 'success' | 'error' | 'warning' | 'inactive' {
  if (status === 'pass') return 'success'
  if (status === 'fail') return 'error'
  if (status === 'stale' || status === 'running') return 'warning'
  return 'inactive'
}

function statusLabel(status: DisplayStatus): string {
  return status.toUpperCase()
}

function timeLabel(value: number | null): string {
  if (value === null) return ''
  return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function branchState(): string {
  const parts = [git.dirtyFiles === 0 ? 'clean' : `${git.dirtyFiles} changed`]
  if (git.ahead !== null && git.ahead > 0) parts.push(`${git.ahead} ahead`)
  if (git.behind !== null && git.behind > 0) parts.push(`${git.behind} behind`)
  if (git.ahead === null) parts.push('no upstream')
  return parts.join(' · ')
}

function countLabel(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'}`
}

function ledgerSummary(localChecks: readonly LocalCheck[]): LedgerSummary {
  const localResults = localChecks.map(check => ({ check, status: localStatus(check) }))
  const failed = localResults.filter(result => result.status === 'fail')
  const stale = localResults.filter(result => result.status === 'stale')
  const remote = ciOverall(ciRuns)

  if (failed.length > 0) {
    return {
      headline: `${countLabel(failed.length, 'check')} failed`,
      detail: `Fix ${failed[0].check.label}${failed.length > 1 ? ` and ${failed.length - 1} more` : ''} before review.`,
      color: 'error',
    }
  }

  if (remote === 'fail') {
    return {
      headline: 'GitHub CI failed',
      detail: 'Open the failed workflow below before review.',
      color: 'error',
    }
  }

  if (stale.length > 0) {
    return {
      headline: 'Checks need a rerun',
      detail: `Rerun ${stale[0].check.label}${stale.length > 1 ? ` and ${stale.length - 1} more` : ''} after the latest changes.`,
      color: 'warning',
    }
  }

  if (remote === 'running') {
    return {
      headline: 'GitHub CI is running',
      detail: localChecks.length > 0 ? 'Local checks pass. Waiting for the workflow.' : 'Waiting for the workflow to finish.',
      color: 'warning',
    }
  }

  if (localChecks.length === 0) {
    return {
      headline: git.root ? 'No checks yet' : 'No repository detected',
      detail: git.root ? 'Run tests, lint, typecheck, build, or verify.' : 'Open a Git project to track release readiness.',
      color: 'inactive',
    }
  }

  if (remote === 'pass' && git.dirtyFiles === 0) {
    return {
      headline: 'Ready for review',
      detail: 'Local checks and GitHub CI are current.',
      color: 'success',
    }
  }

  return {
    headline: 'Local checks pass',
    detail: `${countLabel(localChecks.length, 'check')} current. No passing CI result for this commit.`,
    color: 'success',
  }
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    clearSessionState()
    await $.command.register({
      name: 'checks',
      description: 'Open and refresh the Verification Ledger',
    })

    await refreshLocal($)

    if (!pollStarted) {
      pollStarted = true
      $.clock.every(CI_POLL_INTERVAL_MS, () => {
        void pollIfOpen($)
      })
    }

    return next(event)
  })

  on('session.end', ($, event, next) => {
    if (event.reason === 'clear' || event.reason === 'resume') {
      clearSessionState()
      $.ui.invalidate('ui.render')
    }
    return next(event)
  })

  on('command.run', { command: 'checks' }, async $ => {
    const generation = sessionGeneration
    await $.ui.open({
      id: PANE,
      title: 'Checks',
      focus: true,
      closeOnEscape: true,
      columns: 56,
    })
    if (generation !== sessionGeneration) return {}
    didAutoOpen = true
    await refreshAll($)
    return {}
  })

  on('tool.call', { tool: 'Bash' }, async ($, event, next) => {
    const generation = sessionGeneration
    const recognized = classifyCheck(event.command)
    const result = await next(event)
    if (generation !== sessionGeneration) return result
    if ('deny' in result) return result

    try {
      const completed = !result.isError ? result.result : null
      const backgrounded = completed?.backgroundTaskId !== undefined
      const changed = completed?.bashEditDiff !== undefined

      if (changed) revision += 1
      if (changed || recognized) {
        const refreshed = await refreshLocal($, generation)
        if (!refreshed) return result
      }

      if (recognized && !event.run_in_background && !backgrounded) {
        const completedAt = await $.clock.now()
        if (generation !== sessionGeneration) return result
        checks.set(recognized.kind, {
          ...recognized,
          command: event.command,
          status: result.isError ? 'fail' : 'pass',
          completedAt,
          fingerprint: git.fingerprint,
          revision,
        })

        await maybeAutoOpen($)
        if (generation !== sessionGeneration) return result
        if (result.isError) $.ui.toast(`${recognized.label} failed.`)
        $.ui.invalidate('ui.render')
      }

      if (completed?.gitOperation?.push) {
        $.ui.toast('Push detected. Watching GitHub CI.')
        $.clock.after(1_000, () => {
          void refreshAll($)
        })
      }
    } catch (error) {
      $.ui.log(`Verification Ledger could not record a Bash result: ${String(error)}`, { to: 'debug' })
    }

    return result
  }).catch(($, event, next) => next(event))

  on('tool.call', { tool: ['Edit', 'Write', 'NotebookEdit'] }, async ($, event, next) => {
    const generation = sessionGeneration
    const result = await next(event)
    if (generation !== sessionGeneration) return result
    if ('deny' in result || result.isError) return result

    try {
      revision += 1
      await refreshLocal($, generation)
    } catch (error) {
      $.ui.log(`Verification Ledger could not refresh after an edit: ${String(error)}`, { to: 'debug' })
    }

    return result
  }).catch(($, event, next) => next(event))

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, event) => {
    const { Box, Button, Link, Text } = $.ui.resolve(event)
    const localChecks = CHECK_ORDER
      .map(kind => checks.get(kind))
      .filter((check): check is LocalCheck => check !== undefined)
    const summary = ledgerSummary(localChecks)

    return (
      <Box flexDirection="column" gap={1}>
        <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text bold wrap="truncate-end">Verification Ledger</Text>
          </Box>
          <Button
            key="refresh"
            label={refreshTask ? 'Refreshing' : 'Refresh'}
            hotkey="r"
            variant="secondary"
            onPress={() => {
              void refreshAll($)
            }}
          />
        </Box>

        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor={summary.color}
          paddingX={1}
          overflow="hidden"
        >
          <Box gap={1} overflow="hidden">
            <Text color={summary.color} bold>●</Text>
            <Text bold wrap="truncate-end">{summary.headline}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">{summary.detail}</Text>
        </Box>

        {git.root ? (
          <Box flexDirection="column" overflow="hidden">
            <Box gap={1} overflow="hidden">
              <Text bold wrap="truncate-middle">{git.branch}</Text>
              <Text dimColor>{git.shortHead}</Text>
            </Box>
            <Text dimColor wrap="truncate-end">{branchState()}</Text>
          </Box>
        ) : (
          <Text dimColor>Git status unavailable.</Text>
        )}

        <Box flexDirection="column" gap={1}>
          <Text bold>Local checks</Text>
          {localChecks.length === 0 ? (
            <Text dimColor>No verification commands recorded this session.</Text>
          ) : (
            localChecks.map(check => {
              const status = localStatus(check)
              return (
                <Box
                  key={check.kind}
                  justifyContent="space-between"
                  alignItems="center"
                  gap={1}
                  overflow="hidden"
                >
                  <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Text color={statusColor(status)}>●</Text>
                    <Text bold wrap="truncate-end">{check.label}</Text>
                  </Box>
                  <Box gap={1} flexShrink={0}>
                    <Text dimColor>{timeLabel(check.completedAt)}</Text>
                    <Text color={statusColor(status)} bold>{statusLabel(status)}</Text>
                  </Box>
                </Box>
              )
            })
          )}
        </Box>

        <Box flexDirection="column" gap={1}>
          <Text bold>GitHub CI</Text>
          {ciRuns.length === 0 ? (
            <Text dimColor wrap="truncate-end">{ciMessage}</Text>
          ) : (
            ciRuns.map((run, index) => {
              const status = ciStatus(run)
              return (
                <Box
                  key={`${run.url}:${index}`}
                  justifyContent="space-between"
                  alignItems="center"
                  gap={1}
                  overflow="hidden"
                >
                  <Box gap={1} flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                    <Text color={statusColor(status)}>●</Text>
                    {run.url ? <Link href={run.url} label={run.name} /> : <Text wrap="truncate-end">{run.name}</Text>}
                  </Box>
                  <Text color={statusColor(status)} bold>{statusLabel(status)}</Text>
                </Box>
              )
            })
          )}
          {ciRefreshedAt !== null && <Text dimColor>Updated {timeLabel(ciRefreshedAt)}</Text>}
        </Box>
      </Box>
    )
  })
}
