import { expect, mock, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const PROPS: RenderPropsOf['ToolUse'] = {
  tool_use_id: 'tool-1',
  tool: 'Read',
  input: { file_path: '/project/src/app.ts' },
  isRunning: false,
  isErrored: false,
  isInterrupted: false,
  output: { text: 'contents' },
}

test('renders a completed tool card on terminal and desktop', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'tool-cards',
      surface,
      component: 'ToolUse',
      requestId: 'tool-1',
      props: PROPS,
    })

    expect(await ui.find({ type: 'Text', text: 'DONE   ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/project/src/app.ts' })).toBeDefined()
    await ui.unmount()
  }
})

test('constrains long targets inside the card', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'tool-cards',
      surface,
      component: 'ToolUse',
      requestId: `tool-long-target-${surface}`,
      viewport: { columns: 48, rows: 12 },
      props: {
        ...PROPS,
        tool_use_id: `tool-long-target-${surface}`,
        input: {
          file_path: '/home/user/.claude/projects/a-very-long-project-name/session-logs/2026-10-17.jsonl',
        },
      },
    })

    expect((await ui.find({
      type: 'Text',
      text: '/home/user/.claude/projects/a-very-long-project-name/session-logs/2026-10-17.jsonl',
    }))?.props.wrap).toBe('truncate-middle')
    expect(await ui.drawn()).toMatchObject({
      type: 'Box',
      props: {
        flexDirection: 'column',
        overflow: 'hidden',
      },
    })
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.some(box => box.props.flexWrap === 'wrap')).toBe(true)
    expect(boxes.some(box => box.props.width === '100%')).toBe(false)
    await ui.unmount()
  }
})

test('keeps grouped tool cards expanded', async ($, on) => {
  let observedExpanded = false

  on('ui.render', { component: 'ToolGroup' }, ($, event) => {
    observedExpanded = event.props.isExpanded
    return { type: 'Text', children: ['group'] }
  })

  const ui = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'desktop',
    component: 'ToolGroup',
    requestId: 'tool-group-1',
    props: {
      calls: [{
        tool_use_id: 'tool-group-read-1',
        tool: 'Read',
        input: { file_path: '/project/README.md' },
        isRunning: false,
        isErrored: false,
        isInterrupted: false,
        output: { text: 'contents' },
      }],
      isActive: false,
      isExpanded: false,
    },
  })

  expect(observedExpanded).toBe(true)
  await ui.unmount()
})

test('uses distinct colors for every tool state', async $ => {
  const states = [
    { label: 'RUNNING', color: 'warning', isRunning: true, isErrored: false, isInterrupted: false },
    { label: 'DONE   ', color: 'success', isRunning: false, isErrored: false, isInterrupted: false },
    { label: 'FAILED ', color: 'error', isRunning: false, isErrored: true, isInterrupted: false },
    { label: 'STOPPED', color: 'inactive', isRunning: false, isErrored: false, isInterrupted: true },
  ] as const

  for (const surface of ['terminal', 'desktop'] as const) {
    for (const state of states) {
      const ui = await $.ui.mount({
        plugin: 'tool-cards',
        surface,
        component: 'ToolUse',
        requestId: `tool-${state.label.trim().toLowerCase()}`,
        props: {
          ...PROPS,
          isRunning: state.isRunning,
          isErrored: state.isErrored,
          isInterrupted: state.isInterrupted,
        },
      })

      expect((await ui.find({ type: 'Text', text: state.label }))?.props).toMatchObject({
        color: state.color,
      })
      await ui.unmount()
    }
  }
})

test('shows useful result summaries and expandable details', async $ => {
  const editPatch = [
    '--- a/src/app.ts',
    '+++ b/src/app.ts',
    '@@ -1 +1,3 @@',
    '-export const ready = false',
    '+export const ready = true',
    '+export const checked = true',
    '+export const shipped = true',
  ].join('\n')

  for (const surface of ['terminal', 'desktop'] as const) {
    const editId = `tool-edit-${surface}`
    const edit = await $.ui.mount({
      plugin: 'tool-cards',
      surface,
      component: 'ToolUse',
      requestId: editId,
      props: {
        ...PROPS,
        tool_use_id: editId,
        tool: 'Edit',
        input: {
          file_path: '/project/src/app.ts',
          old_string: 'false',
          new_string: 'true',
        },
        output: {
          filePath: '/project/src/app.ts',
          gitDiff: {
            filename: 'src/app.ts',
            additions: 3,
            deletions: 1,
            changes: 4,
            patch: editPatch,
          },
        },
      },
    })

    expect(await edit.find({ type: 'Text', text: '~' })).toBeDefined()
    expect(await edit.find({ type: 'Text', text: '+3 -1' })).toBeDefined()
    expect((await edit.find({
      type: 'Button',
      key: `tool-card-details:${editId}`,
    }))?.props).toMatchObject({
      label: 'Details',
      variant: 'secondary',
    })
    const header = (await edit.findAll({ type: 'Box' }))
      .find(box => box.props.justifyContent === 'space-between')
    expect(header?.props.width).toBeUndefined()
    expect(await edit.find({ type: 'Code' })).toBeUndefined()

    await edit.press({ key: `tool-card-details:${editId}` })
    expect((await edit.find({ type: 'Code' }))?.props).toMatchObject({
      source: editPatch,
      format: 'diff',
      path: 'src/app.ts',
    })
    await edit.unmount()

    const failedId = `tool-failed-${surface}`
    const failed = await $.ui.mount({
      plugin: 'tool-cards',
      surface,
      component: 'ToolUse',
      requestId: failedId,
      props: {
        ...PROPS,
        tool_use_id: failedId,
        tool: 'Bash',
        input: { command: 'npm test', description: 'Run the test suite' },
        isErrored: true,
        output: {
          stdout: '12 tests passed\n1 test failed\n',
          stderr: 'AssertionError: expected true\n',
          interrupted: false,
        },
      },
    })

    expect(await failed.find({ type: 'Text', text: '>' })).toBeDefined()
    expect(await failed.find({ type: 'Text', text: 'Run the test suite' })).toBeDefined()
    expect(await failed.find({ type: 'Text', text: '3 output lines' })).toBeDefined()
    expect((await failed.find({ type: 'Code' }))?.props.source).toContain('AssertionError')
    expect((await failed.find({ type: 'Button', key: `tool-card-details:${failedId}` }))?.props.label)
      .toBe('Hide')
    await failed.unmount()
  }
})

test('tracks elapsed time while a tool is running', async ($, on) => {
  const clock = mock.clock(on)
  let releaseTool!: () => void
  let markStarted!: () => void
  const toolStarted = new Promise<void>(resolve => {
    markStarted = resolve
  })
  const toolReleased = new Promise<void>(resolve => {
    releaseTool = resolve
  })

  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('tool.call', async () => {
    markStarted()
    await toolReleased
    return { result: { stdout: 'done', stderr: '', interrupted: false } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  const pendingTool = $.tool.call({
    tool: 'Bash',
    tool_use_id: 'tool-timed',
    command: 'npm test',
  } as never)
  await toolStarted
  await clock.advance(2_000)

  const ui = await $.ui.mount({
    plugin: 'tool-cards',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'tool-timed',
    props: {
      ...PROPS,
      tool_use_id: 'tool-timed',
      tool: 'Bash',
      input: { command: 'npm test' },
      isRunning: true,
      output: undefined,
    },
  })

  expect(await ui.find({ type: 'Text', text: '2s' })).toBeDefined()
  releaseTool()
  await pendingTool
  await ui.unmount()
})
