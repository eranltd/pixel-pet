import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 30,
  bodyColumns: 200,
  scroll: { bodyRows: 30, offset: 0 },
  view: {},
} as never

const NOW = 1_800_000_000_000

test('/bit demo fills the band with made-up sessions, Slack and a plan, and hides the real ones', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/tester' })
  const dir = '/home/tester/.claude/plan-progress/sessions'
  const files: Record<string, string> = {
    'real.json': JSON.stringify({ sessionId: 'real', project: 'core', title: 'a real session title', goal: null, phase: null, done: 0, total: 0, startedAt: null, endedAt: null, updatedAt: NOW, isRunning: true, needsYou: null }),
  }
  on('fs.exists', (_$, e) => ({ value: e.path === dir }))
  on('fs.write', (_$, e) => {
    files[String(e.path).split("/").at(-1) ?? ""] = String(e.text)
    return { value: undefined }
  })
  on('fs.list', (_$, e) => ({
    value: e.path === dir ? Object.keys(files).map(name => ({ name, kind: 'file' as const, size: 100, mtimeMs: NOW, isLink: false })) : [],
  }))
  on('fs.read', (_$, e) => ({ value: files[String(e.path).split('/').at(-1) ?? ''] ?? '' }))
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'rm') {
      for (const path of e.argv.slice(2)) delete files[String(path).split('/').at(-1) ?? '']
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    return { value: { exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: false } }))

  await $.command.run({ command: 'bit', args: 'demo' })
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'ss-demo-band-2' })).toBeDefined()
  expect(await ui.find({ key: 'ss-real' })).toBeUndefined()
  expect(await ui.find({ text: /Dana Levi/ })).toBeDefined()
  expect(await ui.find({ text: /PET-42/ })).toBeDefined()
  expect(await ui.find({ text: /^2\/5$/ })).toBeDefined()
  await ui.unmount()

  await $.command.run({ command: 'bit', args: 'demo off' })
  await clock.advance(0)
  const after = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await after.find({ key: 'ss-demo-band-2' })).toBeUndefined()
  expect(await after.find({ key: 'ss-real' })).toBeDefined()
  expect(await after.find({ text: /Dana Levi/ })).toBeUndefined()
  await after.unmount()
})
