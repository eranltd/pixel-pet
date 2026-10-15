import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 30,
  bodyColumns: 160,
  scroll: { bodyRows: 30, offset: 0 },
  view: {},
} as never

test('/bit slack test takes over the Slack line', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  const commands: string[] = []
  on('process.run', (_$, e) => {
    commands.push(JSON.stringify(e))
    return { exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false }
  })
  const ran = await $.command.run({ command: 'bit', args: 'slack test' })
  expect(JSON.stringify(ran)).toContain('test Slack message shown')
  // A new Slack message shows in the band only, never as an OS notification.
  expect(commands.filter(c => c.includes('osascript') || c.includes('notify-send'))).toEqual([])
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pixel-pet', surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ key: 'pet-slack' })).toBeDefined()
    expect(await ui.find({ key: 'pet-slack-flash' })).toBeDefined()
    await ui.unmount()
  }
})
