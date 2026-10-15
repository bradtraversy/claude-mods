import { expect, test } from 'claude-code/testing'

test('/mod-check reports a successful validation', async ($, on) => {
  on('ui.status', () => ({ value: undefined }))
  on('process.run', () => ({
    value: {
      exitCode: 0,
      stdout: 'Validation passed',
      stderr: '',
      isStdoutTruncated: false,
      isStderrTruncated: false,
    },
  }))

  const result = await $.command.run({
    command: 'mod-check',
    args: '.',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  expect(result.text).toContain('PASS .')
  expect(result.text).toContain('Validation passed')
})
