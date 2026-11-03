import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { CARET_CLOSED, CARET_OPEN, cacheBadge, ciOfChecks, variantUrl } from '../hooks/side-pane'

const NOW = 1_800_000_000_000

const PANE = {
  title: 'Bit',
  isFocused: false,
  bodyColumns: 48,
  placement: 'dock',
  scroll: { offset: 0, bodyRows: 60 },
  view: {},
} as never

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 160,
  scroll: { bodyRows: 20, offset: 0 },
  view: {},
} as never

const OPTIONS = {
  layout: 'side-pane',
  codeRepo: 'acme/app',
  configRepo: 'acme/config',
  slackDomain: 'acme.slack.com',
  designer: 'Dana Design',
  experimentType: 'EXPERIMENT',
  configCli: 'dash',
  draftPath: '/drafts/{code}',
  variantQuery: 'exp={name}$${variant}&exp_zone={zone}',
  previewMarker: 'Preview ready',
  previewLinkMatch: 'build=',
}

const ran = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: exitCode === 0 ? '' : 'no such command in tests', isStdoutTruncated: false, isStderrTruncated: false } })
const text = (body: string, isError = false) => ({ value: { content: [{ type: 'text' as const, text: body }], isError } })

const ISSUE = {
  id: 'ABC-12',
  title: 'New checkout',
  url: 'https://linear.app/acme/issue/ABC-12/new-checkout',
  description: 'Design: [Checkout flow](https://www.figma.com/design/KEY123/Checkout-Flow?node-id=1-2)',
  createdBy: 'Pat Product',
  assignee: 'Me Myself',
  attachments: [{ url: 'https://github.com/acme/app/pull/7' }],
  relations: { blocks: [{ id: 'ABC-13', title: 'Checkout analytics' }], blockedBy: [], relatedTo: [], duplicateOf: null },
}

