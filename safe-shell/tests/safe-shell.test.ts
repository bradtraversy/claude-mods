import { expect, test } from 'claude-code/testing'

test('asks about the demo command and leaves normal commands unchanged', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))

  const flagged = await $.tool.check({
    tool: 'Bash',
    input: { command: 'echo __SAFE_SHELL_DEMO__' },
  })
  const normal = await $.tool.check({
    tool: 'Bash',
    input: { command: 'git status' },
  })

  expect(flagged.decision).toBe('ask')
  expect(flagged.reason).toContain('Safe Shell demo')
  expect(normal.decision).toBe('allow')
})
