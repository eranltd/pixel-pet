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

test('the desktop task list fills the plan', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('tool.call', () => ({ result: {}, text: 'Plan shown (3 steps).' }))
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Read the code', status: 'completed' },
      { content: 'Change it', status: 'in_progress' },
      { content: 'Test it', status: 'pending' },
    ],
    scope: 'first_task',
  } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true } as never)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'pet-plan-line' })).toBeDefined()
  expect(await ui.find({ text: /^2\/3$/ })).toBeDefined()
  // The plan draws beside Bit: the phases and every task row, the open one bold.
  expect(await ui.find({ key: 'pet-phases' })).toBeDefined()
  expect(await ui.find({ key: 'pet-tasks' })).toBeDefined()
  expect(await ui.find({ text: /^Test it$/ })).toBeDefined()
  await ui.unmount()
})

test('other sessions draw in the band even without a task list', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/tester' })
  const dir = '/home/tester/.claude/plan-progress/sessions'
  const snapshots: Record<string, string> = {
    'waiting.json': JSON.stringify({ sessionId: 'waiting', project: 'mobile', goal: null, phase: null, done: 0, total: 0, startedAt: null, endedAt: null, updatedAt: NOW, isRunning: false, needsYou: 'permission', hostSessionId: 'local_waiting-host' }),
    'busy.json': JSON.stringify({ sessionId: 'busy', project: 'core', title: 'PET-17 OTP on login', goal: 'fix the OTP retry loop', task: 'Running the OTP tests', phase: 'building', done: 2, total: 5, startedAt: NOW, endedAt: null, updatedAt: NOW, isRunning: true, needsYou: null }),
    'idle.json': JSON.stringify({ sessionId: 'idle', project: 'config', goal: 'bump the quiz rollout to 50%', phase: null, done: 0, total: 0, startedAt: null, endedAt: null, updatedAt: NOW, isRunning: false, needsYou: null }),
    'merged.json': JSON.stringify({ sessionId: 'merged', project: 'infra', goal: 'park the old pods', phase: null, done: 3, total: 3, startedAt: NOW, endedAt: NOW, updatedAt: NOW, isRunning: false, needsYou: null, pr: { key: 'infra#4546', url: 'https://github.com/example/infra/pull/4546', isMerged: true } }),
  }
  on('fs.exists', (_$, e) => ({ value: e.path === dir }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_$, e) => ({
    value: e.path === dir ? Object.keys(snapshots).map(name => ({ name, kind: 'file' as const, size: 100, mtimeMs: NOW, isLink: false })) : [],
  }))
  on('fs.read', (_$, e) => ({ value: snapshots[String(e.path).split('/').at(-1) ?? ''] ?? '' }))
  const opened: string[] = []
  on('process.run', (_$, e) => {
    if (e.argv[0] === 'open') opened.push(String(e.argv[1]))
    return { value: { exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('ui.open', () => ({ value: { isPlaced: false } }))
  // The band's own heartbeat starts with the session; here the All tasks view reads the snapshots.
  await $.command.run({ command: 'plan-progress', args: 'all' })
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const row = JSON.stringify(await ui.find({ key: 'pet-sessions' }))
  expect(row).toContain('mobile')
  expect(row).toContain('waiting: permission')
  // A session names itself by the app's title when it has one, else by its project folder.
  expect(row).toContain('PET-17 OTP on login')
  expect(row).not.toContain('"core"')
  expect(row).toContain('running · building 2/5')
  // A session whose branch PR merged says so and links the PR.
  expect(row).toContain('merged')
  expect(row).toContain('infra#4546')
  // The band no longer lists PRs waiting for review.
  expect(await ui.find({ key: 'pet-github' })).toBeUndefined()
  expect(await ui.find({ text: /PRs waiting/ })).toBeUndefined()
  // One line per session: a running one says its task in progress, an idle one its goal.
  expect(JSON.stringify(await ui.find({ key: 'pet-sessions-rows' }))).toContain('"flexDirection":"column"')
  expect(row).toContain('Running the OTP tests')
  expect(row).not.toContain('fix the OTP retry loop')
  expect(row).toContain('bump the quiz rollout to 50%')
  // Waiting first, then running, then merged, then idle.
  expect(row.indexOf('mobile')).toBeLessThan(row.indexOf('PET-17'))
  expect(row.indexOf('PET-17')).toBeLessThan(row.indexOf('infra'))
  expect(row.indexOf('infra')).toBeLessThan(row.indexOf('config'))
  // A click on a name opens that session in the app, by the app's own id; an older Bit's snapshot has none.
  await ui.press({ key: 'ss-open-waiting' })
  await ui.press({ key: 'ss-open-idle' })
  expect(opened).toEqual(['claude://claude.ai/epitaxy/local_waiting-host', 'claude://claude.ai/epitaxy/local_idle'])
  await ui.unmount()
})

test('a backgrounded shell counts as background work until the engine says otherwise', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('tool.call', () => ({ result: {}, text: 'started in the background' }))
  await $.tool.call({ tool: 'Bash', command: 'pnpm test', run_in_background: true } as never)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'pet-plan-line' })).toBeDefined()
  expect(await ui.find({ text: /1 in background/ })).toBeDefined()
  expect(JSON.stringify(await ui.find({ key: 'pet-background' }))).toContain('pnpm test')
  await ui.unmount()
})

