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
    if (surface === 'desktop') {
      const badges = await ui.find({ type: 'Svg' })
      expect(badges?.props.alt).toBe('1 active, 0 finished')
    } else {
      expect(await ui.find({ type: 'Box', key: 'active-count' })).toBeDefined()
      expect(await ui.find({ type: 'Box', key: 'finished-count' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '1 active' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '0 finished' })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: 'RUNNING' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: RUNNING_AGENT.name })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Last tool: Read' })).toBeDefined()

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
