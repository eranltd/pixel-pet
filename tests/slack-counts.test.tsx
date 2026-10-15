import { expect, mock, test } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 30,
  bodyColumns: 200,
  scroll: { bodyRows: 30, offset: 0 },
  view: {},
} as never

const NOW_S = 1_800_000_000
const SERVER = 'a1b2c3d4-account-connector'
const ME = { name: 'Dana Lead', id: 'UME00000001' }
const BEN = { name: 'Ben Dev', id: 'UBEN0000001' }
const GAL = { name: 'Gal Pm', id: 'UGAL0000001' }

type Person = { name: string; id: string }
type Message = { channel: string; channelId: string; participants?: Person[]; from: Person; ts: number; text: string }

// The connector's detailed search format, as recorded from the live Slack connector.
const block = (m: Message, index: number, total: number) =>
  [
    `### Result ${index + 1} of ${total}`,
    `Channel: ${m.channel} (ID: ${m.channelId})`,
    ...(m.participants === undefined ? [] : [`Participants: ${m.participants.map(p => `${p.name} (ID: ${p.id})`).join(', ')}`]),
    `From: ${m.from.name} <x@example.com> (ID: ${m.from.id}) `,
    'Time: 2027-01-15 10:00:00 IST',
    `Message_ts: ${m.ts}.000100`,
    `Permalink: [link](https:\\/\\/example.slack.com\\/archives\\/${m.channelId}\\/p${m.ts}000100)`,
    `Text: \n${m.text}\n\n---\n`,
  ].join('\n')

const results = (messages: Message[]) => {
  const sorted = [...messages].sort((a, b) => b.ts - a.ts)
  return JSON.stringify({
    results: `# Search Results for: \n\n## Messages (${sorted.length} results)\n${sorted.map((m, i) => block(m, i, sorted.length)).join('\n')}`,
    pagination_info: '',
  })
}

const dmWith = (other: Person) => ({ channel: 'DM', channelId: `D${other.id}`, participants: [ME, other] })
const BEN_DM = dmWith(BEN)
const GAL_DM = dmWith(GAL)

// Ben wrote after Dana's last reply (2 waiting); Gal was answered; Dana's own messages never count.
const DMS: Message[] = [
  { ...BEN_DM, from: BEN, ts: NOW_S - 600, text: 'old question' },
  { ...BEN_DM, from: ME, ts: NOW_S - 500, text: 'answered' },
  { ...BEN_DM, from: BEN, ts: NOW_S - 300, text: 'one more thing' },
  { ...BEN_DM, from: BEN, ts: NOW_S - 200, text: 'can you look?' },
  { ...GAL_DM, from: GAL, ts: NOW_S - 400, text: 'ping' },
  { ...GAL_DM, from: ME, ts: NOW_S - 100, text: 'on it' },
]

test('Slack counts only messages from others after your last reply', async ($, on) => {
  const clock = mock.clock(on, { now: NOW_S * 1000 })
  mock.store(on)
  on('process.run', () => ({ exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false }))
  // A claude.ai connector is named by an account-specific ID, found only through the session's tool list.
  on('tool.list', () => ({ value: [{ name: `mcp__${SERVER}__slack_read_user_profile`, description: 'profile', mcp: true }] }))
  on('mcp.call', (_$, e) => {
    const text = (body: string) => ({ value: { content: [{ type: 'text' as const, text: body }], isError: false } })
    if (e.server !== SERVER) return { value: { content: [{ type: 'text' as const, text: 'no such server' }], isError: true } }
    if (e.tool === 'slack_read_user_profile') {
      // The concise profile has no ID line, which is how the counts broke.
      return text(e.args.response_format === 'detailed' ? `User ID: ${ME.id}\nDisplay Name: ${ME.name}\n` : `${ME.name}\nExample Co\n`)
    }
    const filters = String(e.args.filters ?? '')
    if (filters.startsWith('from:')) return text(results(DMS.filter(m => m.from.id === ME.id)))
    if (e.args.channel_types === 'im,mpim') return text(results(DMS))
    return text(results([]))
  })
  const status = await $.command.run({ command: 'bit', args: 'slack' })
  expect(JSON.stringify(status)).toContain(SERVER)
  // The first poll runs unawaited from the connect; let it finish.
  await clock.advance(0)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'pixel-pet', surface, component: 'AbovePrompt', props: PROPS })
    const row = JSON.stringify(await ui.find({ key: 'pet-slack' }))
    const all = JSON.stringify(await ui.drawn())
    expect(row).not.toBe(undefined)
    expect(all).toContain('Ben Dev')
    expect(all).not.toContain('Gal Pm')
    expect(all).not.toContain('Dana Lead')
    expect((await ui.findAll({ text: '2' })).length).toBeGreaterThan(0)
    expect(all).not.toMatch(/"3"|"4"/)
    // The latest waiting message shows beside the name, with its own dismiss.
    expect(all).toContain('can you look?')
    await ui.unmount()
  }
})