const PR = {
  number: 7,
  title: 'feat(web): add the new checkout [ABC-12]',
  url: 'https://github.com/acme/app/pull/7',
  state: 'OPEN',
  isDraft: false,
  reviewDecision: 'REVIEW_REQUIRED',
  statusCheckRollup: [
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2027-01-15T07:00:00Z' },
    { name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2027-01-15T07:00:00Z' },
  ],
  body: 'Docs: https://acme.notion.so/Checkout-spec-0123456789abcdef0123456789abcdef',
  comments: [{ body: 'Preview ready\nhttps://shop.example.com/checkout?build=B42' }],
}

// The review of #7: a thread waiting on you, one you answered last, one resolved, and a reviewer still asked.
const REVIEW = {
  data: {
    repository: {
      pullRequest: {
        reviewDecision: 'REVIEW_REQUIRED',
        reviewRequests: { nodes: [{ requestedReviewer: { login: 'dana' } }] },
        latestReviews: { nodes: [] },
        reviewThreads: {
          nodes: [
            { isResolved: false, comments: { nodes: [{ author: { login: 'pat-product' }, body: '**Please** rename this <!-- bot -->', url: 'https://github.com/acme/app/pull/7#discussion_r1' }] } },
            { isResolved: false, comments: { nodes: [{ author: { login: 'me-login' }, body: 'my own reply', url: 'https://github.com/acme/app/pull/7#discussion_r2' }] } },
            { isResolved: true, comments: { nodes: [{ author: { login: 'pat-product' }, body: 'an old nit', url: 'https://github.com/acme/app/pull/7#discussion_r3' }] } },
          ],
        },
      },
    },
  },
}

const EXPERIMENT = {
  ticket_id: 'ABC-12',
  title: 'Checkout: one page vs two',
  status: 'draft',
  zone: 'exp_a',
  perc: 100,
  preview_url: 'https://shop.example.com/checkout/start',
  variants: { 'flow@original': { active: true }, 'flow@one_page': { active: true } },
}

const DAY = 24 * 3600_000
const SNAPSHOTS: Record<string, object> = {
  // In this session's linked family, so listed though it works on another ticket.
  'a.json': { sessionId: 'a', hostSessionId: 'local_a', project: 'app', title: 'Old idle session', goal: null, phase: null, done: 0, total: 0, startedAt: null, endedAt: null, updatedAt: NOW, isRunning: false, openedAt: NOW - 3 * DAY },
  'b.json': { sessionId: 'b', project: 'app', title: 'Waiting on me', goal: null, phase: null, done: 0, total: 0, startedAt: null, endedAt: null, updatedAt: NOW, isRunning: false, needsYou: 'permission', openedAt: NOW - 2 * 3600_000, ticket: 'ABC-12' },
  // Neither linked nor on the ticket, so Related Sessions leaves it out.
  'z.json': { sessionId: 'z', project: 'app', title: 'Someone else work', goal: null, phase: null, done: 0, total: 0, startedAt: null, endedAt: null, updatedAt: NOW, isRunning: true, ticket: 'XYZ-9' },
}

// Every title the plugin gave a pane, in order.
const opened: string[] = []

async function sessionOnTicket($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], placed: boolean) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/tester' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'side-pane-test' }))
  on('session.model', () => ({ value: 'test-model' }))
  on('ui.log', () => ({ value: undefined }))
  on('agent.list', () => ({
    value: [
      { id: 'ag1', description: 'Check the lint rule', type: 'Explore', status: 'running' as const },
      { id: 'ag2', description: 'Finished search', type: 'Explore', status: 'completed' as const },
    ],
  }))
  // The engine's answer to a tool the plugin passes on, such as the app's PR monitor.
  on('tool.call', (_$, e) => ({ result: {}, text: String((e as { command?: unknown }).command ?? '').includes('gh pr create') ? 'https://github.com/acme/app/pull/7\n' : 'ok' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 1_000_000, tokens: 250_000, percent: 25 }, rateLimits: [] } }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__pixel-pet__${e.name}` } }))
  const dir = '/home/tester/.claude/plan-progress/sessions'
  on('fs.exists', (_$, e) => ({ value: e.path === dir }))
  on('fs.list', (_$, e) => ({
    value: e.path === dir ? Object.keys(SNAPSHOTS).map(name => ({ name, kind: 'file' as const, size: 100, mtimeMs: NOW, isLink: false })) : [],
  }))
  on('fs.read', (_$, e) => ({ value: JSON.stringify(SNAPSHOTS[String(e.path).split('/').at(-1) ?? ''] ?? '') }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.open', (_$, e) => {
    opened.push(String(e.title))
    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({ value: placed ? [{ id: 'ticket', title: 'Bit', isShown: true, isFocused: false, isPlaced: true }] : [] }))
  // The ticket's TL;DR and the session's come from two different briefs.
  on('model.complete', (_$, e) => ({
    value: {
      isAnswered: true,
      text: String(e.system).includes('session') ? 'Wiring the checkout ticket; its lint check is the blocker.' : 'Ships the new checkout; lint fails on #7.',
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'Wire the new checkout', toolUses: [] },
      { role: 'assistant', text: 'Opened #7; lint fails.', toolUses: [] },
    ],
  }))
  on('tool.list', () => ({
    value: ['linear__get_issue', 'linear__list_issue_statuses', 'slack__slack_search_users', 'slack__slack_read_user_profile'].map(name => ({ name: `mcp__${name}`, description: name, mcp: true })),
  }))
  on('mcp.call', (_$, e) => {
    if (e.server === 'linear' && e.tool === 'get_issue') return text(JSON.stringify(ISSUE))
    if (e.server === 'linear' && e.tool === 'list_comments') return text(JSON.stringify({ comments: [{ body: 'Copy lives in exp_a_9 too' }] }))
    if (e.tool === 'slack_read_user_profile') return text('User ID: U0ME\nName: Me Myself')
    if (e.tool === 'slack_search_users') {
      const name = (e.args.keywords as string[]).join(' ')
      const id = { 'Pat Product': 'U0PAT', 'Me Myself': 'U0ME', 'Dana Design': 'U0DANA' }[name]
      return text(JSON.stringify({ results: id === undefined ? '' : `### Result 1 of 1\nName: ${name}\nUser ID: ${id}\n` }))
    }
    if (e.tool.startsWith('slack_search')) return text(JSON.stringify({ results: '', pagination_info: '' }))
    // A family member that runs no Bit comes from the app's list alone.
    if (e.server === 'ccd_session_mgmt' && e.tool === 'list_sessions') {
      return text(JSON.stringify([
        { sessionId: 'local_a', title: 'Old idle session', isRunning: false, lastActivityAt: '2027-01-14T00:00:00Z' },
        { sessionId: 'local_d', title: 'Spun-off docs pass', isRunning: true, lastActivityAt: '2027-01-15T00:00:00Z' },
      ]))
    }
    if (e.server === 'ccd_session_mgmt' && e.tool === 'get_session') return text(JSON.stringify({ model: 'claude-opus-5-5', effort: 'xhigh', fastMode: { state: 'off' } }))
    return text('unknown tool', true)
  })
  on('process.run', (_$, e) => {
    const argv = e.argv.map(String)
    const line = argv.join(' ')
    if (line === 'git remote get-url origin') return ran(0, 'https://github.com/acme/app.git\n')
    if (line === 'git rev-parse --abbrev-ref HEAD') return ran(0, 'abc-12-new-checkout\n')
    if (line === 'git status --porcelain') return ran(0, '')
    if (argv[0] === 'git' && argv[1] === 'rev-list') return ran(0, '0 1\n')
    if (line === 'gh api user --jq .login') return ran(0, 'me-login\n')
    if (argv[0] === 'gh' && argv[2] === 'graphql' && line.includes('pullRequest(number')) return ran(0, JSON.stringify(REVIEW))
    if (line.startsWith('gh search prs ABC-12 --owner acme')) {
      return ran(0, JSON.stringify([{ url: 'https://github.com/acme/app/pull/7' }, { url: 'https://github.com/acme/app/pull/9' }]))
    }
    if (line.startsWith('gh pr view 7 -R acme/app')) return ran(0, JSON.stringify(PR))
    // Search splits the id into words, so it also finds a PR of ABC-120.
    if (line.startsWith('gh pr view 9 -R acme/app')) {
      return ran(0, JSON.stringify({ ...PR, number: 9, title: 'fix: tidy [ABC-120]', headRefName: 'abc-120-tidy', body: '', state: 'MERGED' }))
    }
    if (line === 'dash config search --type EXPERIMENT --search ABC-12 --no-content') {
      const row = { sub_type: 'exp_a_8', url: 'https://dash.example.com/config/exp8', remote_url: 'https://github.com/acme/config/blob/main/src/EXPERIMENT/exp_a_8.json', last_update: '2027-01-14T00:00:00Z' }
      return ran(0, JSON.stringify({ ok: true, data: { data: [row] } }))
    }
    if (line.startsWith('dash config search')) return ran(0, JSON.stringify({ ok: true, data: { data: [] } }))
    if (line.includes('repos/acme/config/contents/src/EXPERIMENT/exp_a_8.json')) return ran(0, JSON.stringify(EXPERIMENT))
    return ran(1)
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  // The first heartbeat reads the other sessions' snapshots.
  await clock.advance(5000)
  return clock
}

test(
  'the side pane shows the ticket, its next step, PRs, the experiment, links and people',
  { options: OPTIONS },
  async ($, on) => {
    await sessionOnTicket($, on, true)
    const answer = await $.tool.call({ tool: 'mcp__pixel-pet__open_session_pane' } as never)
    // Bit's tab says the session is idle and names the ticket once it is read.
    expect(opened).toContain('⚪ ABC-12')
    const report = JSON.stringify(answer)
    expect(report).toContain('ABC-12 · New checkout')
    expect(report).toContain('Next: Fix CI on #7: lint')
    expect(report).toContain('https://acme.slack.com/app_redirect?channel=U0PAT')
    // The current user is left out of People.
    expect(report).not.toContain('U0ME')

    for (const surface of ['terminal', 'desktop'] as const) {
      const pane = await $.ui.mount({ plugin: 'pixel-pet', surface, component: 'Pane', requestId: 'ticket', props: PANE })
      const drawn = JSON.stringify(await pane.drawn())
      // The session's TL;DR is the first line; the ticket's sits in the Ticket section.
      expect(drawn.indexOf('Wiring the checkout ticket')).toBeLessThan(drawn.indexOf('"key":"tp-ticket"'))
      expect(drawn.indexOf('Ships the new checkout; lint fails on #7.')).toBeGreaterThan(drawn.indexOf('"key":"tp-ticket"'))
      expect(drawn).toContain('app #7')
      expect(drawn).not.toContain('app #9')
      expect(drawn).toContain('add the new checkout')
      expect(drawn).toContain('CI failing')
      expect(drawn).toContain('exp_a_8')
      expect(drawn).toContain('original (control)')
      expect(drawn).toContain('Checkout flow')
      expect(drawn).toContain('Checkout spec')
      expect(drawn).toContain('ABC-13 · Checkout analytics')
      expect(drawn).toContain('Pat Product')
      expect(drawn).toContain('wrote the ticket')
      expect(drawn).toContain('Dana Design')
      expect(drawn).toContain('25% used')
      // A section with nothing to show keeps its headline: this ticket has no unsaved drafts.
      expect(drawn).toContain('"key":"tp-drafts-title"')
      // and draws it faded; a section with data does not.
      if (surface === 'desktop') {
        expect(JSON.stringify(await pane.find({ key: 'tp-drafts-title' }))).toContain('opacity=\\"0.45\\"')
        expect(JSON.stringify(await pane.find({ key: 'tp-ticket-title' }))).not.toContain('opacity=')
      }
      expect(await pane.find({ key: 'tp-refresh' })).toBeDefined()
      await pane.unmount()
    }
  },
)

test('Related Sessions sit last, collapsed until opened, with their age in days colored by status', { options: OPTIONS }, async ($, on) => {
  await sessionOnTicket($, on, true)
  const pane = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'Pane', requestId: 'ticket', props: PANE })
  const collapsed = JSON.stringify(await pane.drawn())
  expect(collapsed).not.toContain('Old idle session')
  expect(collapsed).toContain(`${CARET_CLOSED} 4`)
  await pane.press({ key: 'tp-sessions-toggle' })
  const drawn = JSON.stringify(await pane.drawn())
  // The ticket area sits above the separator; Slack, Gmail, Code Review, Sessions and Context below it, in that order.
  const separator = drawn.indexOf('"key":"tp-separator"')
  expect(drawn.indexOf('"key":"tp-people"')).toBeLessThan(separator)
  const order = ['tp-slack', 'tp-gmail', 'tp-review', 'tp-sessions', 'tp-context'].map(key => drawn.indexOf(`"key":"${key}"`))
  expect(order[0]).toBeGreaterThan(separator)
  expect([...order].sort((a, b) => a - b)).toEqual(order)
  // Waiting on you sorts first, in orange; the idle one is red with its age.
  expect(drawn.indexOf('Waiting on me')).toBeLessThan(drawn.indexOf('Old idle session'))
  expect(drawn).toContain('"color":"#F0883E"},"children":["<1d"]')
  expect(drawn).toContain('"color":"#f85149"},"children":["3d"]')
  expect(drawn).toContain('1 need you')
  expect(drawn).toContain(`${CARET_OPEN} 4`)
  // Only the linked family, the sessions on this ticket and this session's agents still at work.
  expect(drawn).toContain('Spun-off docs pass')
  expect(drawn).not.toContain('Someone else work')
  expect(drawn).toContain('Check the lint rule')
  expect(drawn).toContain('Explore agent')
  expect(drawn).not.toContain('Finished search')
  expect(await pane.find({ key: 'tp-session-open-agent-ag1' })).toBeUndefined()
  // The ticket's own sections start open and collapse from their caret too.
  expect(drawn).toContain('Fix CI on #7: lint')
  await pane.press({ key: 'tp-ticket-toggle' })
  expect(JSON.stringify(await pane.drawn())).not.toContain('Fix CI on #7: lint')
  // The caret sits beside the title, not on the right.
  expect(JSON.stringify(await pane.find({ key: 'tp-sessions-title-row' }))).toContain('tp-sessions-toggle')
  await pane.unmount()
})

