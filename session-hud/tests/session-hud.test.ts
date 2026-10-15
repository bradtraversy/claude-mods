import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf, SessionContextBreakdown, SessionUsage } from 'claude-code'

const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 6,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 6 },
  view: {},
}

const USAGE: SessionUsage = {
  startedAt: 0,
  context: { tokens: 52_000, window: 200_000, percent: 26 },
  rateLimits: [{ kind: 'five_hour', percentUsed: 37 }],
  cost: { usd: 1.24 },
}

const BREAKDOWN: SessionContextBreakdown = {
  categories: [
    { name: 'System prompt', tokens: 8_000, color: 'accent', isDeferred: false, kind: 'used' },
    { name: 'MCP tools', tokens: 4_000, color: 'accent', isDeferred: false, kind: 'used' },
    { name: 'Messages', tokens: 40_000, color: 'accent', isDeferred: false, kind: 'used' },
    { name: 'Free space', tokens: 138_000, color: 'inactive', isDeferred: false, kind: 'free' },
    { name: 'Autocompact buffer', tokens: 10_000, color: 'warning', isDeferred: false, kind: 'buffer' },
  ],
  totalTokens: 52_000,
  maxTokens: 200_000,
  rawMaxTokens: 200_000,
  autocompactSource: 'auto',
  percentage: 26,
  gridRows: [],
  model: 'Opus',
  memoryFiles: [{ path: '/project/CLAUDE.md', type: 'Project', tokens: 1_200 }],
  mcpTools: Array.from({ length: 15 }, (_, index) => ({
    name: `mcp__linear__tool_${String(index + 1).padStart(2, '0')}`,
    serverName: 'linear',
    tokens: 900 - index,
    isLoaded: index < 12,
  })),
  agents: [],
  slashCommands: { totalCommands: 20, includedCommands: 10, tokens: 800 },
  skills: {
    totalSkills: 4,
    includedSkills: 3,
    tokens: 600,
    skillFrontmatter: [{ name: 'review', source: 'plugin', pluginName: 'tools', tokens: 200 }],
  },
  isAutoCompactEnabled: true,
  autoCompactThreshold: 190_000,
  apiUsage: null,
}

const PANE_PROPS: RenderPropsOf['Pane'] = {
  title: 'Context',
  isFocused: true,
  bodyColumns: 60,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 30 },
  view: {},
}

test('shows usage against the configured context maximum on terminal and desktop', async ($, on) => {
  let contextTokens = 52_000

  on('session.usage', () => ({
    value: {
      ...USAGE,
      context: { ...USAGE.context, tokens: contextTokens, breakdown: BREAKDOWN },
    },
  }))
  on('ui.open', () => ({ value: { isPlaced: true } }))

  for (const surface of ['terminal', 'desktop'] as const) {
    contextTokens = 52_000
    const ui = await $.ui.mount({
      plugin: 'session-hud',
      surface,
      component: 'AbovePrompt',
      props: PROPS,
    })

    expect(await ui.find({ type: 'Text', text: 'Context 17% of 300k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.24' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h 37%' })).toBeDefined()
    const meter = await ui.find({ type: 'Text', text: /^█/ })
    expect(meter?.props.color).toBe('success')
    expect(await ui.find({ type: 'Button', key: 'context-details' })).toBeDefined()

    contextTokens = 225_000
    await ui.redraw(PROPS)
    expect((await ui.find({ type: 'Text', text: /^█/ }))?.props.color).toBe('warning')

    contextTokens = 285_000
    await ui.redraw(PROPS)
    expect((await ui.find({ type: 'Text', text: /^█/ }))?.props.color).toBe('error')

    await ui.press({ key: 'context-details' })

    const pane = await $.ui.mount({
      plugin: 'session-hud',
      surface,
      component: 'Pane',
      requestId: 'context-breakdown',
      props: PANE_PROPS,
    })

    expect(await pane.find({ type: 'Text', text: 'Context Breakdown' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'Messages' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'linear' })).toBeDefined()
    expect(await pane.find({ type: 'Select', key: 'mcp-server-select' })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: 'tool 01' })).toBeUndefined()

    await pane.select({ key: 'mcp-server-select', value: 'linear' })
    const firstTool = await pane.find({ type: 'Text', text: 'tool 01' })
    if (!firstTool) throw new Error('The first MCP tool was not rendered')
    expect(await pane.find({ type: 'Text', text: 'tool 15' })).toBeUndefined()

    await pane.press({ key: 'mcp-next' })
    const lastTool = await pane.find({ type: 'Text', text: 'tool 15' })
    if (!lastTool) throw new Error('The second MCP tool page was not rendered')
    expect(await pane.find({ type: 'Text', text: /Per-message counts are not available/ })).toBeDefined()
    await pane.unmount()
    await ui.unmount()
  }
})
