import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const PROPS: RenderPropsOf['Pane'] = {
  title: 'Checks',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 24 },
  view: {},
}

test('shows local checks, staleness, and GitHub CI on terminal and desktop', async ($, on) => {
  let dirty = false

  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.log', () => ({ value: undefined }))
  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 1_700_000_000_000 }))

  on('process.run', ($, event) => {
    const command = event.argv.join(' ')
    let stdout = ''

    if (command === 'git rev-parse --show-toplevel') stdout = '/project'
    if (command === 'git branch --show-current') stdout = 'feature/checks'
    if (command === 'git rev-parse HEAD') stdout = 'abcdef1234567890'
    if (command === 'git rev-parse --short HEAD') stdout = 'abcdef1'
    if (command === 'git status --porcelain=v1') stdout = dirty ? ' M src/app.ts' : ''
    if (command === 'git rev-parse --verify @{upstream}') stdout = 'abcdef1234567890'
    if (command === 'git rev-list --left-right --count HEAD...@{upstream}') stdout = '0\t0'
    if (command.startsWith('gh run list')) {
      stdout = JSON.stringify([
        {
          name: 'CI',
          workflowName: 'CI',
          status: 'in_progress',
          conclusion: '',
          url: 'https://github.com/example/project/actions/runs/1',
          headSha: 'abcdef1234567890',
        },
      ])
    }

    return {
      value: {
        exitCode: 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })

  on('tool.call', ($, event) => {
    if (event.tool !== 'Bash') return { result: 'ok' }

    if (event.command === 'touch src/app.ts') {
      dirty = true
      return {
        result: {
          stdout: '',
          stderr: '',
          interrupted: false,
          bashEditDiff: { files: [], moreFiles: 0, changedFiles: ['/project/src/app.ts'] },
        },
      }
    }

    return { result: { stdout: 'passed', stderr: '', interrupted: false } }
  })

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  await $.tool.call({ tool: 'Bash', command: 'touch src/app.ts' })
  await $.command.run({
    command: 'checks',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'verification-ledger',
      surface,
      component: 'Pane',
      requestId: 'verification-ledger',
      props: PROPS,
    })

    expect(await ui.find({ type: 'Text', text: 'STALE  ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tests' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'RUNNING' })).toBeDefined()
    expect(await ui.find({ type: 'Link', text: 'CI' })).toBeDefined()
    await ui.unmount()
  }
})
