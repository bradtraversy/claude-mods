import { expect, mock, test } from 'claude-code/testing'
import type { AgentInfo, PaneOpenArgs, RenderPropsOf, SessionMessage } from 'claude-code'

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Agents',
  isFocused: true,
  bodyColumns: 58,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

const RUNNING_AGENT: AgentInfo = {
  id: 'agent-1',
  description: 'Inspect the authentication flow',
  type: 'Explore',
  status: 'running',
  name: 'auth-scout',
}

const COMPLETED_AGENT: AgentInfo = {
  id: 'agent-2',
  description: 'Summarize the changed files',
  type: 'Explore',
  status: 'completed',
  name: 'change-summary',
}

const TRANSCRIPT: SessionMessage[] = [
  {
    role: 'user',
    text: 'Find where authentication state is owned.',
    toolUses: [],
  },
  {
    role: 'assistant',
    text: 'Authentication state is owned by the session store.',
    toolUses: [{
      tool_use_id: 'tool-1',
      tool: 'Read',
      input: { file_path: '/project/src/session.ts' },
      text: 'export const session = createStore()',
    }],
  },
]

test('stays closed while empty and opens from the agent-pulse command', async ($, on) => {
  const opened: PaneOpenArgs[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  expect(opened).toHaveLength(0)

  const result = await $.command.run({
    command: 'agent-pulse',
    args: '',
    origin: { kind: 'composer' },
    presentation: { isFullscreen: true, columns: 120 },
  })
  expect(result.text).toBe('Agent activity pane opened.')
  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'agent-pulse', title: 'Agents', focus: true })

  const ui = await $.ui.mount({
    plugin: 'agent-pulse',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-pulse',
    props: PANE_PROPS,
  })

  expect(await ui.find({ type: 'Text', text: 'No subagents in this session.' })).toBeDefined()
  await ui.unmount()
})

test('opens from the built-in Agent tool result when no agent API event is exposed', async ($, on) => {
  const opened: PaneOpenArgs[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
  on('tool.call', ($, event) => {
    if (event.tool !== 'Agent') return { result: 'ok' }
    return {
      result: [{
        type: 'text',
        text: `Async agent launched successfully.\nagentId: ${RUNNING_AGENT.id} (internal ID)`,
      }],
    }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.tool.call({
    tool: 'Agent',
    description: RUNNING_AGENT.description,
    prompt: 'Inspect the authentication flow.',
    subagent_type: RUNNING_AGENT.type,
    name: RUNNING_AGENT.name,
  })
  await Promise.resolve()

  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'agent-pulse', title: 'Agents' })

  const ui = await $.ui.mount({
    plugin: 'agent-pulse',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-pulse',
    props: PANE_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: RUNNING_AGENT.name })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: RUNNING_AGENT.description })).toBeDefined()
  await ui.unmount()
})

