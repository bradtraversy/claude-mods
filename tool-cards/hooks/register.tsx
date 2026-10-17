import type { EngineInterface, Register } from 'claude-code'

const MAX_DETAIL_CHARS = 6_000
const MAX_TRACKED_TOOLS = 200

type ToolState = 'running' | 'done' | 'failed' | 'stopped'

type ToolTiming = {
  startedAt: number
  endedAt?: number
}

type ToolDetail = {
  source: string
  format: 'source' | 'diff'
  path?: string
}

const timings = new Map<string, ToolTiming>()
const expansionOverrides = new Map<string, boolean>()
let currentTime = 0
let activeTools = 0
let sessionGeneration = 0
let stopTicker: (() => void) | null = null

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`
}

function clearSessionState(): void {
  sessionGeneration += 1
  timings.clear()
  expansionOverrides.clear()
  currentTime = 0
  activeTools = 0
}

function stopClockTicker(): void {
  stopTicker?.()
  stopTicker = null
}

function rememberTiming(toolUseId: string, timing: ToolTiming): void {
  timings.delete(toolUseId)
  timings.set(toolUseId, timing)

  if (timings.size > MAX_TRACKED_TOOLS) {
    const oldest = timings.keys().next().value
    if (oldest !== undefined) {
      timings.delete(oldest)
      expansionOverrides.delete(oldest)
    }
  }
}

async function readClock($: EngineInterface): Promise<number | undefined> {
  try {
    return await $.clock.now()
  } catch {
    return undefined
  }
}

function startClockTicker($: EngineInterface): void {
  stopClockTicker()
  stopTicker = $.clock.every(1_000, () => {
    if (activeTools === 0) return

    void readClock($).then(now => {
      if (now === undefined || activeTools === 0) return
      currentTime = now
      $.ui.invalidate('ui.render')
    })
  })
}

function inputTarget(tool: string, input: unknown): string {
  if (!isRecord(input)) return 'No details'

  if (tool === 'Bash') {
    const description = asString(input.description)
    if (description) return truncate(description, 90)
  }

  const candidate = input.file_path
    ?? input.path
    ?? input.command
    ?? input.pattern
    ?? input.query
    ?? input.url
    ?? input.description
    ?? input.subject

  return typeof candidate === 'string' ? truncate(candidate, 90) : 'No details'
}

function status(isRunning: boolean, isErrored: boolean, isInterrupted: boolean): ToolState {
  if (isInterrupted) return 'stopped'
  if (isErrored) return 'failed'
  if (isRunning) return 'running'
  return 'done'
}

function statusColor(state: ToolState): 'success' | 'warning' | 'error' | 'inactive' {
  if (state === 'failed') return 'error'
  if (state === 'running') return 'warning'
  if (state === 'stopped') return 'inactive'
  return 'success'
}

function toolGlyph(tool: string): string {
  if (tool === 'Bash') return '>'
  if (tool === 'Read') return 'R'
  if (tool === 'Edit' || tool === 'NotebookEdit') return '~'
  if (tool === 'Write') return '+'
  if (tool === 'Glob' || tool === 'Grep' || tool === 'WebSearch') return '?'
  if (tool === 'Agent') return '@'
  if (tool.startsWith('mcp__')) return '*'
  return '#'
}

function toolLabel(tool: string): string {
  if (!tool.startsWith('mcp__')) return truncate(tool, 24)

  const [, server = 'mcp', ...nameParts] = tool.split('__')
  const name = nameParts.join(' ').replaceAll('_', ' ')
  return truncate(`${server}: ${name || 'tool'}`, 24)
}

function lineCount(value: string): number {
  const normalized = value.trimEnd()
  if (!normalized) return 0
  return normalized.split('\n').length
}

function formatCount(value: number): string {
  if (value < 1_000) return String(value)
  if (value < 1_000_000) return `${Math.round(value / 100) / 10}k`
  return `${Math.round(value / 100_000) / 10}m`
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return '<1s'
  if (durationMs < 10_000) {
    const seconds = Math.round(durationMs / 100) / 10
    return `${seconds}s`
  }
  if (durationMs < 60_000) return `${Math.round(durationMs / 1_000)}s`

  const minutes = Math.floor(durationMs / 60_000)
  const seconds = Math.round((durationMs % 60_000) / 1_000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

function timingLabel(toolUseId: string, output: unknown): string {
  const timing = timings.get(toolUseId)
  if (timing) {
    const endedAt = timing.endedAt ?? currentTime
    return formatDuration(Math.max(0, endedAt - timing.startedAt))
  }

  if (isRecord(output)) {
    const duration = asNumber(output.totalDurationMs) ?? asNumber(output.durationMs)
    if (duration !== undefined) return formatDuration(duration)
  }

  return ''
}

function diffSummary(output: Record<string, unknown>): string {
  const gitDiff = isRecord(output.gitDiff) ? output.gitDiff : undefined
  const additions = gitDiff ? asNumber(gitDiff.additions) : undefined
  const deletions = gitDiff ? asNumber(gitDiff.deletions) : undefined

  if (additions !== undefined && deletions !== undefined) {
    return `+${additions} -${deletions}`
  }

  return ''
}

function bashFileCount(output: Record<string, unknown>): number {
  const editDiff = isRecord(output.bashEditDiff) ? output.bashEditDiff : undefined
  const files = editDiff && Array.isArray(editDiff.files) ? editDiff.files.length : 0
  const moreFiles = editDiff ? asNumber(editDiff.moreFiles) ?? 0 : 0
  return files + moreFiles
}

function resultSummary(tool: string, output: unknown, state: ToolState): string {
  if (state === 'running') return ''
  if (state === 'stopped') return 'Interrupted'
  if (!isRecord(output)) return state === 'failed' ? 'Open details for the error' : ''

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    if (output.staged === true) return 'Staged for review'
    const summary = diffSummary(output)
    if (summary) return summary
    if (tool === 'Write' && (output.type === 'create' || output.type === 'update')) {
      return output.type === 'create' ? 'File created' : 'File updated'
    }
  }

  if (tool === 'Read') {
    const file = isRecord(output.file) ? output.file : undefined
    const lines = file ? asNumber(file.numLines) : undefined
    const total = file ? asNumber(file.totalLines) : undefined
    if (lines !== undefined && total !== undefined) return `${lines} of ${total} lines`

    const dimensions = file && isRecord(file.dimensions) ? file.dimensions : undefined
    const width = dimensions ? asNumber(dimensions.originalWidth) : undefined
    const height = dimensions ? asNumber(dimensions.originalHeight) : undefined
    if (width !== undefined && height !== undefined) return `${width} x ${height}`
  }

  if (tool === 'Bash') {
    const backgroundTaskId = asString(output.backgroundTaskId)
    if (backgroundTaskId) return `Background task ${backgroundTaskId}`

    const changedFiles = bashFileCount(output)
    if (changedFiles > 0) return `${changedFiles} file${changedFiles === 1 ? '' : 's'} changed`

    const stdout = asString(output.stdout) ?? ''
    const stderr = asString(output.stderr) ?? ''
    const outputLines = lineCount(stdout) + lineCount(stderr)
    if (outputLines > 0) return `${outputLines} output line${outputLines === 1 ? '' : 's'}`
    if (output.noOutputExpected === true) return 'No output expected'
  }

  if (tool === 'Agent' && output.status === 'completed') {
    const parts: string[] = []
    const tokens = asNumber(output.totalTokens)
    const tools = asNumber(output.totalToolUseCount)
    if (tokens !== undefined) parts.push(`${formatCount(tokens)} tokens`)
    if (tools !== undefined) parts.push(`${tools} tool${tools === 1 ? '' : 's'}`)
    return parts.join(' | ')
  }

  return state === 'failed' ? 'Open details for the error' : ''
}

function outputDetail(tool: string, output: unknown): ToolDetail | null {
  if (typeof output === 'string' && output) {
    return {
      source: truncate(output, MAX_DETAIL_CHARS),
      format: 'source',
    }
  }

  if (!isRecord(output)) return null

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const gitDiff = isRecord(output.gitDiff) ? output.gitDiff : undefined
    const patch = gitDiff ? asString(gitDiff.patch) : undefined
    if (patch) {
      if (patch.length > MAX_DETAIL_CHARS) {
        return {
          source: `Diff is too large to display (${Math.round(patch.length / 1_000)}k characters).`,
          format: 'source',
        }
      }

      return {
        source: patch,
        format: 'diff',
        path: asString(gitDiff.filename),
      }
    }
  }

  if (tool === 'Bash') {
    const stdout = asString(output.stdout) ?? ''
    const stderr = asString(output.stderr) ?? ''
    const sections = [
      stdout ? stdout.trimEnd() : '',
      stderr ? `stderr:\n${stderr.trimEnd()}` : '',
    ].filter(Boolean)

    if (sections.length > 0) {
      return {
        source: truncate(sections.join('\n\n'), MAX_DETAIL_CHARS),
        format: 'source',
      }
    }
  }

  if (typeof output.text === 'string' && output.text) {
    return {
      source: truncate(output.text, MAX_DETAIL_CHARS),
      format: 'source',
    }
  }

  return null
}

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    stopClockTicker()
    clearSessionState()
    currentTime = await readClock($) ?? 0
    startClockTicker($)
    return next(event)
  })

  on('session.end', ($, event, next) => {
    clearSessionState()
    if (event.reason !== 'clear' && event.reason !== 'resume') stopClockTicker()
    $.ui.invalidate('ui.render')
    return next(event)
  })

  on('tool.call', async ($, event, next) => {
    const generation = sessionGeneration
    const startedAt = await readClock($)

    if (startedAt !== undefined && generation === sessionGeneration) {
      currentTime = startedAt
      rememberTiming(event.tool_use_id, { startedAt })
      activeTools += 1
      $.ui.invalidate('ui.render')
    }

    try {
      return await next(event)
    } finally {
      if (generation === sessionGeneration && startedAt !== undefined) {
        const endedAt = await readClock($)
        if (generation === sessionGeneration) {
          activeTools = Math.max(0, activeTools - 1)
          if (endedAt !== undefined) {
            currentTime = endedAt
            rememberTiming(event.tool_use_id, { startedAt, endedAt })
            $.ui.invalidate('ui.render')
          } else {
            timings.delete(event.tool_use_id)
          }
        }
      }
    }
  })

  on('ui.render', { component: 'ToolGroup' }, ($, event, next) => {
    if (event.props.isExpanded) return next(event)

    return next({
      ...event,
      props: {
        ...event.props,
        isExpanded: true,
      },
    })
  })

  on('ui.render', { component: 'ToolUse' }, ($, event) => {
    const { Box, Button, Code, Text } = $.ui.resolve(event)
    const state = status(event.props.isRunning, event.props.isErrored, event.props.isInterrupted)
    const color = statusColor(state)
    const summary = resultSummary(event.props.tool, event.props.output, state)
    const duration = timingLabel(event.props.tool_use_id, event.props.output)
    const detail = outputDetail(event.props.tool, event.props.output)
    const expanded = expansionOverrides.get(event.props.tool_use_id) ?? event.props.isErrored

    return (
      <Box
        borderStyle="round"
        paddingX={1}
        flexDirection="column"
        overflow="hidden"
      >
        <Box justifyContent="space-between" alignItems="center" gap={1} overflow="hidden">
          <Box
            gap={1}
            alignItems="center"
            flexWrap="wrap"
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            overflow="hidden"
          >
            <Text color={color} bold>{toolGlyph(event.props.tool)}</Text>
            <Text color={color} bold>
              {state.toUpperCase().padEnd(7)}
            </Text>
            <Text bold wrap="truncate-end">{toolLabel(event.props.tool)}</Text>
            {duration && <Text dimColor>{duration}</Text>}
            {summary && <Text dimColor wrap="truncate-middle">{summary}</Text>}
          </Box>
          {detail && (
            <Box flexShrink={0}>
              <Button
                key={`tool-card-details:${event.props.tool_use_id}`}
                label={expanded ? 'Hide' : 'Details'}
                variant="secondary"
                onPress={() => {
                  expansionOverrides.set(event.props.tool_use_id, !expanded)
                  $.ui.invalidate('ui.render')
                }}
              />
            </Box>
          )}
        </Box>
        <Text dimColor wrap="truncate-middle">
          {inputTarget(event.props.tool, event.props.input)}
        </Text>
        {detail && expanded && (
          <Box marginTop={1}>
            <Code
              source={detail.source}
              format={detail.format}
              path={detail.path}
              wrap="truncate-end"
            />
          </Box>
        )}
      </Box>
    )
  })
}