test('the demo fills the pane with made-up data and the real ticket comes back after', { options: OPTIONS }, async ($, on) => {
  await sessionOnTicket($, on, true)
  const demo = JSON.stringify(await $.tool.call({ tool: 'mcp__pixel-pet__open_session_pane', demo: true } as never))
  expect(demo).toContain('PET-42 · Draw the pet beside the chat')
  const pane = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'Pane', requestId: 'ticket', props: PANE })
  const drawn = JSON.stringify(await pane.drawn())
  expect(drawn).toContain('Moves Bit into a side pane')
  expect(drawn).toContain('Dana Levi')
  // A message too long for its line scrolls as a ticker; a short one is plain text.
  const longLine = JSON.stringify(await pane.find({ key: 'tp-slack-demo-grp-latest-body' }))
  expect(longLine).toContain('animateTransform')
  expect(longLine).toContain('Deploy looks good from here, metrics are flat.')
  expect(JSON.stringify(await pane.find({ key: 'tp-slack-demo-dm-1-latest-body' }))).not.toContain('animateTransform')
  // Rows sit one step in under their headline.
  expect(JSON.stringify(await pane.find({ key: 'tp-people-rows' }))).toContain('"paddingLeft":3')
  // Each Slack message line ends in the time it came.
  expect(JSON.stringify(await pane.find({ key: 'tp-slack-demo-dm-2-latest-right' }))).toMatch(/"\d{2}:\d{2}"/)
  expect(drawn).not.toContain('New checkout')
  expect(await pane.find({ key: 'tp-snake' })).toBeDefined()
  expect(drawn).not.toContain('Old idle session')
  // Code Review covers the session's own PRs: folded with their count, and how much waits on you.
  expect(drawn).toContain(`${CARET_CLOSED} 1`)
  expect(drawn).toContain('3 need you')
  await pane.press({ key: 'tp-review-toggle' })
  const reviews = JSON.stringify(await pane.drawn())
  expect(reviews).toContain('changes requested · noa-cohen')
  expect(reviews).toContain('Can the caret sit right after the title?')
  expect(reviews).toContain('waiting on omri-barak')
  // hide all folds every section; then the same button shows them all again.
  await pane.press({ key: 'tp-sessions-toggle' })
  expect(JSON.stringify(await pane.drawn())).toContain('Review the pane diff')
  await pane.press({ key: 'tp-fold-all' })
  const folded = JSON.stringify(await pane.drawn())
  expect(folded).toContain('show all')
  expect(folded).not.toContain('"key":"tp-ticket-rows"')
  await pane.press({ key: 'tp-fold-all' })
  expect(JSON.stringify(await pane.drawn())).toContain('"key":"tp-ticket-rows"')
  await pane.unmount()

  const real = JSON.stringify(await $.tool.call({ tool: 'mcp__pixel-pet__open_session_pane', demo: false } as never))
  expect(real).toContain('ABC-12 · New checkout')
})

