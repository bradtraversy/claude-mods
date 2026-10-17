import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf } from 'claude-code'

const PROPS: RenderPropsOf['Pane'] = {
  title: 'Impact Map',
  isFocused: false,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

const EDIT_DIFF = [
  'diff --git a/src/config.ts b/src/config.ts',
  'index 8ac7a21..0fdb31e 100644',
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -1 +1 @@',
  '-export const enabled = false',
  '+export const enabled = true',
  '',
].join('\n')

const DISPLAY_EDIT_DIFF = [
  '--- a/src/config.ts',
  '+++ b/src/config.ts',
  '@@ -1 +1 @@',
  '-export const enabled = false',
  '+export const enabled = true',
  '',
].join('\n')

test('opens current diffs for edited and created files on terminal and desktop', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.read', ($, event) => ({
    value: event.path === '/project/src/new.ts' ? 'export const ready = true\n' : '',
  }))
  on('process.run', ($, event) => {
    const command = event.argv.join(' ')
    const isEditedDiff = command === 'git diff --no-ext-diff --no-color HEAD -- /project/src/config.ts'
    const isCreatedFileCheck = command === 'git ls-files --error-unmatch -- /project/src/new.ts'

    return {
      value: {
        exitCode: isCreatedFileCheck ? 1 : 0,
        stdout: isEditedDiff ? EDIT_DIFF : '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
  on('tool.call', ($, event) => {
    if (event.tool === 'Edit') {
      return {
        result: {
          gitDiff: {
            additions: 3,
            deletions: 1,
          },
        },
      }
    }

    if (event.tool === 'Write') {
      return {
        result: {
          type: 'create',
          gitDiff: {
            additions: 1,
            deletions: 0,
          },
        },
      }
    }

    return { result: 'ok' }
  })

  await $.tool.call({ tool: 'Read', file_path: '/project/README.md' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/project/src/config.ts',
    old_string: 'false',
    new_string: 'true',
  })
  await $.tool.call({
    tool: 'Write',
    file_path: '/project/src/new.ts',
    content: 'export const ready = true\n',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'impact-map',
      surface,
      component: 'Pane',
      requestId: 'impact-map',
      props: PROPS,
    })

    await ui.press({ key: 'impact-filter-all' })

    expect(await ui.find({ type: 'Text', text: '2 changed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 read' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'impact-filter-all' }))?.props)
      .toMatchObject({ label: 'All', variant: 'primary' })
    expect((await ui.find({ type: 'Button', key: 'impact-filter-changed' }))?.props)
      .toMatchObject({ label: 'Changed', variant: 'secondary' })
    expect(await ui.find({ type: 'Text', text: 'Changes' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'R' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '~' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'src/' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Project root' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+4' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'impact-file:/project/src/config.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'impact-file:/project/src/new.ts' })).toBeDefined()

    await ui.press({ key: 'impact-filter-changed' })
    expect((await ui.find({ type: 'Button', key: 'impact-filter-changed' }))?.props.variant)
      .toBe('primary')
    expect(await ui.find({ type: 'Text', text: 'README.md' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'config.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'new.ts' })).toBeDefined()

    await ui.press({ key: 'impact-file:/project/src/config.ts' })
    const editedDiff = await $.ui.mount({
      plugin: 'impact-map',
      surface,
      component: 'Pane',
      requestId: 'impact-map-diff',
      props: { ...PROPS, title: 'Diff: config.ts' },
    })
    expect((await editedDiff.find({ type: 'Code' }))?.props).toMatchObject({
      source: DISPLAY_EDIT_DIFF,
      format: 'diff',
    })
    expect(await editedDiff.find({ type: 'Text', text: '+1 added' })).toBeDefined()
    expect(await editedDiff.find({ type: 'Text', text: '-1 removed' })).toBeDefined()
    await editedDiff.unmount()

    await ui.press({ key: 'impact-file:/project/src/new.ts' })
    const createdDiff = await $.ui.mount({
      plugin: 'impact-map',
      surface,
      component: 'Pane',
      requestId: 'impact-map-diff',
      props: { ...PROPS, title: 'Diff: new.ts' },
    })
    expect((await createdDiff.find({ type: 'Code' }))?.props).toMatchObject({
      source: [
        '--- /dev/null',
        '+++ b/src/new.ts',
        '@@ -0,0 +1,1 @@',
        '+export const ready = true',
      ].join('\n'),
      format: 'diff',
    })
    expect(await createdDiff.find({ type: 'Text', text: '+1 added' })).toBeDefined()
    expect(await createdDiff.find({ type: 'Text', text: '-0 removed' })).toBeDefined()
    await createdDiff.unmount()
    await ui.unmount()
  }
})

test('clears file activity when clear starts a new session', async ($, on) => {
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('session.end', ($, event) => ({ sessionId: event.sessionId }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({ result: 'ok' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.tool.call({ tool: 'Read', file_path: '/project/src/old-session.ts' })

  const ui = await $.ui.mount({
    plugin: 'impact-map',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'impact-map',
    props: PROPS,
  })
  expect(await ui.find({ type: 'Text', text: 'old-session.ts' })).toBeDefined()

  await $.session.end({
    reason: 'clear',
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })
  await ui.redraw(PROPS)

  expect(await ui.find({ type: 'Text', text: 'No files touched yet.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'old-session.ts' })).toBeUndefined()
  await ui.unmount()
})

test('records only successful file tools', async ($, on) => {
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.cwd', () => ({ value: '/project' }))
  on('tool.call', ($, event) => {
    if (event.tool === 'Read') return { deny: 'Read was denied.' }
    if (event.tool === 'Edit') {
      return { isError: true, result: 'The requested text was not found.' }
    }
    if (event.tool === 'Write') return { deny: 'Write was denied.' }
    return { result: 'ok' }
  })

  await $.tool.call({ tool: 'Read', file_path: '/project/src/denied-read.ts' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/project/src/failed-edit.ts',
    old_string: 'missing',
    new_string: 'replacement',
  })
  await $.tool.call({
    tool: 'Write',
    file_path: '/project/src/denied-write.ts',
    content: 'export const value = true\n',
  })

  const ui = await $.ui.mount({
    plugin: 'impact-map',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'impact-map',
    props: PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'No files touched yet.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'denied-read.ts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'failed-edit.ts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'denied-write.ts' })).toBeUndefined()
  await ui.unmount()
})

test('keeps the strongest file action and ignores staged changes', async ($, on) => {
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', ($, event) => {
    if ('file_path' in event && event.file_path === '/project/src/staged.ts') {
      return { result: { staged: true } }
    }
    if (event.tool === 'Write') {
      return {
        result: {
          type: 'create',
          gitDiff: { additions: 1, deletions: 0 },
        },
      }
    }
    if (event.tool === 'Edit') {
      return {
        result: {
          gitDiff: { additions: 2, deletions: 1 },
        },
      }
    }
    return { result: 'ok' }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.tool.call({
    tool: 'Write',
    file_path: '/project/src/new.ts',
    content: 'export const ready = true\n',
  })
  await $.tool.call({ tool: 'Read', file_path: '/project/src/new.ts' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/project/src/new.ts',
    old_string: 'true',
    new_string: 'false',
  })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/project/src/staged.ts',
    old_string: 'true',
    new_string: 'false',
  })

  const ui = await $.ui.mount({
    plugin: 'impact-map',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'impact-map',
    props: PROPS,
  })

  expect(await ui.find({ type: 'Text', text: '1 changed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '0 read' })).toBeDefined()
  expect((await ui.find({ type: 'Button', key: 'impact-filter-all' }))?.props.label).toBe('All')
  expect(await ui.find({ type: 'Text', text: '+' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'staged.ts' })).toBeUndefined()
  await ui.unmount()
})

test('keeps long dashboard content constrained in a narrow pane', async ($, on) => {
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', () => ({
    result: {
      structuredPatch: [{
        lines: [
          '@@ -1 +1 @@',
          '-before',
          '+after',
        ],
      }],
    },
  }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/project' })
  const longPath = '/project/src/features/impact-map/components/VeryLongDashboardComponentName.tsx'
  await $.tool.call({
    tool: 'Edit',
    file_path: longPath,
    old_string: 'before',
    new_string: 'after',
  })

  const ui = await $.ui.mount({
    plugin: 'impact-map',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'impact-map',
    viewport: { columns: 42, rows: 18 },
    props: { ...PROPS, bodyColumns: 42 },
  })

  expect((await ui.find({
    type: 'Text',
    text: 'src/features/impact-map/components/',
  }))?.props.wrap).toBe('truncate-middle')
  expect((await ui.find({
    type: 'Text',
    text: 'VeryLongDashboardComponentName.tsx',
  }))?.props.wrap).toBe('truncate-end')
  expect(await ui.find({ type: 'Text', text: '+1' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '-1' })).toBeDefined()
  const boxes = await ui.findAll({ type: 'Box' })
  expect(boxes.some(box => box.props.overflow === 'hidden')).toBe(true)
  expect(boxes.some(box => box.props.width === '100%')).toBe(false)
  await ui.unmount()
})

test('retains only the 14 most recently used file paths', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('tool.call', () => ({ result: 'ok' }))

  for (let index = 1; index <= 14; index += 1) {
    await $.tool.call({ tool: 'Read', file_path: `/project/src/file-${index}.ts` })
  }
  await $.tool.call({ tool: 'Read', file_path: '/project/src/file-1.ts' })
  await $.tool.call({ tool: 'Read', file_path: '/project/src/file-15.ts' })

  const ui = await $.ui.mount({
    plugin: 'impact-map',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'impact-map',
    props: PROPS,
  })

  expect((await ui.find({ type: 'Button', key: 'impact-filter-all' }))?.props.label).toBe('All')
  expect(await ui.find({ type: 'Text', text: 'file-1.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'file-2.ts' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'file-15.ts' })).toBeDefined()
  await ui.unmount()
})
