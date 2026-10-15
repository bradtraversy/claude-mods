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
  on('tool.call', () => ({ result: 'ok' }))

  await $.tool.call({ tool: 'Read', file_path: '/project/src/app.ts' })
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

    expect(await ui.find({ type: 'Text', text: 'READ   ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'app.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'EDITED ' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'project/src/' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'impact-file:/project/src/config.ts' })).toBeDefined()
    expect(await ui.find({ type: 'Button', key: 'impact-file:/project/src/new.ts' })).toBeDefined()

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
