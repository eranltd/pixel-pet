import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

const PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 30,
  bodyColumns: 200,
  scroll: { bodyRows: 30, offset: 0 },
  view: {},
} as never

const NOW = 1_800_000_000_000

const ran = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

const CURRENT = JSON.stringify({
  data: {
    repository: {
      defaultBranchRef: null,
      pullRequests: {
        nodes: [
          {
            number: 7,
            url: 'https://github.com/acme/app/pull/7',
            state: 'OPEN',
            repository: { name: 'app' },
            latestReviews: { nodes: [] },
            comments: { nodes: [{ body: 'Build ready: https://ci.example.com/logs/7 and preview https://preview.example.com/?build=7' }] },
          },
        ],
      },
    },
  },
})
const MINE = JSON.stringify({ data: { reviews: { nodes: [] }, viewer: { open: { nodes: [] }, merged: { nodes: [] } } } })

async function bandFor($: Parameters<TestBody>[0], on: Parameters<TestBody>[1]) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  mock.env(on, { HOME: '/home/tester' })
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.model', () => ({ value: 'test-model' }))
  on('session.usage', () => ({ value: { startedAt: NOW, context: { window: 200_000 }, rateLimits: [] } }))
  on('session.id', () => ({ value: 'options-test' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('fs.exists', (_$, e) => ({ value: e.path === '/repo/ci/globals.sh' }))
  on('fs.read', (_$, e) => ({ value: e.path === '/repo/ci/globals.sh' ? 'GLOBALS=(\n  package.json\n  ci/build.yml\n)' : '' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: false } }))
  on('process.run', (_$, e) => {
    const argv = e.argv.map(String)
    const line = argv.join(' ')
    if (line === 'git remote get-url origin') return ran(0, 'https://github.com/acme/app.git\n')
    if (line === 'git rev-parse --abbrev-ref HEAD') return ran(0, 'feat-checkout\n')
    if (line === 'git status --porcelain') return ran(0, '')
    if (argv[0] === 'git' && argv[1] === 'rev-list') return ran(0, '0 1\n')
    if (argv[0] === 'git' && argv[1] === 'diff') return ran(0, 'package.json\nsrc/checkout.ts\n')
    if (argv[0] === 'gh' && argv[2] === 'graphql') return ran(0, argv.some(arg => arg.startsWith('owner=')) ? CURRENT : MINE)
    return ran(1)
  })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  await clock.advance(0)
  return $.ui.mount({ plugin: 'pixel-pet', surface: 'desktop', component: 'AbovePrompt', props: PROPS })
}

test('with no options the band shows no preview link and no globals warning', async ($, on) => {
  const ui = await bandFor($, on)
  expect(await ui.find({ key: 'pet-hygiene' })).toBeUndefined()
  await ui.unmount()
})

test(
  'the options name the preview comment, its link and the globals files',
  { options: { previewMarker: 'preview', previewLinkMatch: 'build=', globalsFiles: ['ci/globals.sh'], extraBots: ['deploy-bot'] } },
  async ($, on) => {
    const ui = await bandFor($, on)
    const hygiene = JSON.stringify(await ui.find({ key: 'pet-hygiene' }))
    expect(hygiene).toContain('https://preview.example.com/?build=7')
    expect(hygiene).not.toContain('ci.example.com')
    expect(await ui.find({ text: /^package\.json changed: every app rebuilds and redeploys$/ })).toBeDefined()
    await ui.unmount()
  },
)