test('the check mark dismisses one conversation and leaves the others', async ($, on) => {
  const clock = mock.clock(on, { now: NOW_S * 1000 })
  mock.store(on)
  on('process.run', () => ({ exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false }))
  on('tool.list', () => ({ value: [{ name: `mcp__${SERVER}__slack_read_user_profile`, description: 'profile', mcp: true }] }))
  const OR = { name: 'Or Pm', id: 'UOR00000001' }
  const OR_DM = dmWith(OR)
  const dms = [...DMS, { ...OR_DM, from: OR, ts: NOW_S - 50, text: 'quick one' }]
  on('mcp.call', (_$, e) => {
    const text = (body: string) => ({ value: { content: [{ type: 'text' as const, text: body }], isError: false } })
    if (e.server !== SERVER) return { value: { content: [{ type: 'text' as const, text: 'no such server' }], isError: true } }
    if (e.tool === 'slack_read_user_profile') return text(`User ID: ${ME.id}\nDisplay Name: ${ME.name}\n`)
    const filters = String(e.args.filters ?? '')
    if (filters.startsWith('from:')) return text(results(dms.filter(m => m.from.id === ME.id)))
    if (e.args.channel_types === 'im,mpim') return text(results(dms))
    return text(results([]))
  })
  await $.command.run({ command: 'bit', args: 'slack' })
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: `sc-done-${BEN_DM.channelId}` })).toBeDefined()
  expect(await ui.find({ key: `sc-done-${OR_DM.channelId}` })).toBeDefined()
  await ui.press({ key: `sc-done-${BEN_DM.channelId}` })
  const after = JSON.stringify(await ui.drawn())
  expect(after).not.toContain('Ben Dev')
  expect(after).toContain('Or Pm')
  await ui.unmount()
  // The mark is kept in the store, so a fresh drawing agrees.
  const again = await $.ui.mount({ plugin: 'pixel-pet', surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const drawn = JSON.stringify(await again.drawn())
  expect(drawn).not.toContain('Ben Dev')
  expect(drawn).toContain('Or Pm')
  await again.unmount()
})

test('a conversation whose newest message is over two hours old ages out of the band', async ($, on) => {
  const clock = mock.clock(on, { now: NOW_S * 1000 })
  mock.store(on)
  on('process.run', () => ({ exitCode: 1, stdout: '', stderr: 'no process in tests', isStdoutTruncated: false, isStderrTruncated: false }))
  on('tool.list', () => ({ value: [{ name: `mcp__${SERVER}__slack_read_user_profile`, description: 'profile', mcp: true }] }))
  const NOA = { name: 'Noa Design', id: 'UNOA0000001' }
  const NOA_DM = dmWith(NOA)
  // Noa wrote three hours ago and was never answered: read elsewhere, as far as the band can tell.
  const dms = [...DMS, { ...NOA_DM, from: NOA, ts: NOW_S - 3 * 3600, text: 'any thoughts on the mockup?' }]
  on('mcp.call', (_$, e) => {
    const text = (body: string) => ({ value: { content: [{ type: 'text' as const, text: body }], isError: false } })
    if (e.server !== SERVER) return { value: { content: [{ type: 'text' as const, text: 'no such server' }], isError: true } }
    if (e.tool === 'slack_read_user_profile') return text(`User ID: ${ME.id}\nDisplay Name: ${ME.name}\n`)
    const filters = String(e.args.filters ?? '')
    if (filters.startsWith('from:')) return text(results(dms.filter(m => m.from.id === ME.id)))
    if (e.args.channel_types === 'im,mpim') return text(results(dms))
    return text(results([]))
  })
  await $.command.run({ command: 'bit', args: 'slack' })
  await clock.advance(0)
  const ui = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('Ben Dev')
  expect(drawn).not.toContain('Noa Design')
  await ui.unmount()
})