test('the goal skips the system-reminder the host prepends to a prompt', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('tool.call', () => ({ result: {}, text: 'Plan shown (1 step).' }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  await $.prompt.submit({ text: '<system-reminder>\nhost notes\n</system-reminder>\nmake the sessions a list', origin: { kind: 'user' } } as never)
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Change it', status: 'in_progress' }], scope: 'first_task' } as never)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'Pane', requestId: 'plan-progress', props: PROPS })
  expect(await ui.find({ text: /^make the sessions a list$/ })).toBeDefined()
  expect(await ui.find({ text: /system-reminder/ })).toBeUndefined()
  await ui.unmount()
})

test('the Sessions list scrolls: the buttons page it and the wheel moves it a row while the band fits', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/tester' })
  const dir = '/home/tester/.claude/plan-progress/sessions'
  const snapshots: Record<string, string> = {}
  for (let i = 0; i < 8; i++) {
    snapshots[`s${i}.json`] = JSON.stringify({ sessionId: `s${i}`, project: `p${i}`, goal: null, phase: null, done: 0, total: 0, startedAt: NOW - i, endedAt: null, updatedAt: NOW, isRunning: false, needsYou: null })
  }
  on('fs.exists', (_$, e) => ({ value: e.path === dir }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', (_$, e) => ({
    value: e.path === dir ? Object.keys(snapshots).map(name => ({ name, kind: 'file' as const, size: 100, mtimeMs: NOW, isLink: false })) : [],
  }))
  on('fs.read', (_$, e) => ({ value: snapshots[String(e.path).split('/').at(-1) ?? ''] ?? '' }))
  on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false } }))
  on('ui.open', () => ({ value: { isPlaced: false } }))
  const engineMoves: number[] = []
  on('ui.scroll', (_$, e) => {
    engineMoves.push(e.by)
    return {}
  })
  await $.command.run({ command: 'plan-progress', args: 'all' })
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const shown = async () => ((await ui.findAll({ type: 'Button' })).map(button => button.key).filter(key => key?.startsWith('ss-open-')))
  const wheel = (by: number, contentRows = 20) =>
    $.ui.scroll({ component: 'AbovePrompt', requestId: 'band', offset: 0, by, bodyRows: 30, contentRows, origin: { kind: 'person' } } as never)

  expect(await shown()).toEqual(['ss-open-s0', 'ss-open-s1', 'ss-open-s2', 'ss-open-s3', 'ss-open-s4'])
  expect(await ui.find({ text: /^▼ 3 more$/ })).toBeDefined()
  expect(await ui.find({ key: 'pet-sessions-up' })).toBeUndefined()

  // A page down stops at the last full window.
  await ui.press({ key: 'pet-sessions-down' })
  expect(await shown()).toEqual(['ss-open-s3', 'ss-open-s4', 'ss-open-s5', 'ss-open-s6', 'ss-open-s7'])
  expect(await ui.find({ text: /^▲ 3 above$/ })).toBeDefined()
  expect(await ui.find({ key: 'pet-sessions-down' })).toBeUndefined()

  // The wheel moves one row a tick and keeps the window off the engine's.
  expect(await wheel(-1)).toEqual({})
  expect(await shown()).toEqual(['ss-open-s2', 'ss-open-s3', 'ss-open-s4', 'ss-open-s5', 'ss-open-s6'])
  expect(await ui.find({ text: /^▲ 2 above$/ })).toBeDefined()
  expect(await ui.find({ text: /^▼ 1 more$/ })).toBeDefined()

  // A band taller than its room scrolls as the engine's; the list stays.
  expect(engineMoves).toEqual([])
  await wheel(-1, 40)
  expect(engineMoves).toEqual([-1])
  expect(await shown()).toEqual(['ss-open-s2', 'ss-open-s3', 'ss-open-s4', 'ss-open-s5', 'ss-open-s6'])

  await ui.press({ key: 'pet-sessions-up' })
  expect(await shown()).toEqual(['ss-open-s0', 'ss-open-s1', 'ss-open-s2', 'ss-open-s3', 'ss-open-s4'])
  await ui.unmount()
})
