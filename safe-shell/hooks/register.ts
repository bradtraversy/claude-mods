import type { Register } from 'claude-code'

const DEMO_MARKER = '__SAFE_SHELL_DEMO__'

export const register: Register = on => {
  on('tool.check', { tool: 'Bash' }, ($, event, next) => {
    const input = event.input as { command?: unknown }
    if (typeof input.command !== 'string' || !input.command.includes(DEMO_MARKER)) {
      return next(event)
    }

    return {
      decision: 'ask',
      reason: 'Safe Shell demo caught this harmless marked command. Review it before it runs.',
    }
  }).catch(() => ({
    decision: 'deny',
    reason: 'Safe Shell could not inspect the demo command.',
  }))
}