test('discovers an unknown subagent from its first tool call and marks it complete', async ($, on) => {
  const opened: PaneOpenArgs[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('agent.list', () => ({ value: [] }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: 'ok' }))
  on('turn.complete', ($, event) => ({ text: event.answer }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.tool.call({
    tool: 'Read',
    file_path: '/project/README.md',
    agentId: RUNNING_AGENT.id,
  } as never)

  expect(opened).toHaveLength(1)

  const ui = await $.ui.mount({
    plugin: 'agent-pulse',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-pulse',
    props: PANE_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: 'Background agent' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Last used Read' })).toBeDefined()

  await $.turn.complete({
    answer: 'Done',
    agentId: RUNNING_AGENT.id,
    turnId: 'turn-1',
    durationMs: 1_000,
    isAborted: false,
    reason: 'answer',
  })
  await ui.redraw(PANE_PROPS)
  await ui.press({ key: 'toggle-finished' })
  expect(await ui.find({ type: 'Text', text: 'Completed' })).toBeDefined()
  await ui.unmount()
})

test('shows live agent activity and a recent transcript on terminal and desktop', async ($, on) => {
  let agents: AgentInfo[] = []
  const opened: PaneOpenArgs[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', () => {
    agents = [RUNNING_AGENT]
    return { model: 'claude-opus-4-1', agentId: RUNNING_AGENT.id }
  })
  on('session.messages', ($, event) => ({
    value: event.agentId === RUNNING_AGENT.id
      ? TRANSCRIPT
      : { deny: 'Unknown agent' },
  }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
  on('tool.call', () => ({ result: 'ok' }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  await $.agent.spawn({
    tool_use_id: 'agent-tool-1',
    prompt: 'Inspect the authentication flow.',
    description: RUNNING_AGENT.description,
    subagentType: RUNNING_AGENT.type,
    provider: { plugin: 'engine', tier: 'core' },
    name: RUNNING_AGENT.name,
    parentModel: 'claude-opus-4-1',
    background: true,
    fork: false,
  })
  await Promise.resolve()

  expect(opened).toHaveLength(1)
  expect(opened[0]).toMatchObject({ id: 'agent-pulse', title: 'Agents' })
  expect(opened[0]?.focus).toBeUndefined()

  await $.tool.call({
    tool: 'Read',
    file_path: '/project/src/session.ts',
    agentId: RUNNING_AGENT.id,
  } as never)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'agent-pulse',
      surface,
      component: 'Pane',
      requestId: 'agent-pulse',
      props: PANE_PROPS,
    })

    expect(await ui.find({ type: 'Text', text: 'Agent Pulse' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '1 live agent' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '0 finished' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Live agents' })).toBeDefined()
    const liveAgentsSection = await ui.find({ type: 'Box', key: 'live-agents-section' })
    expect(liveAgentsSection?.props.marginTop).toBe(1)
    expect(await ui.find({ type: 'Text', text: 'Running' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: RUNNING_AGENT.name })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: RUNNING_AGENT.description })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Last used Read' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'No finished agents yet.' })).toBeDefined()
    const detailsButton = await ui.find({
      type: 'Button',
      key: `agent-view:${RUNNING_AGENT.id}`,
    })
    expect(detailsButton?.props).toMatchObject({ label: 'Details', variant: 'secondary' })

    await ui.press({ key: `agent-view:${RUNNING_AGENT.id}` })
    await Promise.resolve()
    await ui.redraw(PANE_PROPS)

    expect(await ui.find({ type: 'Text', text: 'Recent transcript' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Find where authentication state is owned.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Authentication state is owned by the session store.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Tools: Read' })).toBeDefined()

    await ui.press({ key: 'agent-back' })
    expect(await ui.find({ type: 'Text', text: 'Agent Pulse' })).toBeDefined()
    await ui.unmount()
  }
})

test('keeps finished agents quiet until the user expands them', async ($, on) => {
  let agents: AgentInfo[] = []

  mock.clock(on)
  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('agent.list', () => ({ value: agents }))
  on('agent.spawn', ($, event) => {
    const agent = event.description === COMPLETED_AGENT.description
      ? COMPLETED_AGENT
      : RUNNING_AGENT
    agents = [...agents, agent]
    return { model: 'claude-opus-4-1', agentId: agent.id }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))

  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/project' })
  for (const agent of [RUNNING_AGENT, COMPLETED_AGENT]) {
    await $.agent.spawn({
      tool_use_id: `tool-${agent.id}`,
      prompt: agent.description,
      description: agent.description,
      subagentType: agent.type,
      provider: { plugin: 'engine', tier: 'core' },
      name: agent.name,
      parentModel: 'claude-opus-4-1',
      background: true,
      fork: false,
    })
  }
  await Promise.resolve()

  const ui = await $.ui.mount({
    plugin: 'agent-pulse',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'agent-pulse',
    props: PANE_PROPS,
  })

  expect(await ui.find({ type: 'Text', text: '1 live agent' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1 finished' })).toBeDefined()
  const finishedSection = await ui.find({ type: 'Box', key: 'finished-section' })
  expect(finishedSection?.props.marginTop).toBe(1)
  expect(await ui.find({ type: 'Button', key: 'toggle-finished' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: COMPLETED_AGENT.name })).toBeUndefined()

  await ui.press({ key: 'toggle-finished' })
  expect(await ui.find({ type: 'Text', text: COMPLETED_AGENT.name })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: COMPLETED_AGENT.description })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Completed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Explore agent' })).toBeDefined()

  await ui.unmount()
})

test('clears agents and keeps polling after clear starts a new session', async ($, on) => {
  let agents: AgentInfo[] = []
  const opened: PaneOpenArgs[] = []
  const clock = mock.clock(on)

  on('session.start', ($, event) => ({ cwd: event.cwd }))
  on('session.end', ($, event) => ({ sessionId: event.sessionId }))
  on('command.register', ($, event) => ({ value: { command: event.name } }))
  on('agent.list', () => ({ value: agents }))
  on('ui.open', ($, event) => {
    opened.push(event)
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: [{
      id: 'agent-pulse',
      title: 'Agents',
      isShown: true,
      isFocused: false,
      isPlaced: true,
    }],
  }))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/project' })
  agents = [RUNNING_AGENT]
  await clock.advance(2_000)
  await Promise.resolve()

  const ui = await $.ui.mount({
    plugin: 'agent-pulse',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'agent-pulse',
    props: PANE_PROPS,
  })
  expect(await ui.find({ type: 'Text', text: RUNNING_AGENT.name })).toBeDefined()

  await $.session.end({
    reason: 'clear',
    sessionId: 'session-1',
    resume: { id: 'session-1' },
  })
  agents = []
  await ui.redraw(PANE_PROPS)
  expect(await ui.find({ type: 'Text', text: 'No subagents in this session.' })).toBeDefined()

  agents = [{ ...RUNNING_AGENT, id: 'agent-2', name: 'new-session-agent' }]
  await clock.advance(2_000)
  await Promise.resolve()
  await ui.redraw(PANE_PROPS)

  expect(await ui.find({ type: 'Text', text: 'new-session-agent' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: RUNNING_AGENT.name })).toBeUndefined()
  expect(opened).toHaveLength(2)
  await ui.unmount()
})