test('a valuable change blinks its section, and Code Review blinks while the session watches a PR', { options: OPTIONS }, async ($, on) => {
  const clock = await sessionOnTicket($, on, true)
  const blinks = async (key: string) => JSON.stringify(await pane.find({ key })).includes('attributeName=\\"opacity\\" values=\\"1;0.25;1\\"')
  const pane = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'Pane', requestId: 'ticket', props: PANE })
  expect(await blinks('tp-sessions-title')).toBe(false)
  expect(await blinks('tp-review-title')).toBe(false)

  // A session that starts waiting on you is news.
  SNAPSHOTS['c.json'] = { ...SNAPSHOTS['b.json'], sessionId: 'c', title: 'Needs a decision' }
  await clock.advance(10_000)
  expect(await blinks('tp-sessions-title')).toBe(true)
  delete SNAPSHOTS['c.json']

  await $.tool.call({ tool: 'mcp__ccd_pr__set_monitor', auto_fix: true, url: 'https://github.com/acme/app/pull/7' } as never)
  expect(await blinks('tp-review-title')).toBe(true)
  await $.tool.call({ tool: 'mcp__ccd_pr__set_monitor', auto_fix: false, url: 'https://github.com/acme/app/pull/7' } as never)
  expect(await blinks('tp-review-title')).toBe(false)
  await pane.unmount()
})

