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
