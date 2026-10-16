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
  const registeredTools: string[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('tool.register', ($, event) => {
    registeredTools.push(event.name)
    return { value: { tool: `mcp__work-queue__${event.name}` } }
  })
  on('prompt.compose', () => ({ sections: [] }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  expect(opened).toHaveLength(0)
  expect(registeredTools).toEqual(['task_create', 'task_update', 'task_list', 'task_clear'])

  const prompt = await $.prompt.compose({
    model: 'claude-opus-5-5',
    promptModel: 'claude-opus-5-5',
    surfaces: ['terminal'],
    tools: [],
    outputStyle: null,
    traits: [],
  })
  expect(prompt.sections.some(section => section.id === 'work-queue:workflow')).toBe(true)
  expect(prompt.sections.find(section => section.id === 'work-queue:workflow')?.text)
    .toContain('task_clear')

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

test('clears every task through the model-callable tool and resets task ids', async ($, on) => {
  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('tool.register', ($, event) => ({ value: { tool: `mcp__work-queue__${event.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/project' })
  await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Build the API',
  })
  await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Connect the interface',
    blockedBy: ['queue-1'],
  })

  const cleared = await $.tool.call({ tool: 'mcp__work-queue__task_clear' })
  expect(JSON.parse(String(cleared.result))).toEqual({ cleared: 2 })

  const listed = await $.tool.call({ tool: 'mcp__work-queue__task_list' })
  expect(JSON.parse(String(listed.result))).toEqual({ tasks: [] })

  const ui = await $.ui.mount({
    plugin: 'work-queue',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'work-queue',
    props: PANE_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: 'No tasks in this session.' })).toBeDefined()
  await ui.unmount()

  const created = await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Start a new plan',
  })
  expect(JSON.parse(String(created.result))).toMatchObject({ task: { id: 'queue-1' } })
})

test('groups portable queue tools and opens dependency details on terminal and desktop', async ($, on) => {
  const opened: PaneOpenArgs[] = []
  const clock = mock.clock(on)

  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('tool.register', ($, event) => ({ value: { tool: `mcp__work-queue__${event.name}` } }))
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

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })

  const created = await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Build the API',
    description: 'Implement the endpoint and response contract.',
    activeForm: 'Building the API',
  })
  const createdResult = JSON.parse(String(created.result)) as { task: { id: string } }
  expect(createdResult.task.id).toBe('queue-1')
  await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Connect the interface',
    description: 'Use the new endpoint from the interface.',
    activeForm: 'Connecting the interface',
    blockedBy: ['queue-1'],
  })
  await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Write the documentation',
    description: 'Document the new workflow.',
    activeForm: 'Writing the documentation',
  })
  await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Confirm the scope',
    description: 'Review the agreed feature boundary.',
    activeForm: 'Confirming the scope',
  })
  await $.tool.call({
    tool: 'mcp__work-queue__task_update',
    taskId: 'queue-1',
    status: 'in_progress',
    owner: 'api-agent',
  })
  await $.tool.call({
    tool: 'mcp__work-queue__task_update',
    taskId: 'queue-4',
    status: 'completed',
  })
  const listed = await $.tool.call({ tool: 'mcp__work-queue__task_list' })
  const listedResult = JSON.parse(String(listed.result)) as {
    tasks: Array<{ source: string; editable: boolean }>
  }
  expect(listedResult.tasks).toHaveLength(4)
  expect(listedResult.tasks.every(task => task.source === 'work_queue' && task.editable)).toBe(true)
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
    expect(await ui.find({ type: 'Text', text: '3 open' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'toggle-completed' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Working' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Blocked' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Ready' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Build the API' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'api-agent' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1m' })).toBeDefined()

    await ui.press({ key: 'toggle-completed' })
    expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Confirm the scope' })).toBeDefined()
    await ui.press({ key: 'toggle-completed' })

    await ui.press({ key: 'task-view:queue-2' })
    expect(await ui.find({ type: 'Text', text: 'Connect the interface' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Blocked by' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'dependency:queue-1' })).toBeDefined()

    await ui.press({ key: 'dependency:queue-1' })
    expect(await ui.find({ type: 'Text', text: 'Build the API' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Blocks' })).toBeDefined()

    await ui.press({ key: 'work-back' })
    expect(await ui.find({ type: 'Text', text: 'Work Queue' })).toBeDefined()
    await ui.unmount()
  }

  await $.tool.call({
    tool: 'mcp__work-queue__task_update',
    taskId: 'queue-1',
    status: 'completed',
  })
  const unblocked = await $.tool.call({ tool: 'mcp__work-queue__task_list' })
  const unblockedResult = JSON.parse(String(unblocked.result)) as {
    tasks: Array<{ id: string; group: string }>
  }
  expect(unblockedResult.tasks.find(task => task.id === 'queue-2')).toMatchObject({ group: 'Ready' })
})

test('captures classic task events that do not pass through task tools', async ($, on) => {
  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('tool.register', ($, event) => ({ value: { tool: `mcp__work-queue__${event.name}` } }))
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

  await ui.press({ key: 'toggle-completed' })
  expect(await ui.find({ type: 'Text', text: 'Done' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Review the implementation' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'reviewer' })).toBeDefined()
  await ui.unmount()
})

test('hydrates task lists and task details returned by Claude tools', async ($, on) => {
  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('tool.register', ($, event) => ({ value: { tool: `mcp__work-queue__${event.name}` } }))
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

  const listed = await $.tool.call({ tool: 'mcp__work-queue__task_list' })
  const listedResult = JSON.parse(String(listed.result)) as {
    tasks: Array<{ id: string; source: string; editable: boolean }>
  }
  expect(listedResult.tasks.find(task => task.id === '10')).toMatchObject({
    source: 'claude',
    editable: false,
  })

  const denied = await $.tool.call({
    tool: 'mcp__work-queue__task_update',
    taskId: '10',
    status: 'completed',
  })
  expect(denied.deny).toBe("Task 10 is managed by Claude's native task tools. Use TaskUpdate instead.")

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

test('rejects unknown blockers without creating phantom tasks', async ($, on) => {
  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('tool.register', ($, event) => ({ value: { tool: `mcp__work-queue__${event.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/project' })

  const rejectedCreate = await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Blocked task',
    blockedBy: ['missing'],
  })
  expect(rejectedCreate.deny).toBe('Blocking task missing was not found.')

  const emptyList = await $.tool.call({ tool: 'mcp__work-queue__task_list' })
  expect(JSON.parse(String(emptyList.result))).toMatchObject({ tasks: [] })

  await $.tool.call({
    tool: 'mcp__work-queue__task_create',
    subject: 'Existing task',
  })
  const rejectedUpdate = await $.tool.call({
    tool: 'mcp__work-queue__task_update',
    taskId: 'queue-1',
    subject: 'Should not be applied',
    blockedBy: ['missing'],
  })
  expect(rejectedUpdate.deny).toBe('Blocking task missing was not found.')

  const finalList = await $.tool.call({ tool: 'mcp__work-queue__task_list' })
  const finalResult = JSON.parse(String(finalList.result)) as {
    tasks: Array<{ subject: string; blockedBy: string[] }>
  }
  expect(finalResult.tasks).toHaveLength(1)
  expect(finalResult.tasks[0]).toMatchObject({ subject: 'Existing task', blockedBy: [] })
})