test('the status line on top names the task in hand, Context names the model, and Code Review covers the PR the session opened', { options: OPTIONS }, async ($, on) => {
  await sessionOnTicket($, on, true)
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Read the code', status: 'completed' },
      { content: 'Change it', status: 'in_progress' },
      { content: 'Test it', status: 'pending' },
    ],
    scope: 'first_task',
  } as never)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' } as never)
  const pane = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'Pane', requestId: 'ticket', props: PANE })
  const drawn = JSON.stringify(await pane.drawn())
  // One status line opens the pane, above the TL;DR: the task in hand.
  expect(drawn.indexOf('"key":"tp-status"')).toBeLessThan(drawn.indexOf('"key":"tp-status-separator"'))
  expect(drawn.indexOf('"key":"tp-status-separator"')).toBeLessThan(drawn.indexOf('"key":"tp-tldr"'))
  expect(JSON.stringify(await pane.find({ key: 'tp-status-separator' }))).toContain('"marginBottom":1')
  expect(JSON.stringify(await pane.find({ key: 'tp-status' }))).toContain('Change it')
  expect(await pane.find({ key: 'tp-plan' })).toBeUndefined()
  // The pinned footer opens with its separator, then Context.
  const footer = JSON.stringify(await pane.find({ key: 'tp-footer' }))
  expect(footer.indexOf('tp-footer-separator')).toBeLessThan(footer.indexOf('"key":"tp-context"'))
  // The tab carries the plan's progress too.
  expect(opened.at(-1)).toBe('⚪ ABC-12 · 1/3')
  expect(JSON.stringify(await pane.find({ key: 'tp-context-mode' }))).toContain('Opus 5.5')
  expect(JSON.stringify(await pane.find({ key: 'tp-context-mode' }))).toContain('fast off')

  // Code Review shows where review stands on the PR the session opened: only the thread that waits on you counts.
  await pane.press({ key: 'tp-review-toggle' })
  const review = JSON.stringify(await pane.drawn())
  expect(review).toContain('1 need you')
  expect(review).toContain('Please rename this')
  expect(review).not.toContain('my own reply')
  expect(review).not.toContain('an old nit')
  expect(review).toContain('waiting on dana')
  await pane.unmount()
})

