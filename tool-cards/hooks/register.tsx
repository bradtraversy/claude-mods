import type { Register } from 'claude-code'

type ToolState = 'running' | 'done' | 'failed' | 'stopped'

function inputTarget(input: unknown): string {
  if (!input || typeof input !== 'object') return 'No details'

  const values = input as Record<string, unknown>
  const candidate = values.file_path ?? values.path ?? values.command ?? values.pattern
  if (typeof candidate !== 'string') return 'No details'
  return candidate.length > 90 ? `${candidate.slice(0, 87)}...` : candidate
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

export const register: Register = on => {
  on('ui.render', { component: 'ToolUse' }, ($, event) => {
    const { Box, Text } = $.ui.resolve(event)
    const state = status(event.props.isRunning, event.props.isErrored, event.props.isInterrupted)
    const color = statusColor(state)

    return (
      <Box borderStyle="round" paddingX={1} gap={1}>
        <Text color={color} bold>
          {state.toUpperCase().padEnd(7)}
        </Text>
        <Text bold>{event.props.tool}</Text>
        <Text dimColor wrap="truncate">
          {inputTarget(event.props.input)}
        </Text>
      </Box>
    )
  })
}
