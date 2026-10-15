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

test('shows files read and edited on terminal and desktop', async ($, on) => {
  on('tool.call', () => ({ result: 'ok' }))

  await $.tool.call({ tool: 'Read', file_path: '/project/src/app.ts' })
  await $.tool.call({
    tool: 'Edit',
    file_path: '/project/src/config.ts',
    old_string: 'false',
    new_string: 'true',
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'impact-map',
      surface,
      component: 'Pane',
      requestId: 'impact-map',
      props: PROPS,
    })

    expect(await ui.find({ type: 'Text', text: 'READ   ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/project/src/app.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'EDITED ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '/project/src/config.ts' })).toBeDefined()
    await ui.unmount()
  }
})
