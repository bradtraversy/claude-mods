import { expect, mock, test } from 'claude-code/testing'
import type { PaneOpenArgs, RenderPropsOf } from 'claude-code'

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Tasks',
  isFocused: true,
  bodyColumns: 58,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 32 },
  view: {},
}

test('stays closed while empty and opens from the work-queue command', async ($, on) => {
  const opened: PaneOpenArgs[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  expect(opened).toHaveLength(0)

  const result = await $.command.run({
    command: 'work-queue',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })

  expect(result.text).toBe('Work queue opened.')
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'work-queue', title: 'Tasks', focus: true })

  const ui = await $.ui.mount({
    plugin: 'work-queue',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'work-queue',
    props: PANE_PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'No tasks in this session.' })).toBeDefined()
  await ui.unmount()
})

test('groups task tool activity and opens dependency details on terminal and desktop', async ($, on) => {
  const opened: PaneOpenArgs[] = []
  const clock = mock.clock(on)
  let nextTaskId = 1

  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [{
      id: 'work-queue',
      title: 'Tasks',
      isShown: true,
      isFocused: false,
      isPlaced: true,
    }],
  }))
  on('tool.call', ($, event) => {
    if (event.tool === 'TaskCreate') {
      return {
        result: {
          task: { id: String(nextTaskId++), subject: event.subject },
        },
      }
    }

    if (event.tool === 'TaskUpdate') {
      return {
        result: {
          success: true,
          taskId: event.taskId,
          updatedFields: [],
        },
      }
    }

    return { result: 'ok' }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })

  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Build the API',
    description: 'Implement the endpoint and response contract.',
    activeForm: 'Building the API',
  })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Connect the interface',
    description: 'Use the new endpoint from the interface.',
    activeForm: 'Connecting the interface',
  })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Write the documentation',
    description: 'Document the new workflow.',
    activeForm: 'Writing the documentation',
  })
  await $.tool.call({
    tool: 'TaskCreate',
    subject: 'Confirm the scope',
    description: 'Review the agreed feature boundary.',
    activeForm: 'Confirming the scope',
  })
  await $.tool.call({
    tool: 'TaskUpdate',
    taskId: '1',
    status: 'in_progress',
    owner: 'api-agent',
    addBlocks: ['2'],
  })
  await $.tool.call({
    tool: 'TaskUpdate',
    taskId: '4',
    status: 'completed',
  })
  await clock.advance(65_000)

  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'work-queue', title: 'Tasks' })
  expect(opened[0]?.focus).toBeUndefined()

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'work-queue',
      surface,
      component: 'Pane',
      requestId: 'work-queue',
      props: PANE_PROPS,
    })

    expect(await ui.find({ type: 'Text', text: 'Work Queue' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '3 open  1 done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Blocked' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ready' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Build the API' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'api-agent' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1m' })).toBeDefined()

    await ui.press({ key: 'task-view:2' })
    expect(await ui.find({ type: 'Text', text: 'Connect the interface' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Blocked by' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'dependency:1' })).toBeDefined()

    await ui.press({ key: 'dependency:1' })
    expect(await ui.find({ type: 'Text', text: 'Build the API' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Blocks' })).toBeDefined()

    await ui.press({ key: 'work-back' })
    expect(await ui.find({ type: 'Text', text: 'Work Queue' })).toBeDefined()
    await ui.unmount()
  }
})

test('captures classic task events that do not pass through task tools', async ($, on) => {
  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('classic.TaskCreated', () => ({}))
  on('classic.TaskCompleted', () => ({}))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.classic.TaskCreated({
    task_id: 'external-1',
    task_subject: 'Review the implementation',
    task_description: 'Check the finished task from another process.',
    teammate_name: 'reviewer',
  })
  await $.classic.TaskCompleted({
    task_id: 'external-1',
    task_subject: 'Review the implementation',
    task_description: 'Check the finished task from another process.',
    teammate_name: 'reviewer',
  })

  const ui = await $.ui.mount({
    plugin: 'work-queue',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'work-queue',
    props: PANE_PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Review the implementation' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'reviewer' })).toBeDefined()
  await ui.unmount()
})

test('hydrates task lists and task details returned by Claude tools', async ($, on) => {
  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('tool.call', ($, event) => {
    if (event.tool === 'TaskList') {
      return {
        result: {
          tasks: [
            {
              id: '10',
              subject: 'Connect the client',
              status: 'pending',
              owner: 'ui-agent',
              blockedBy: ['11'],
            },
            {
              id: '11',
              subject: 'Finish the endpoint',
              status: 'in_progress',
              owner: 'api-agent',
              blockedBy: [],
            },
          ],
        },
      }
    }

    if (event.tool === 'TaskGet') {
      return {
        result: {
          task: {
            id: '10',
            subject: 'Connect the client',
            description: 'Connect the interface after the endpoint is ready.',
            status: 'pending',
            blocks: [],
            blockedBy: ['11'],
          },
        },
      }
    }

    return { result: 'ok' }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.tool.call({ tool: 'TaskList' })
  await $.tool.call({ tool: 'TaskGet', taskId: '10' })

  const ui = await $.ui.mount({
    plugin: 'work-queue',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'work-queue',
    props: PANE_PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Blocked' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'ui-agent  1 blocker' })).toBeDefined()

  await ui.press({ key: 'task-view:10' })
  expect(await ui.find({
    type: 'Text',
    text: 'Connect the interface after the endpoint is ready.',
  })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'dependency:11' })).toBeDefined()
  await ui.unmount()
})
