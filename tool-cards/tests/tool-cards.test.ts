import { expect, test } from 'claude-code/testing'
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