// Under managed settings cc-plugin-sec-default skips every classic.* hook, so the wait cannot come from classic.Notification.
test('the status line reads Waiting on you while a question is open, and clears once it is answered', { options: OPTIONS }, async ($, on) => {
  let status = async () => ''
  let whileAsked = ''
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    whileAsked = await status()
    return { result: {}, text: 'answered' }
  })
  await sessionOnTicket($, on, true)
  const pane = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'Pane', requestId: 'ticket', props: PANE })
  status = async () => JSON.stringify(await pane.find({ key: 'tp-status' }))
  await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(whileAsked).toContain('Waiting on you')
  expect(await status()).not.toContain('Waiting on you')
  await pane.unmount()
})

test('with the pane open the band draws nothing; closed, it keeps the TL;DR and offers the pane back', { options: OPTIONS }, async ($, on) => {
  await sessionOnTicket($, on, false)
  const band = await $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: BAND })
  expect(await band.find({ key: 'pet-pane-open' })).toBeDefined()
  expect(JSON.stringify(await band.find({ key: 'pet-tldr' }))).toContain('Wiring the checkout ticket')
  expect(await band.find({ key: 'handoff' })).toBeUndefined()
  await band.unmount()
})

test('only the newest run of each check counts, and a skipped run is no failure', async () => {
  const rerun = ciOfChecks([
    { name: 'lint', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: '2027-01-15T07:00:00Z' },
    { name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: '2027-01-15T08:00:00Z' },
    { name: 'deploy', status: 'COMPLETED', conclusion: 'SKIPPED', startedAt: '2027-01-15T08:00:00Z' },
  ])
  expect(rerun).toEqual({ ci: 'passing', failing: [] })
  expect(ciOfChecks([{ name: 'build', status: 'IN_PROGRESS', startedAt: '2027-01-15T08:00:00Z' }]).ci).toBe('running')
})

test('the cache badge stays quiet while warm, warns near the end, and goes cold', async () => {
  expect(cacheBadge(null, 300_000)).toBeNull()
  expect(cacheBadge(51 * 60_000, 300_000)).toBeNull()
  expect(cacheBadge(4 * 60_000, 300_000)).toEqual({ text: '⚠ cache 4m', color: '#F0883E' })
  expect(cacheBadge(90_000, 300_000)).toEqual({ text: '⚠ cache 1:30', color: '#F0883E' })
  expect(cacheBadge(0, 300_000)).toEqual({ text: '❄ cache cold', color: '#f85149' })
})

test('a variant link is encoded and rides the newest preview build of the same app', async () => {
  const url = variantUrl(
    'https://shop.example.com/checkout/start',
    'exp={name}$${variant}&exp_zone={zone}',
    'exp_a_8',
    'flow@one_page',
    'exp_a',
    ['https://shop.example.com/account?build=A1', 'https://shop.example.com/checkout?build=B42'],
    'build',
  )
  expect(url).toBe('https://shop.example.com/checkout/start?build=B42&exp=exp_a_8%24%24flow%40one_page&exp_zone=exp_a')
})
