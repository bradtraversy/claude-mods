import { expect, mock, test } from 'claude-code/testing'
import type { PaneOpenArgs, RenderPropsOf } from 'claude-code'

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
  const opened: PaneOpenArgs[] = []

  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
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
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'verification-ledger', title: 'Checks' })
  expect(opened[0]?.focus).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'touch src/app.ts' })
  expect(opened).toHaveLength(1)

  await $.command.run({
    command: 'checks',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 160 },
  })
  expect(opened).toHaveLength(2)
  expect(opened[1]).toMatchObject({ id: 'verification-ledger', focus: true })

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

test('clears checks and auto-opens again after clear starts a new session', async ($, on) => {
  const opened: PaneOpenArgs[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('session.end', ($, event) => ({ sessionId: event.sessionId }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('session.cwd', () => ({ value: '/project' }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
  on('process.run', ($, event) => {
    const command = event.argv.join(' ')
    let stdout = ''

    if (command === 'git rev-parse --show-toplevel') stdout = '/project'
    if (command === 'git branch --show-current') stdout = 'feature/checks'
    if (command === 'git rev-parse HEAD') stdout = 'abcdef1234567890'
    if (command === 'git rev-parse --short HEAD') stdout = 'abcdef1'

    return {
      value: {
        exitCode: command === 'git rev-parse --verify @{upstream}' ? 1 : 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', () => ({
    result: { stdout: 'passed', stderr: '', interrupted: false },
  }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.tool.call({ tool: 'Bash', command: 'npm test' })

  const ui = await $.ui.mount({
    plugin: 'verification-ledger',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'verification-ledger',
    props: PROPS,
  })
  expect(await ui.find({ type: 'Text', text: 'Tests' })).toBeDefined()

  await $.session.end({
    reason: 'clear',
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })
  await ui.redraw(PROPS)

  expect(await ui.find({
    type: 'Text',
    text: 'No verification commands recorded this session.',
  })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Tests' })).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'npm test' })
  expect(opened).toHaveLength(2)
  expect(await ui.find({ type: 'Text', text: 'Tests' })).toBeDefined()
  await ui.unmount()
})

test('ignores a check that finishes while the session resumes elsewhere', async ($, on) => {
  const opened: PaneOpenArgs[] = []
  let blockGit = false
  let releaseGit = (): void => {}
  let reportBlocked = (): void => {}
  const gitGate = new Promise<void>(resolve => { releaseGit = resolve })
  const gitBlocked = new Promise<void>(resolve => { reportBlocked = resolve })

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('session.end', ($, event) => ({ sessionId: event.sessionId }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('session.cwd', () => ({ value: '/project' }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
  on('process.run', async ($, event) => {
    const command = event.argv.join(' ')
    if (blockGit && command === 'git rev-parse --show-toplevel') {
      reportBlocked()
      await gitGate
    }

    let stdout = ''
    if (command === 'git rev-parse --show-toplevel') stdout = '/project'
    if (command === 'git branch --show-current') stdout = 'feature/checks'
    if (command === 'git rev-parse HEAD') stdout = 'abcdef1234567890'
    if (command === 'git rev-parse --short HEAD') stdout = 'abcdef1'

    return {
      value: {
        exitCode: command === 'git rev-parse --verify @{upstream}' ? 1 : 0,
        stdout,
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', () => ({
    result: { stdout: 'passed', stderr: '', interrupted: false },
  }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  blockGit = true
  const pendingCheck = $.tool.call({ tool: 'Bash', command: 'npm test' })
  await gitBlocked

  await $.session.end({
    reason: 'resume',
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })
  releaseGit()
  await pendingCheck

  const ui = await $.ui.mount({
    plugin: 'verification-ledger',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'verification-ledger',
    props: PROPS,
  })
  expect(await ui.find({
    type: 'Text',
    text: 'No verification commands recorded this session.',
  })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Tests' })).toBeUndefined()
  expect(opened).toHaveLength(0)
  await ui.unmount()
})
