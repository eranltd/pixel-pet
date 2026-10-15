import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 160,
  scroll: { bodyRows: 20, offset: 0 },
  view: {},
} as never

const ACTIONS = ['eli5', 'slack', 'done', 'ticket', 'check', 'screens', 'accept', 'babysit', 'remember', 'model', 'plan', 'critique', 'refresh', 'worktrees', 'demo', 'hide']

test('Bit, the cockpit and the cache line draw on terminal and desktop', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pixel-pet', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    expect(await ui.find({ text: /ctx/ })).toBeDefined()
    // No Slack line until a new message arrives.
    expect(await ui.find({ key: 'pet-slack' })).toBeUndefined()
    expect(await ui.find({ text: /^ready$/ })).toBeDefined()

    // One favorite on the band; the rest live in the actions pane.
    expect(JSON.stringify(await ui.find({ key: 'pet-favorite' }))).toContain('ELI5')
    expect(await ui.find({ key: 'pet-actions-open' })).toBeDefined()
    expect(await ui.find({ key: 'pet-skill-check' })).toBeUndefined()

    await ui.press({ key: 'pet-collapse' })
    expect(await ui.find({ key: 'pet-actions' })).toBeUndefined()
    expect(await ui.find({ key: 'handoff' })).toBeDefined()
    await ui.press({ key: 'pet-collapse' })
    await ui.unmount()
  }
})

test('the actions pane lists every action and sets the band favorite', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ plugin: 'pixel-pet', surface, component: 'Pane', requestId: 'bit-actions', props: PROPS })
    for (const id of ACTIONS) {
      expect(await pane.find({ key: `act-${id}` })).toBeDefined()
    }
    expect(JSON.stringify(await pane.find({ key: 'fav-eli5' }))).toContain('★')
    await pane.press({ key: 'fav-done' })
    expect(JSON.stringify(await pane.find({ key: 'fav-done' }))).toContain('★')
    expect(JSON.stringify(await pane.find({ key: 'fav-eli5' }))).toContain('☆')
    await pane.unmount()

    const band = await $.ui.mount({ plugin: 'pixel-pet', surface, component: 'AbovePrompt', props: PROPS })
    expect(JSON.stringify(await band.find({ key: 'pet-favorite' }))).toContain('done')
    await band.unmount()
    const again = await $.ui.mount({ plugin: 'pixel-pet', surface, component: 'Pane', requestId: 'bit-actions', props: PROPS })
    await again.press({ key: 'fav-eli5' })
    await again.unmount()
  }
})
