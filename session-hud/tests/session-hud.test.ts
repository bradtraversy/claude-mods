import { expect, test } from 'claude-code/testing'
import type { RenderPropsOf, SessionUsage } from 'claude-code'

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

test('shows usage against the configured context maximum on terminal and desktop', async ($, on) => {
  on('session.usage', () => ({ value: USAGE }))

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'session-hud',
      surface,
      component: 'AbovePrompt',
      props: PROPS,
    })

    expect(await ui.find({ type: 'Text', text: 'Context 17% of 300k' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '$1.24' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '5h 37%' })).toBeDefined()
    await ui.unmount()
  }
})
