import type { Register } from 'claude-code'

export const register: Register = on => {
  on('session.start', async ($, event, next) => {
    await $.command.register({
      name: 'mod-check',
      description: 'Validate a local Claude Code mod',
      argumentHint: '[directory]',
    })
    return next(event)
  })

  on('command.run', { command: 'mod-check' }, async ($, event) => {
    const target = event.args.trim() || '.'
    $.ui.status(`Validating ${target}`)

    try {
      const result = await $.process.run(['claude', 'plugin', 'validate', target], {
        timeoutMs: 30_000,
      })
      const output = [result.stdout.trim(), result.stderr.trim()].filter(Boolean).join('\n')

      return {
        text: result.exitCode === 0
          ? `PASS ${target}\n\n${output}`
          : `FAIL ${target}\n\n${output}`,
      }
    } catch (error) {
      return {
        text: `ERROR ${target}\n\n${error instanceof Error ? error.message : String(error)}`,
      }
    } finally {
      $.ui.status(undefined)
    }
  })
}
