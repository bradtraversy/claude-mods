import type { Register } from 'claude-code'
import { CONTEXT_MAX_TOKENS } from './config.ts'

function meter(percent: number, width: number): string {
  const safePercent = Math.min(Math.max(percent, 0), 100)
  const filled = Math.round((safePercent / 100) * width)
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

function rateLimitLabel(kind: string): string {
  if (kind === 'five_hour') return '5h'
  if (kind === 'seven_day') return '7d'
  return kind.replaceAll('_', ' ')
}

function tokenLabel(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}m`
  }

  return `${Math.round(tokens / 1_000)}k`
}

export const register: Register = on => {
  on('session.measure', ($, event, next) => {
    $.ui.invalidate('ui.render')
    return next(event)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    if (event.props.hasSurvey) return next(event)

    const { Box, Text } = $.ui.resolve(event)
    const usage = await $.session.usage()
    const tokens = usage.context.tokens ?? 0
    const percent = Math.max(0, Math.round((tokens / CONTEXT_MAX_TOKENS) * 100))
    const width = Math.max(8, Math.min(20, event.props.bodyColumns - 50))
    const primaryLimit = usage.rateLimits[0]
    const meterColor = percent >= 100 ? 'error' : percent >= 80 ? 'warning' : 'success'

    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Text bold>Context {percent}% of {tokenLabel(CONTEXT_MAX_TOKENS)}</Text>
          <Text color={meterColor}>{meter(percent, width)}</Text>
          {usage.cost && <Text dimColor>${usage.cost.usd.toFixed(2)}</Text>}
          {primaryLimit && (
            <Text dimColor>
              {rateLimitLabel(primaryLimit.kind)} {primaryLimit.percentUsed}%
            </Text>
          )}
        </Box>
      </Box>
    )
  })
}
