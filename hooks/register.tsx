import { atom, read, update } from 'claude-code'
import type {
  Elements,
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionEndInput,
  SessionMessage,
  SessionRateLimit,
  TurnCompleteInput,
} from 'claude-code'

import type {
  BackgroundTask,
  BranchState,
  SlackItem,
  SlackMarks,
  SlackView,
  CurrentPr,
  SessionPr,
  PushWatch,
  Win,
  WorktreeRow,
  WorktreeScan,
  CacheKeeperHandoff,
  CacheKeeperLimit,
  CacheKeeperTtl,
  CacheKeeperUsage,
  Critique,
  CritiqueModel,
  CritiqueStatus,
  CritiqueVerdict,
  CiState,
  GitHubView,
  Mood,
  MoodKind,
  MyPr,
  Plan,
  PlanPhase,
  PlanSnapshot,
  PlanTask,
  PlanTaskStatus,
  PlanView,
  ReviewItem,
} from '../types'

const PANE = 'plan-progress'
const TITLE = 'Plan Progress'
const HEARTBEAT_MS = 5000
// A session that has not written its snapshot for this long is gone (closed or crashed).
const STALE_MS = 3 * HEARTBEAT_MS + 2000
const PRUNE_MS = 24 * 60 * 60 * 1000

const PHASES: readonly PlanPhase[] = ['researching', 'planning', 'building', 'testing', 'auditing']

const EMPTY_PLAN: Plan = {
  goal: null,
  isGoal: false,
  phase: null,
  tasks: [],
  startedAt: null,
  endedAt: null,
}

const planAtom = atom({ plugin: 'pixel-pet', key: 'plan' } as const, EMPTY_PLAN)
const viewAtom = atom({ plugin: 'pixel-pet', key: 'view' } as const, 'plan' as PlanView)
const othersAtom = atom({ plugin: 'pixel-pet', key: 'others' } as const, [] as PlanSnapshot[])
const runningAtom = atom({ plugin: 'pixel-pet', key: 'isRunning' } as const, false)
// Work running behind the turn: background subagents and shells. The Stop hook has the engine's own list; mid-turn the spawns add to it.
const backgroundAtom = atom({ plugin: 'pixel-pet', key: 'background' } as const, [] as BackgroundTask[])

const addBackground = ($: EngineInterface, task: BackgroundTask) =>
  update($, backgroundAtom, list => (list.some(one => one.id === task.id) ? list : [...list, task]))
const mutedAtom = atom({ plugin: 'pixel-pet', key: 'isMuted' } as const, false)

type AnyCall = { tool: string; tool_use_id: string; agentId?: string; [argument: string]: unknown }

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch', 'ListMcpResourcesTool', 'ReadMcpResourceTool', 'ReadMcpResourceDirTool'])
const PLAN_TOOLS = new Set(['EnterPlanMode', 'ExitPlanMode', 'TodoWrite', 'TaskCreate', 'AskUserQuestion'])
const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const TEST_COMMAND = /\b(tests?|pytest|vitest|jest|mocha|playwright|tsc|typecheck|lint|eslint|ruff|mypy|pyright|go vet|cargo (test|check|clippy)|make (test|check|lint)|validate)\b/
const AUDIT_COMMAND = /\b(git (diff|log|show)|gh pr (diff|view|checks))\b/
const READ_COMMAND = /^\s*(ls|cat|head|tail|grep|rg|find|wc|tree|pwd|which|file|stat|sed -n|git (status|branch|blame|ls-files)|gh (issue|api)|jq)\b/
const AUDIT_WORDS = /\b(review|audit|verif|security)/i

const phaseOfCall = (call: AnyCall): PlanPhase | null => {
  const { tool } = call

  if (PLAN_TOOLS.has(tool)) {
    return 'planning'
  }
  if (WRITE_TOOLS.has(tool)) {
    return 'building'
  }
  if (READ_TOOLS.has(tool)) {
    return 'researching'
  }
  if (tool === 'ReportFindings') {
    return 'auditing'
  }
  if (tool === 'Skill') {
    const skill = String(call.skill ?? '')
    if (AUDIT_WORDS.test(skill) || /simplify/.test(skill)) {
      return 'auditing'
    }
    return null
  }
  if (tool === 'Agent') {
    const description = String(call.description ?? '')
    if (AUDIT_WORDS.test(description)) {
      return 'auditing'
    }
    if (call.subagent_type === 'Plan') {
      return 'planning'
    }
    if (call.subagent_type === 'Explore') {
      return 'researching'
    }
    return null
  }
  if (tool === 'Bash') {
    const command = String(call.command ?? '')
    if (TEST_COMMAND.test(command)) {
      return 'testing'
    }
    if (AUDIT_COMMAND.test(command)) {
      return 'auditing'
    }
    return READ_COMMAND.test(command) ? 'researching' : 'building'
  }
  if (tool.startsWith('mcp__Claude_Browser__') || tool.startsWith('mcp__claude-in-chrome__')) {
    return 'testing'
  }
  return null
}

const asStatus = (value: unknown): PlanTaskStatus =>
  value === 'completed' || value === 'in_progress' ? value : 'pending'

const firstLine = (text: string, max: number) => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

// The host prepends system-reminder blocks to a prompt; the goal is the person's own first line.
const promptGist = (text: string, max: number) =>
  firstLine(text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').replace(/<\/?[a-z_-]+(?:\s[^>]*)?>/g, ''), max)

const formatElapsed = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  if (h > 0) {
    return `${h}h ${m}m`
  }
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

const countDone = (tasks: readonly PlanTask[]) => tasks.filter(task => task.status === 'completed').length

const percentOf = (done: number, total: number) => (total === 0 ? 0 : Math.round((done / total) * 100))

const isActive = (plan: Plan) => plan.isGoal || plan.tasks.length > 0

const CALM: Mood = { kind: 'idle', text: '', until: 0 }
const moodAtom = atom({ plugin: 'pixel-pet', key: 'mood' } as const, CALM)
const frameAtom = atom({ plugin: 'pixel-pet', key: 'frame' } as const, 0)
const hiddenAtom = atom({ plugin: 'pixel-pet', key: 'isHidden' } as const, false)
const collapsedAtom = atom({ plugin: 'pixel-pet', key: 'isCollapsed' } as const, false)
const sessionsOffsetAtom = atom({ plugin: 'pixel-pet', key: 'sessionsOffset' } as const, 0)
const attentionAtom = atom({ plugin: 'pixel-pet', key: 'needsAttention' } as const, false)
const lastActiveAtom = atom({ plugin: 'pixel-pet', key: 'lastActiveAt' } as const, 0)
const SLEEP_AFTER_MS = 15 * 60_000

const PET = 'Bit'
const PET_TICK_MS = 400
const PIXEL_PX = 1.5

const PALETTE: Record<string, number> = {
  o: 0x4a3426,
  b: 0xe8a765,
  d: 0xa6683e,
  c: 0xfff1d6,
  e: 0x231815,
  w: 0xffffff,
  n: 0x231815,
  t: 0xff6f8a,
  p: 0xffaaaa,
  h: 0xff5a78,
  s: 0x78c8ff,
  y: 0xffd65a,
  r: 0xe23d3d,
}
const TERMINAL_DEFAULT = 0x01000000

type Point = readonly [number, number]

const WIDTH = 26
const HEIGHT = 18

function ellipse(cx: number, cy: number, rx: number, ry: number): Point[] {
  const points: Point[] = []
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      if (((x + 0.5 - cx) / rx) ** 2 + ((y + 0.5 - cy) / ry) ** 2 <= 1) points.push([y, x])
    }
  }

  return points
}

const HEART = ['hh.hh', 'hhhhh', '.hhh.', '..h..']
const BANG = ['yy', 'yy', 'yy', '..', 'yy']
const ZZZ = ['sssss', '...s.', '..s..', '.s...', 'sssss']

// What the session is doing, as Bit shows it: a mood (happy/sad) wins, then the session state.
type Pose = MoodKind | 'working' | 'attention' | 'sleeping'

const POSE_LABEL: Record<Pose, [string, string]> = {
  idle: ['ready', 'gray'],
  working: ['working…', 'cyan'],
  attention: ['needs you', 'yellow'],
  sleeping: ['asleep', 'gray'],
  happy: ['passed ✓', 'green'],
  sad: ['failed ✗', 'red'],
}

// Pixel grid of the dog for one frame; '.' is transparent, each other letter a palette key.
function drawDog(kind: Pose, tick: number): string[] {
  const grid = Array.from({ length: HEIGHT }, () => Array<string>(WIDTH).fill('.'))
  const isHopping = kind === 'happy' || kind === 'attention'
  const top = isHopping && tick % 2 === 0 ? 0 : 2
  const inside = (y: number, x: number) => y >= 0 && y < HEIGHT && x >= 0 && x < WIDTH
  // Corner art sits beside the head and does not move with a hop.
  const corner = (art: readonly string[], ch: string, x0: number, y0 = 0) =>
    art.forEach((row, y) =>
      row.split('').forEach((cell, x) => {
        if (cell !== '.' && inside(y + y0, x + x0)) grid[y + y0]![x + x0] = ch
      }),
    )
  const put = (points: readonly Point[], ch: string) => {
    for (const [y, x] of points) if (inside(y + top, x)) grid[y + top]![x] = ch
  }
  const part = (points: readonly Point[], ch: string) => {
    const own = new Set(points.map(([y, x]) => `${y},${x}`))
    const ring: Point[] = []
    for (const [y, x] of points) {
      for (const [dy, dx] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        if (!own.has(`${y + dy},${x + dx}`)) ring.push([y + dy, x + dx])
      }
    }
    put(ring, 'o')
    put(points, ch)
  }

  const wag = isHopping ? tick % 2 : kind === 'sad' || kind === 'sleeping' ? 2 : Math.floor(tick / 2) % 2
  const tails: Point[][] = [
    [[13, 16], [12, 17], [11, 18], [10, 18]],
    [[13, 16], [13, 17], [12, 18], [12, 19]],
    [[13, 16], [14, 17], [14, 18]],
  ]
  part(tails[wag]!, 'b')
  part(ellipse(11, 12.6, 4.4, 3.6), 'b')
  put(ellipse(11, 13.4, 2.2, 2.2), 'c')
  put([[15, 8], [15, 9], [15, 12], [15, 13]], 'c')
  put([[15, 10], [15, 11]], 'o')
  part(ellipse(11, 5, 6.6, 4.7), 'b')

  const earY = isHopping ? 5.4 : kind === 'sad' || kind === 'sleeping' ? 7.4 : 6.4
  part(ellipse(4.6, earY, 1.9, 3.4), 'd')
  part(ellipse(17.4, earY, 1.9, 3.4), 'd')
  put(ellipse(11, 7.6, 3.2, 2), 'c')
  put([[10, 8], [10, 9], [10, 10], [10, 11], [10, 12], [10, 13]], 'r')
  put([[11, 10], [11, 11]], 'y')
  put([[6, 10], [6, 11]], 'n')

  if (kind === 'happy') {
    put([[5, 6], [4, 7], [4, 8], [5, 9], [5, 12], [4, 13], [4, 14], [5, 15]], 'e')
    put([[6, 6], [6, 15]], 'p')
    put([[7, 9], [7, 10], [7, 11], [7, 12]], 'o')
    put([[8, 10], [8, 11]], 't')
    corner(HEART, 'h', 21)
  } else if (kind === 'sleeping') {
    put([[5, 7], [5, 8], [5, 13], [5, 14]], 'e')
    put([[8, 10], [8, 11]], 'o')
    corner(ZZZ, 's', 21, tick % 4 < 2 ? 1 : 0)
  } else if (kind === 'sad') {
    put([[4, 8], [5, 7], [5, 8], [4, 13], [5, 13], [5, 14]], 'e')
    put([[6 + (tick % 2), 7]], 's')
    put([[8, 9], [7, 10], [7, 11], [8, 12]], 'o')
  } else {
    const isWorking = kind === 'working'
    const look = isWorking ? ([-1, 0, 1, 0][Math.floor(tick / 3) % 4] ?? 0) : 0
    const isBlinking = tick % 11 === 0
    const eyes: Point[] = [[4, 7], [4, 8], [5, 7], [5, 8], [4, 13], [4, 14], [5, 13], [5, 14]]
    if (isBlinking) {
      put(eyes.filter(([y]) => y === 5).map(([y, x]) => [y, x + look] as const), 'e')
    } else {
      put(eyes.map(([y, x]) => [y, x + look] as const), 'e')
      put([[4, 7 + look], [4, 13 + look]], 'w')
    }
    put([[7, 9], [7, 12], [8, 10], [8, 11]], 'o')
    if (isWorking) {
      const dots = tick % 4
      corner(['ss.ss.ss', 'ss.ss.ss'].map(row => row.slice(0, dots * 3 - 1)), 's', 18, 0)
    }
    if (kind === 'attention') {
      corner(BANG, 'y', 23)
    }
  }

  return grid.map(row => row.join(''))
}

// Terminal: two stacked pixels per cell, the upper half block's foreground over its background.
function toRasterCells(rows: readonly string[]): string {
  const words = new Uint32Array(WIDTH * (HEIGHT / 2) * 3)
  let i = 0
  for (let y = 0; y < HEIGHT; y += 2) {
    for (let x = 0; x < WIDTH; x += 1) {
      const top = PALETTE[rows[y]?.[x] ?? '.']
      const bottom = PALETTE[rows[y + 1]?.[x] ?? '.']
      const [glyph, fg, bg] =
        top === undefined && bottom === undefined
          ? [0x20, TERMINAL_DEFAULT, TERMINAL_DEFAULT]
          : top === undefined
            ? [0x2584, bottom ?? TERMINAL_DEFAULT, TERMINAL_DEFAULT]
            : [0x2580, top, bottom ?? TERMINAL_DEFAULT]
      words[i++] = glyph
      words[i++] = fg
      words[i++] = bg
    }
  }
  return toBase64(new Uint8Array(words.buffer))
}

// Desktop: one crisp SVG, a rect per horizontal run of one color.
function svgRects(rows: readonly string[]): string {
  const rects: string[] = []
  rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      const ch = row[x] ?? '.'
      let end = x + 1
      while (end < row.length && row[end] === ch) end += 1
      const color = PALETTE[ch]
      if (color !== undefined) {
        rects.push(`<rect x="${x}" y="${y}" width="${end - x}" height="1" fill="#${color.toString(16).padStart(6, '0')}"/>`)
      }
      x = end
    }
  })
  return rects.join('')
}

// The SVG animates itself (SMIL), so a pet frame never redraws the band: redraws replaced the buttons under the pointer.
const IDLE_FRAMES = 12
const svgCache = new Map<string, string>()

function animatedSvg(kind: Pose): string {
  const cacheKey = kind
  const cached = svgCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }
  const count = kind === 'idle' || kind === 'working' ? IDLE_FRAMES : kind === 'sleeping' ? 4 : 2
  const dur = `${(count * PET_TICK_MS) / 1000}s`
  const frames = Array.from({ length: count }, (_, tick) => {
    const start = tick / count
    const end = (tick + 1) / count
    const [values, keyTimes] = tick === 0 ? ['visible;hidden', `0;${end}`] : ['hidden;visible;hidden', `0;${start};${end}`]
    return `<g visibility="${tick === 0 ? 'visible' : 'hidden'}"><animate attributeName="visibility" values="${values}" keyTimes="${keyTimes}" dur="${dur}" repeatCount="indefinite" calcMode="discrete"/>${svgRects(drawDog(kind, tick))}</g>`
  })
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH * PIXEL_PX}" height="${HEIGHT * PIXEL_PX}" shape-rendering="crispEdges">${frames.join('')}</svg>`
  svgCache.set(cacheKey, svg)
  return svg
}

async function react($: EngineInterface, kind: MoodKind, text: string, ms: number) {
  const now = await $.clock.now()
  await update($, moodAtom, () => ({ kind, text, until: now + ms }))
}


const PROGRESS_W = 180
const PROGRESS_H = 10

// A rounded track with the done share filled; the fill eases in on each redraw.
function progressSvg(done: number, total: number): string {
  const pct = percentOf(done, total)
  const fill = Math.max(pct > 0 ? PROGRESS_H : 0, Math.round((pct / 100) * PROGRESS_W))
  const r = PROGRESS_H / 2
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${PROGRESS_W} ${PROGRESS_H}" width="${PROGRESS_W}" height="${PROGRESS_H}">` +
    `<defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#4ade80"/><stop offset="1" stop-color="#16a34a"/></linearGradient></defs>` +
    `<rect width="${PROGRESS_W}" height="${PROGRESS_H}" rx="${r}" fill="#808080" fill-opacity="0.25"/>` +
    `<rect width="${fill}" height="${PROGRESS_H}" rx="${r}" fill="url(#g)">` +
    `<animate attributeName="width" from="0" to="${fill}" dur="0.4s" fill="freeze" calcMode="spline" keySplines="0.2 0 0 1"/></rect>` +
    `</svg>`
  )
}

const miniBar = (done: number, total: number, width: number) => {
  const filled = Math.round((percentOf(done, total) / 100) * width)
  return ['█'.repeat(filled), '░'.repeat(width - filled)] as const
}

const githubAtom = atom({ plugin: 'pixel-pet', key: 'github' } as const, {
  reviews: [],
  reviewCount: 0,
  mine: [],
  fetchedAt: null,
  error: null,
  masterCi: 'none',
  current: null,
} as GitHubView)
const branchAtom = atom({ plugin: 'pixel-pet', key: 'branch' } as const, null as BranchState | null)
const refreshingAtom = atom({ plugin: 'pixel-pet', key: 'isRefreshing' } as const, false)

const ELI5_PROMPT =
  'ELI5 the topic we are discussing right now (use the eli5 skill), then publish the explainer as an Artifact and give me the link.'

type BandElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const GITHUB_POLL_MS = 150_000
const BRANCH_POLL_MS = 20_000
// Direct review asks only: team requests from CODEOWNERS would bury the people waiting on you.
const GITHUB_QUERY = `query {
  reviews: search(query: "is:open is:pr user-review-requested:@me archived:false", type: ISSUE, first: 50) {
    nodes { ... on PullRequest {
      number title url isDraft createdAt additions deletions reviewDecision author { login } repository { name }
      reviewRequests(first: 1) { totalCount }
      timelineItems(itemTypes: REVIEW_REQUESTED_EVENT, last: 1) { nodes { ... on ReviewRequestedEvent { createdAt } } }
    } }
  }
  viewer {
    open: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title url isDraft reviewDecision additions deletions baseRefName headRefName updatedAt
        repository { name }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        latestReviews(first: 8) { nodes { state author { login } } }
      }
    }
    merged: pullRequests(states: MERGED, first: 5, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url mergedAt repository { name } }
    }
  }
}`

// The branch's own PR and master's CI, in the repo this session works in.
const CURRENT_QUERY = `query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef { target { ... on Commit { statusCheckRollup { state } } } }
    pullRequests(headRefName: $branch, states: [OPEN, MERGED], first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number url state repository { name }
        latestReviews(first: 20) { nodes { state author { login } } }
        comments(last: 30) { nodes { body } }
      }
    }
  }
}`

type GraphReview = {
  number: number
  title: string
  url: string
  isDraft: boolean
  createdAt: string
  additions: number
  deletions: number
  reviewDecision: string | null
  author: { login: string } | null
  repository: { name: string }
  reviewRequests: { totalCount: number }
  timelineItems: { nodes: { createdAt?: string }[] }
}

type GraphMine = {
  number: number
  title: string
  url: string
  isDraft: boolean
  reviewDecision: string | null
  additions: number
  deletions: number
  baseRefName: string
  headRefName: string
  updatedAt: string
  repository: { name: string }
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null } }[] }
  latestReviews: { nodes: { state: string; author: { login: string } | null }[] }
}

type GraphMerged = { number: number; title: string; url: string; mergedAt: string; repository: { name: string } }

type GraphCurrent = {
  repository: {
    defaultBranchRef: { target: { statusCheckRollup: { state: string } | null } } | null
    pullRequests: {
      nodes: {
        number: number
        url: string
        state: string
        repository: { name: string }
        latestReviews: { nodes: { state: string; author: { login: string } | null }[] }
        comments: { nodes: { body: string }[] }
      }[]
    }
  } | null
}

const winAtom = atom({ plugin: 'pixel-pet', key: 'win' } as const, null as Win | null)
const pushWatchAtom = atom({ plugin: 'pixel-pet', key: 'pushWatch' } as const, null as PushWatch | null)
const squadAtom = atom({ plugin: 'pixel-pet', key: 'squad' } as const, [] as string[])
const worktreesAtom = atom({ plugin: 'pixel-pet', key: 'worktrees' } as const, null as WorktreeScan | null)
const scanningAtom = atom({ plugin: 'pixel-pet', key: 'isScanningWorktrees' } as const, false)

// The plugin's options: the bots, preview comment and build rules of the repos you work in. Empty turns each off.
const config = {
  extraBots: [] as string[],
  previewMarker: '',
  previewLinkMatch: '',
  globalsFiles: [] as string[],
}

const stringList = (value: unknown) => (Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : [])

const BOTS = /^(coderabbitai|cursor|copilot|github-actions|sonarqubecloud|dependabot)|\[bot\]$/i
const isBot = (login: string) => BOTS.test(login) || config.extraBots.includes(login.toLowerCase())
const FAN_OUT = 4
const DAY_MS = 24 * 3_600_000
const STALE_REVIEW_MS = 14 * DAY_MS
const STALE_DRAFT_MS = 14 * DAY_MS
const WIN_SHOW_MS = 60 * 60_000
// CodeRabbit re-reviews a push in roughly this long.
const CODERABBIT_MS = 15 * 60_000
const PUSH_WATCH_MS = 45 * 60_000
const WORKTREE_PANE = 'bit-worktrees'

const ciOf = (state: string | undefined): CiState =>
  state === 'SUCCESS' ? 'passing' : state === 'FAILURE' || state === 'ERROR' ? 'failing' : state === undefined ? 'none' : 'running'

const formatAge = (ms: number) => {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)


const isFreshReview = (pr: ReviewItem, now: number) => now - pr.waitingSince <= STALE_REVIEW_MS

const isActionableReview = (pr: ReviewItem, now: number) => isFreshReview(pr, now) && !pr.isFanOut && !pr.isAuthorsTurn

// A Link with an href the surface refuses would refuse the whole band, so only clean https URLs pass.
const safeUrl = (url: string | undefined): string | null => {
  if (url === undefined || url.length > 2048 || !/^https:\/\/[\x21-\x7e]+$/.test(url) || url.includes('@')) return null
  try {
    return new URL(url).href === url ? url : null
  } catch {
    return null
  }
}

// Previous poll, so Bit reacts to changes only; a reload starts quiet.
const seen = {
  mine: null as Map<string, MyPr> | null,
  reviews: null as Set<string> | null,
  mergedAt: null as number | null,
}

// Per-load facts from session.start: the repo this session works in and its build rules.
const cockpitLocal = {
  repo: null as { owner: string; name: string } | null,
  globals: new Set<string>(),
  dismissOnPush: false,
}

async function startCockpit($: EngineInterface) {
  const storedSquad = await $.store.get('squad')
  const squad = Array.isArray(storedSquad) ? storedSquad.filter((login): login is string => typeof login === 'string') : []
  await update($, squadAtom, () => squad)

  const remote = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: 10_000 }).catch(() => null)
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote?.stdout.trim() ?? '')
  cockpitLocal.repo = match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null

  const root = await $.session.root()
  const globals = new Set<string>()
  for (const file of config.globalsFiles) {
    const path = `${root}/${file}`
    if (!(await $.fs.exists(path))) continue
    const block = /GLOBALS=\(([\s\S]*?)\)/.exec(String(await $.fs.read(path)))?.[1] ?? ''
    for (const entry of block.split(/\s+/)) {
      if (entry !== '' && !entry.startsWith('#')) globals.add(entry)
    }
  }
  cockpitLocal.globals = globals

  if (cockpitLocal.repo !== null) {
    const { owner, name } = cockpitLocal.repo
    const repo = await $.process.run(['gh', 'api', `repos/${owner}/${name}`, '--jq', '.default_branch'], { timeoutMs: 20_000 }).catch(() => null)
    const base = repo?.exitCode === 0 ? repo.stdout.trim() : 'master'
    const rules = await $.process.run(['gh', 'api', `repos/${owner}/${name}/rules/branches/${base}`], { timeoutMs: 20_000 }).catch(() => null)
    try {
      const parsed = rules?.exitCode === 0 ? (JSON.parse(rules.stdout) as { type: string; parameters?: { dismiss_stale_reviews_on_push?: boolean } }[]) : []
      cockpitLocal.dismissOnPush = parsed.some(rule => rule.type === 'pull_request' && rule.parameters?.dismiss_stale_reviews_on_push === true)
    } catch {
      cockpitLocal.dismissOnPush = false
    }
  }
}

async function fetchCurrent($: EngineInterface): Promise<{ masterCi: CiState; current: CurrentPr | null }> {
  const branch = await read($, branchAtom)
  if (cockpitLocal.repo === null || branch === null) {
    return { masterCi: 'none', current: null }
  }
  const { owner, name } = cockpitLocal.repo
  const ran = await $.process
    .run(['gh', 'api', 'graphql', '-f', `query=${CURRENT_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-f', `branch=${branch.name}`], {
      timeoutMs: 30_000,
    })
    .catch(() => null)
  if (ran === null || ran.exitCode !== 0) {
    return { masterCi: 'none', current: null }
  }
  try {
    const repo = (JSON.parse(ran.stdout) as { data: GraphCurrent }).data.repository
    const pr = repo?.pullRequests.nodes[0]
    const published = config.previewMarker === '' ? undefined : pr?.comments.nodes.findLast(comment => comment.body.includes(config.previewMarker))
    const previewUrl = safeUrl(published?.body.match(/https:\/\/[^\s)\]"'<>]+/g)?.find(url => url.includes(config.previewLinkMatch)))
    return {
      masterCi: ciOf(repo?.defaultBranchRef?.target.statusCheckRollup?.state),
      current:
        pr === undefined
          ? null
          : {
              key: `${pr.repository.name}#${pr.number}`,
              url: pr.url,
              approvals: pr.latestReviews.nodes.filter(review => review.state === 'APPROVED' && !isBot(review.author?.login ?? '')).length,
              previewUrl,
              isMerged: pr.state === 'MERGED',
            },
    }
  } catch {
    return { masterCi: 'none', current: null }
  }
}

async function refreshGitHub($: EngineInterface): Promise<string> {
  const now = await $.clock.now()
  const ran = await $.process.run(['gh', 'api', 'graphql', '-f', `query=${GITHUB_QUERY}`], { timeoutMs: 30_000 }).catch(() => null)
  if (ran === null || ran.exitCode !== 0) {
    const reason = ran === null ? 'gh is not installed' : firstLine(ran.stderr || 'gh failed', 80)
    await update($, githubAtom, view => ({ ...view, error: reason }))
    $.ui.log(`pixel-pet: gh failed: ${reason}`, { to: 'debug' })
    return `GitHub: ${reason}`
  }
  let data: {
    reviews: { nodes: GraphReview[] }
    viewer: { open: { nodes: GraphMine[] }; merged: { nodes: GraphMerged[] } }
  }
  try {
    data = (JSON.parse(ran.stdout) as { data: typeof data }).data
  } catch {
    await update($, githubAtom, view => ({ ...view, error: 'unreadable gh answer' }))
    return 'GitHub: unreadable gh answer'
  }

  const squad = new Set(await read($, squadAtom))
  const reviews: ReviewItem[] = data.reviews.nodes
    .filter(pr => pr.number !== undefined && !pr.isDraft)
    .map(pr => {
      const author = pr.author?.login ?? 'someone'
      const isSquad = squad.has(author)
      return {
        key: `${pr.repository.name}#${pr.number}`,
        repo: pr.repository.name,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author,
        waitingSince: Date.parse(pr.timelineItems.nodes.at(-1)?.createdAt ?? pr.createdAt),
        size: pr.additions + pr.deletions,
        isSquad,
        isFanOut: !isSquad && pr.reviewRequests.totalCount >= FAN_OUT,
        isAuthorsTurn: pr.reviewDecision === 'CHANGES_REQUESTED',
      }
    })
    .sort((a, b) => Number(b.isSquad) - Number(a.isSquad) || a.waitingSince - b.waitingSince)

  const mine: MyPr[] = data.viewer.open.nodes.map(pr => ({
    key: `${pr.repository.name}#${pr.number}`,
    repo: pr.repository.name,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    ci: ciOf(pr.commits.nodes[0]?.commit.statusCheckRollup?.state),
    review: pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending',
    isBotBlocking: pr.latestReviews.nodes.some(
      review => review.state === 'CHANGES_REQUESTED' && (review.author?.login ?? '').startsWith('coderabbit'),
    ),
    size: pr.additions + pr.deletions,
    isStacked: pr.baseRefName !== 'master' && pr.baseRefName !== 'main',
    headRef: pr.headRefName,
    isMergeable: false,
    updatedAt: Date.parse(pr.updatedAt),
  }))
  // GitHub computes mergeability per PR, too slow for the whole list (the query times out), so only merge candidates ask.
  await Promise.all(
    mine
      .filter(pr => !pr.isDraft && pr.review === 'approved' && pr.ci === 'passing' && !pr.isStacked)
      .map(async pr => {
        const view = await $.process.run(['gh', 'pr', 'view', pr.url, '--json', 'mergeable'], { timeoutMs: 30_000 }).catch(() => null)
        try {
          pr.isMergeable = view?.exitCode === 0 && (JSON.parse(view.stdout) as { mergeable?: string }).mergeable === 'MERGEABLE'
        } catch {
          pr.isMergeable = false
        }
      }),
  )

  if (seen.mine !== null) {
    for (const pr of mine) {
      const before = seen.mine.get(pr.key)
      if (before === undefined) continue
      if (before.ci !== 'failing' && pr.ci === 'failing') {
        await react($, 'sad', `CI failed on ${pr.key} ${pr.title}`, 10_000)
      } else if (before.review !== 'approved' && pr.review === 'approved') {
        await react($, 'happy', `Approved: ${pr.key} ${pr.title}`, 8000)
      } else if (before.ci !== 'passing' && pr.ci === 'passing') {
        await react($, 'happy', `CI green on ${pr.key}`, 5000)
      }
    }
  }
  if (seen.reviews !== null) {
    for (const pr of reviews) {
      if (!seen.reviews.has(pr.key) && isActionableReview(pr, now)) {
        $.ui.toast(`${pr.author} asked for your review: ${pr.key} ${clip(pr.title, 60)}`)
      }
    }
  }
  const mergedTimes = data.viewer.merged.nodes.map(pr => Date.parse(pr.mergedAt))
  if (seen.mergedAt !== null) {
    const latest = data.viewer.merged.nodes.find(pr => Date.parse(pr.mergedAt) > (seen.mergedAt ?? 0))
    if (latest !== undefined) {
      const win: Win = { key: `${latest.repository.name}#${latest.number}`, title: latest.title, url: latest.url, at: Date.parse(latest.mergedAt) }
      await update($, winAtom, () => win)
      await react($, 'happy', `Merged! ${win.key} ${win.title}`, 10_000)
    }
  }
  seen.mine = new Map(mine.map(pr => [pr.key, pr]))
  seen.reviews = new Set(reviews.map(pr => pr.key))
  seen.mergedAt = Math.max(seen.mergedAt ?? 0, ...mergedTimes)

  const { masterCi, current } = await fetchCurrent($)
  const reviewCount = reviews.filter(pr => isActionableReview(pr, now)).length
  await update($, githubAtom, () => ({ reviews, reviewCount, mine, fetchedAt: now, error: null, masterCi, current }))
  return `${reviewCount} PRs waiting on you · ${mine.length} open PRs of yours`
}

async function toggleCollapsed($: EngineInterface) {
  const isCollapsed = await update($, collapsedAtom, collapsed => !collapsed)
  await $.store.set('isCollapsed', isCollapsed)
}

async function scrollSessions($: EngineInterface, by: number) {
  const last = Math.max(0, local.sessionsTotal - local.sessionsShown)
  // The list can shrink under a stored offset, so clamp before moving.
  const offset = Math.min(await read($, sessionsOffsetAtom), last)
  const moved = Math.min(last, Math.max(0, offset + by))
  if (moved !== (await read($, sessionsOffsetAtom))) {
    await update($, sessionsOffsetAtom, () => moved)
  }
}

async function refreshAll($: EngineInterface) {
  if (await read($, refreshingAtom)) {
    return
  }
  await update($, refreshingAtom, () => true)
  try {
    await refreshBranch($)
    const [github] = await Promise.all([refreshGitHub($), refreshOthers($)])
    $.ui.toast(`Refreshed: ${github}`)
  } finally {
    await update($, refreshingAtom, () => false)
  }
}

async function refreshBranch($: EngineInterface) {
  if (local.isDemo) {
    return
  }
  const git = (...args: string[]) => $.process.run(['git', ...args], { timeoutMs: 10_000 }).catch(() => null)
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (head === null || head.exitCode !== 0) {
    await update($, branchAtom, () => null)
    return
  }
  const name = head.stdout.trim()
  const status = await git('status', '--porcelain')
  let base = 'origin/master'
  let counts = await git('rev-list', '--left-right', '--count', `${base}...HEAD`)
  if (counts === null || counts.exitCode !== 0) {
    base = 'origin/main'
    counts = await git('rev-list', '--left-right', '--count', `${base}...HEAD`)
  }
  const [behind = 0, ahead = 0] = counts?.exitCode === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : []
  const ticket = /(?:^|[^a-z])([a-z]{2,6})-(\d{2,6})(?![a-z0-9])/i.exec(name)
  const statusLines = status?.exitCode === 0 ? status.stdout.split('\n').filter(line => line.trim() !== '') : []
  const diff = cockpitLocal.globals.size > 0 ? await git('diff', '--name-only', `${base}...HEAD`) : null
  const touched = new Set([
    ...(diff?.exitCode === 0 ? diff.stdout.split('\n') : []),
    ...statusLines.map(line => line.slice(3).trim()),
  ])
  const branch: BranchState = {
    name,
    ticket: ticket ? `${ticket[1]?.toUpperCase()}-${ticket[2]}` : null,
    changed: statusLines.length,
    ahead,
    behind,
    globals: [...touched].filter(path => cockpitLocal.globals.has(path)),
    hasSlash: name.includes('/'),
  }
  const current = await read($, branchAtom)
  if (JSON.stringify(current) !== JSON.stringify(branch)) {
    await update($, branchAtom, () => branch)
  }
}

// ---- one-click actions: each asks first, then runs gh or git ----

async function confirm($: EngineInterface, question: string, yes: string): Promise<boolean> {
  try {
    return (await $.ui.ask(question, [yes, 'Cancel'])) === yes
  } catch {
    return false
  }
}

async function run($: EngineInterface, argv: string[], done: string): Promise<boolean> {
  const ran = await $.process.run(argv, { timeoutMs: 120_000 }).catch(() => null)
  if (ran === null || ran.exitCode !== 0) {
    $.ui.toast(`${argv.slice(0, 3).join(' ')} failed: ${firstLine(ran?.stderr || ran?.stdout || 'could not run', 140)}`, { timeoutMs: 10_000 })
    return false
  }
  $.ui.toast(done)
  return true
}

function watchImpact($: EngineInterface, win: Win) {
  void $.prompt.submit({
    text: `${win.key} "${win.title}" (${win.url}) merged at ${new Date(win.at).toISOString()}. Babysit it: 1) confirm it reached production (deploy or variant promote; check the deploy or release it shipped in), 2) read the PR and its ticket to name the user-facing metric it should move, 3) query the analytics read-only for that metric before vs since the release, with enough traffic to read it, 4) give me a one-line verdict (moved / flat / too early) and when to re-check. Change nothing.`,
    asUser: true,
  })
}

const SLACK_UPDATE_PROMPT =
  'Write a Slack update about what we did in this session: what changed, why, and what is next, with PR and ticket links. Use my Slack update skill for the voice and the channel, if I have one. Put it in Slack as a draft for me to send; do not send it.'

const TICKET_PROMPT =
  'Draft a Linear ticket for the work in this session, following my ticket conventions. Show me the draft first; create nothing until I say so.'

// One-click skill runs: each button sends its prompt as if typed, so the skill's own rules and confirmations apply.
const SKILL_PROMPTS = {
  check:
    'Run the lint and type checks for the domains this branch touches (the same checks the pre-push hooks run), without pushing. Report what fails and fix it.',
  screens: "Take before and after screenshots of what this branch changes on screen and add them to its PR.",
  acceptance: "Prepare this branch's PR for acceptance: wait for its preview link, then draft the message that asks the reviewers to try it.",
  babysit: "Watch this branch's PR until it merges: fix failing checks and answer review comments, then push again.",
  remember:
    'Save the non-obvious learnings from this session to my memory, following my memory rules (one fact per file, update an existing file before adding one, index it in MEMORY.md). Show me what you saved.',
} as const

const MODELS_TO_SWITCH = ['Opus', 'Sonnet', 'Fable', 'Haiku']

async function switchModel($: EngineInterface) {
  let choice: string
  try {
    choice = await $.ui.ask('Switch the model to?', { options: MODELS_TO_SWITCH, header: 'Model' })
  } catch {
    return
  }
  if (MODELS_TO_SWITCH.includes(choice)) {
    await $.command.run({ command: 'model', args: choice.toLowerCase() })
  }
}

async function shipWithDone($: EngineInterface) {
  if (await confirm($, 'Ship this work? It commits, pushes and opens a draft PR.', 'Ship')) {
    void $.prompt.submit({ text: 'Ship this work: commit it, push the branch and open a draft PR.', asUser: true })
  }
}

// ---- Actions: one favorite on the band, the rest in a pane ----

const ACTIONS_PANE = 'bit-actions'
const DEFAULT_ACTION = 'eli5'

type Action = {
  id: string
  label: string
  hint: string
  // Sends a prompt as if typed, so it waits for the turn to end.
  prompt: string | null
}

const prompted = (id: string, label: string, hint: string, prompt: string): Action => ({ id, label, hint, prompt })
const direct = (id: string, label: string, hint: string): Action => ({ id, label, hint, prompt: null })

const ACTIONS: readonly Action[] = [
  prompted('eli5', 'ELI5', 'explain the topic simply', ELI5_PROMPT),
  prompted('slack', 'slack', 'draft a Slack update', SLACK_UPDATE_PROMPT),
  direct('done', 'done', 'commit, push, open a PR'),
  prompted('ticket', 'ticket', 'draft a Linear ticket', TICKET_PROMPT),
  prompted('check', 'check', 'lint and type checks', SKILL_PROMPTS.check),
  prompted('screens', 'screens', 'PR before/after shots', SKILL_PROMPTS.screens),
  prompted('accept', 'accept', 'acceptance flow', SKILL_PROMPTS.acceptance),
  prompted('babysit', 'babysit', 'watch the PR to merge', SKILL_PROMPTS.babysit),
  prompted('remember', 'remember', 'save session learnings', SKILL_PROMPTS.remember),
  direct('model', 'model', 'switch model'),
  direct('plan', 'plan', 'plan pane'),
  direct('critique', 'critique', 'self-critique pane'),
  direct('refresh', 'refresh', 'GitHub and branch'),
  direct('worktrees', 'worktrees', 'worktree janitor'),
  direct('demo', 'demo', 'made-up band for screenshots'),
  direct('hide', 'hide', 'hide the band'),
]

// done and model send a prompt or a command after a question, so they wait for the turn too.
const needsIdle = (action: Action) => action.prompt !== null || action.id === 'done' || action.id === 'model'

const favoriteAtom = atom({ plugin: 'pixel-pet', key: 'favoriteAction' } as const, DEFAULT_ACTION)

const actionById = (id: string) => ACTIONS.find(action => action.id === id) ?? ACTIONS[0]!

// The model row names the model in use, so its label is live.
const actionLabel = (action: Action, usage: CacheKeeperUsage | null) =>
  action.id === 'model' ? (usage?.model || 'model').replace(/^claude-/, '') : action.label

async function setFavorite($: EngineInterface, id: string) {
  await update($, favoriteAtom, () => id)
  await $.store.set('favoriteAction', id)
}

function runAction($: EngineInterface, action: Action, isWorking: boolean) {
  if (needsIdle(action) && isWorking) {
    return
  }
  if (action.prompt !== null) {
    void $.prompt.submit({ text: action.prompt, asUser: true })
  } else if (action.id === 'done') {
    void shipWithDone($)
  } else if (action.id === 'model') {
    void switchModel($)
  } else if (action.id === 'plan') {
    void openPane($, 'plan')
  } else if (action.id === 'critique') {
    void $.ui.open({ id: CRITIQUE_PANE, title: CRITIQUE_TITLE })
    launchCritique($)
  } else if (action.id === 'refresh') {
    void refreshAll($)
  } else if (action.id === 'worktrees') {
    void openWorktrees($)
  } else if (action.id === 'hide') {
    void update($, hiddenAtom, () => true)
  } else if (action.id === 'demo') {
    void (local.isDemo ? stopBandDemo($) : startBandDemo($))
  }
  if (needsIdle(action)) {
    void $.ui.close({ id: ACTIONS_PANE })
  }
}

function logWin($: EngineInterface, win: Win) {
  void $.prompt.fill({
    text: `Add an Impact Log entry to my Notion Impact Log for ${win.key} "${win.title}" (${win.url}): what it changed and why it matters. Show me the row before you write it.`,
  })
}

function draftCodeRabbitReplies($: EngineInterface, watch: PushWatch) {
  void $.prompt.fill({
    text: `Read CodeRabbit's open comments on ${watch.key} (${watch.url}) and draft my replies with @coderabbitai: fix what is right, push back with facts where it is wrong. Show me the drafts; do not post them.`,
  })
}

// ---- push and Bash guards ----

type FailureCause = { label: string; fix: string | null }

function classifyFailure(output: string, masterCi: CiState): FailureCause | null {
  if (/core\.bare|must be run in a work tree/i.test(output)) {
    return { label: 'core.bare=true breaks this worktree', fix: 'git config --local core.bare false' }
  }
  if (/ERR_PNPM|node_modules\/\.pnpm|Cannot find module|command not found: (vitest|tsc|eslint)/i.test(output)) {
    return { label: 'stale pnpm install', fix: 'CI=true pnpm install --frozen-lockfile' }
  }
  if (/ruff/i.test(output) && /(unknown|invalid|deprecated|removed)[^\n]*(rule|setting|option)|ruff[^\n]*version/i.test(output)) {
    return { label: 'ruff version drift', fix: 'uv sync --frozen' }
  }
  if (/\[rejected\]|non-fast-forward|fetch first/i.test(output)) {
    return { label: 'the remote branch moved', fix: 'git pull --rebase' }
  }
  if (/lefthook/i.test(output) && masterCi === 'failing') {
    return { label: 'master CI is red, so this is likely not your change', fix: null }
  }
  if (/lefthook/i.test(output)) {
    return { label: 'a lefthook check failed', fix: null }
  }
  return null
}

const outputOf = (ran: { text?: string; result?: unknown }) => {
  const result = ran.result as { stdout?: string; stderr?: string } | undefined
  return [ran.text ?? '', result?.stdout ?? '', result?.stderr ?? ''].join('\n')
}

async function pushGuard($: EngineInterface): Promise<string | null> {
  const current = (await read($, githubAtom)).current
  if (!cockpitLocal.dismissOnPush || current === null || current.approvals === 0) {
    return null
  }
  const plural = current.approvals === 1 ? '' : 's'
  const isAllowed = await confirm(
    $,
    `This push dismisses ${current.approvals} approval${plural} on ${current.key} (the repo dismisses stale reviews on push). Push anyway?`,
    'Push',
  )
  return isAllowed ? null : `Push stopped in Bit: it would dismiss ${current.approvals} approval${plural} on ${current.key}. Ask the user before pushing again.`
}

async function startPushWatch($: EngineInterface) {
  const current = (await read($, githubAtom)).current
  if (current !== null) {
    const at = await $.clock.now()
    await update($, pushWatchAtom, () => ({ key: current.key, url: current.url, at }))
  }
}

async function checkLockfile($: EngineInterface) {
  const status = await $.process.run(['git', 'status', '--porcelain'], { timeoutMs: 10_000 }).catch(() => null)
  const paths = status?.exitCode === 0 ? status.stdout.split('\n').map(line => line.slice(3).trim()) : []
  const lockfiles = paths.filter(path => path.endsWith('pnpm-lock.yaml'))
  if (lockfiles.length > 0 && !paths.some(path => path.endsWith('package.json'))) {
    $.ui.toast(`pnpm rewrote ${lockfiles.join(', ')} with no package.json change. Revert it: git checkout -- ${lockfiles.join(' ')}`, { timeoutMs: 15_000 })
  }
}

async function ticketTitle($: EngineInterface): Promise<string | null> {
  const head = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { timeoutMs: 10_000 }).catch(() => null)
  const name = head?.exitCode === 0 ? head.stdout.trim() : ''
  const ticket = /(?:^|[^a-z])([a-z]{2,6})-(\d{2,6})(?![a-z0-9])/i.exec(name)
  if (!ticket?.[1] || !ticket[2]) {
    return null
  }
  const id = `${ticket[1].toUpperCase()}-${ticket[2]}`
  const rest = name
    .replace(/^.*\//, '')
    .replace(new RegExp(`${ticket[1]}-${ticket[2]}`, 'i'), '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return rest === '' ? id : `${id} ${rest}`
}

// ---- worktree janitor ----

async function refreshWorktrees($: EngineInterface) {
  if (await read($, scanningAtom)) {
    return
  }
  await update($, scanningAtom, () => true)
  try {
    const list = await $.process.run(['git', 'worktree', 'list', '--porcelain'], { timeoutMs: 30_000 })
    const entries = list.stdout
      .split('\n\n')
      .map(block => {
        const path = /^worktree (.+)$/m.exec(block)?.[1] ?? ''
        const branch = /^branch refs\/heads\/(.+)$/m.exec(block)?.[1] ?? '(detached)'
        return { path, branch }
      })
      .filter(entry => entry.path !== '')
    const merged = new Set<string>()
    const prs = await $.process
      .run(['gh', 'pr', 'list', '--author', '@me', '--state', 'merged', '--limit', '300', '--json', 'headRefName'], { timeoutMs: 60_000 })
      .catch(() => null)
    if (prs?.exitCode === 0) {
      for (const pr of JSON.parse(prs.stdout) as { headRefName: string }[]) merged.add(pr.headRefName)
    }
    const root = await $.session.root()
    const rows: WorktreeRow[] = []
    for (let i = 0; i < entries.length; i += 8) {
      const chunk = await Promise.all(
        entries.slice(i, i + 8).map(async (entry, offset) => {
          const log = await $.process.run(['git', '-C', entry.path, 'log', '-1', '--format=%ct'], { timeoutMs: 10_000 }).catch(() => null)
          return {
            path: entry.path,
            branch: entry.branch,
            lastCommitAt: log?.exitCode === 0 ? Number(log.stdout.trim()) * 1000 : 0,
            isMerged: merged.has(entry.branch),
            isMain: i + offset === 0,
            isCurrent: entry.path === root,
          }
        }),
      )
      rows.push(...chunk)
    }
    const bare = await $.process.run(['git', 'config', '--get', 'core.bare'], { timeoutMs: 10_000 }).catch(() => null)
    const scannedAt = await $.clock.now()
    await update($, worktreesAtom, () => ({ rows, isBare: bare?.stdout.trim() === 'true', scannedAt }))
  } catch (error) {
    $.ui.toast(`Worktree scan failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    await update($, scanningAtom, () => false)
  }
}

async function removeWorktree($: EngineInterface, row: WorktreeRow) {
  const tail = row.path.split('/').slice(-2).join('/')
  if (!(await confirm($, `Remove the worktree ${tail}? Branch ${row.branch} stays; git refuses if it has changes.`, 'Remove'))) {
    return
  }
  if (await run($, ['git', 'worktree', 'remove', row.path], `Removed ${tail}`)) {
    await update($, worktreesAtom, scan => (scan === null ? scan : { ...scan, rows: scan.rows.filter(one => one.path !== row.path) }))
  }
}

async function fixBare($: EngineInterface) {
  if (await confirm($, 'Set core.bare to false in this repo? Every worktree needs it.', 'Fix')) {
    if (await run($, ['git', 'config', '--local', 'core.bare', 'false'], 'core.bare is false again')) await refreshWorktrees($)
  }
}

async function openWorktrees($: EngineInterface) {
  await $.ui.open({ id: WORKTREE_PANE, title: 'Worktrees' })
  await refreshWorktrees($)
}

// ---- /bit: lead rituals on demand ----

async function runBit($: EngineInterface, args: string): Promise<string> {
  const [sub = '', ...rest] = args.trim().split(/\s+/)
  const squad = await read($, squadAtom)
  const ask = (text: string) => void $.prompt.submit({ text, asUser: true })
  if (sub === 'recap') {
    ask(
      `Weekly recap for me: with read-only gh queries on the repos I work in, list what I merged and reviewed in the last 7 days and what is still open or blocked. Keep it to a short list I can paste into Slack. Post nothing.`,
    )
    return 'Bit: writing your weekly recap…'
  }
  if (sub === '1on1') {
    const login = rest[0]
    if (login === undefined) return 'Usage: /bit 1on1 <github-login>'
    ask(
      `Prepare 1:1 notes for ${login}: with read-only gh queries, their PRs in the last 14 days (merged, open, waiting on review, size), the review wait they got, and 2-3 topics to discuss. Name items, not performance scores.`,
    )
    return `Bit: preparing 1:1 notes for ${login}…`
  }
  if (sub === 'concentration') {
    ask(
      `Show who reviewed the squad's merged PRs in the repos I work in over the last 30 days (squad: ${squad.join(', ')}), bots excluded, and suggest which peer could take first reviews off me. Read-only gh only.`,
    )
    return 'Bit: checking review concentration…'
  }
  if (sub === 'impact') {
    const target = rest[0]
    if (target === undefined) return 'Usage: /bit impact <PR url or repo#number>'
    ask(
      `Babysit ${target} after its merge: confirm it reached production, name the user-facing metric it should move from the PR and its ticket, query the analytics read-only before vs since the release, and give a one-line verdict (moved / flat / too early) with when to re-check. Change nothing.`,
    )
    return `Bit: watching the impact of ${target}…`
  }
  if (sub === 'worktrees') {
    await openWorktrees($)
    return 'Bit: worktrees pane opened.'
  }
  if (sub === 'squad') {
    const [action, ...logins] = rest
    if ((action === 'add' || action === 'remove') && logins.length > 0) {
      const next = action === 'add' ? [...new Set([...squad, ...logins])] : squad.filter(one => !logins.includes(one))
      await update($, squadAtom, () => next)
      await $.store.set('squad', next)
      void refreshGitHub($)
      return `Bit: squad is now ${next.join(', ') || '(empty)'}.`
    }
    return `Bit: squad is ${squad.join(', ') || '(empty)'}. Change it with /bit squad add|remove <login> [<login>...].`
  }
  if (sub === 'demo') {
    if (rest[0] === 'off') {
      await stopBandDemo($)
      return 'Bit: demo off. The band shows your real sessions and Slack again.'
    }
    await startBandDemo($)
    return 'Bit: demo on. The band shows made-up sessions, Slack and a plan; nothing was sent anywhere. /bit demo off ends it.'
  }
  if (sub === 'slack' && rest[0] === 'test') {
    const now = await $.clock.now()
    const sample: SlackItem = {
      ts: `${TEST_TS_PREFIX}${now}`,
      from: 'Bit',
      where: 'test',
      channelId: 'test',
      convo: 'Bit (test)',
      text: 'This is a test message. In 15 seconds the line goes back to your conversations.',
      url: null,
      seenAt: now,
    }
    await update($, slackAtom, view => ({ ...view, unread: [...view.unread, sample].slice(-SLACK_UNREAD_MAX) }))
    $.ui.toast(`Slack · ${sample.from} (${sample.where}): ${sample.text}`, { timeoutMs: 15_000 })
    scheduleSlackFade($)
    return 'Bit: test Slack message shown. Nothing was sent to Slack.'
  }
  if (sub === 'slack') {
    const server = rest.join(' ')
    if (server !== '') {
      await $.store.set('slackServer', server)
      slackLocal.server = null
    }
    if (slackLocal.server === null) {
      slackLocal.attempts = 0
      await startSlack($)
    }
    return slackLocal.server === null
      ? `Bit: no Slack connector answered (${(await read($, slackAtom)).error ?? 'no reason given'}). Give its name as /mcp lists it: /bit slack <name>.`
      : `Bit: Slack alerts on through "${slackLocal.server}".${slackLocal.lastError === null ? '' : ` Last search error: ${slackLocal.lastError}`}`
  }
  return 'Usage: /bit recap | 1on1 <login> | concentration | impact <pr> | worktrees | squad [add|remove <login>...] | slack [test | <server name>] | demo [off]'
}

// ---- Slack: DMs and @-mentions, read-only, through the session's Slack connector ----

const slackAtom = atom({ plugin: 'pixel-pet', key: 'slack' } as const, { unread: [], error: null } as SlackView)
// Per conversation (channel id): your latest message there, and what you dismissed with clear. Shared via the store.
// Versioned: a session still running an older Bit polls on its old keys and never mixes formats with this one.
const SLACK_KEYS = {
  items: 'slack.v3.items',
  polledAt: 'slack.v3.polledAt',
  marks: 'slack.v3.marks',
  alertedTs: 'slack.v3.alertedTs',
} as const

const slackMarksAtom = atom({ plugin: 'pixel-pet', key: 'slackMarks' } as const, { replied: {}, dismissed: {} } as SlackMarks)

type SlackConversation = { channelId: string; name: string; count: number; latestTs: number; url: string | null; waiting: SlackItem[] }

// The connector exposes no read marker, so a conversation you only read elsewhere ages out instead.
const SLACK_ROW_MAX_AGE_MS = 2 * 3600 * 1000

// Like the sidebar: each conversation with the messages that came after your last reply (or your last clear),
// while its newest message is under two hours old.
function slackConversations(view: SlackView, marks: SlackMarks, now: number): SlackConversation[] {
  const byChannel = new Map<string, SlackConversation>()
  for (const item of view.unread) {
    if (typeof item.channelId !== 'string' || !item.convo) continue
    const ts = slackTime(item)
    const handledAt = Math.max(Number(marks.replied[item.channelId] ?? 0), Number(marks.dismissed[item.channelId] ?? 0))
    if (ts <= handledAt) continue
    const convo = byChannel.get(item.channelId) ?? { channelId: item.channelId, name: item.convo, count: 0, latestTs: 0, url: null, waiting: [] }
    convo.count += 1
    if (item.text !== '') convo.waiting.push(item)
    if (ts >= convo.latestTs) {
      convo.latestTs = ts
      convo.url = item.url
    }
    byChannel.set(item.channelId, convo)
  }
  return [...byChannel.values()]
    .filter(convo => now - convo.latestTs * 1000 < SLACK_ROW_MAX_AGE_MS)
    .sort((a, b) => b.latestTs - a.latestTs)
}

// A Slack ts is seconds; a test message has no real ts, so it uses the moment it was shown.
const slackTime = (item: SlackItem) => (item.ts.startsWith(TEST_TS_PREFIX) ? item.seenAt / 1000 : Number(item.ts))

async function readSlackMarks($: EngineInterface): Promise<SlackMarks> {
  const stored = await $.store.get(SLACK_KEYS.marks)
  const marks = stored !== null && typeof stored === 'object' ? (stored as SlackMarks) : { replied: {}, dismissed: {} }
  return { replied: marks.replied ?? {}, dismissed: marks.dismissed ?? {} }
}

// Dismissing a message marks its conversation read up to that message; anything newer there stays waiting.
async function dismissSlack($: EngineInterface, channelId: string, ts: number) {
  const marks = await readSlackMarks($)
  marks.dismissed[channelId] = String(Math.max(Number(marks.dismissed[channelId] ?? 0), ts))
  await $.store.set(SLACK_KEYS.marks, marks)
  await update($, slackMarksAtom, () => marks)
}

async function clearSlack($: EngineInterface) {
  for (const convo of slackConversations(await read($, slackAtom), await read($, slackMarksAtom), await $.clock.now())) {
    await dismissSlack($, convo.channelId, convo.latestTs)
  }
}

const SLACK_POLL_MS = 60_000
const SLACK_UNREAD_MAX = 60
const SLACK_CONVOS_SHOWN = 3
// Pages per minute-poll (20 messages each), shared by every session: about 6 searches a minute in all.
const SLACK_DM_PAGES = 3
const SLACK_MINE_PAGES = 2
// How far back the conversations reach, like the sidebar's recent DMs.
const SLACK_BACKFILL_S = 24 * 3600
// A new message takes over the line for this long, with a countdown, then the conversations come back.
const SLACK_SHOW_MS = 15_000
const SLACK_DOTS = 5
const SLACK_DOT_MS = SLACK_SHOW_MS / SLACK_DOTS

// The band redraws on a 30s clock, so a new message schedules the redraws its countdown needs.
function scheduleSlackFade($: EngineInterface) {
  for (let step = 1; step <= SLACK_DOTS; step += 1) {
    $.clock.after(step * SLACK_DOT_MS + 200, () => $.ui.invalidate('ui.render'))
  }
}

// Desktop countdown: small pulsing dots that fade out right to left, animated by the SVG itself.
// Negative begin times start it mid-way, so a redraw continues the countdown instead of restarting it.
function countdownSvg(elapsedMs: number): string {
  const elapsed = elapsedMs / 1000
  const step = SLACK_DOT_MS / 1000
  const dots = Array.from({ length: SLACK_DOTS }, (_, i) => {
    const vanishAt = (SLACK_DOTS - i) * step
    return `<circle cx="${5 + i * 9}" cy="6" r="2" fill="#d946ef"><animate attributeName="r" values="2;1.3;2" dur="1.2s" begin="${-elapsed - i * 0.15}s" repeatCount="indefinite"/><animate attributeName="opacity" values="1;0" begin="${vanishAt - elapsed - 0.5}s" dur="0.5s" fill="freeze"/></circle>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 46 12" width="46" height="12">${dots.join('')}</svg>`
}

// The connector's name as /mcp lists it, then its id; /bit slack <name> overrides.
const SLACK_SERVERS = ['Slack', 'claude.ai Slack', 'claude_ai_Slack']
const SLACK_PROFILE_TOOL = /^mcp__(.+)__slack_read_user_profile$/

// Connectors may still be connecting when the session starts, so a failed connect retries.
const SLACK_RETRY_MS = 120_000
const SLACK_RETRIES = 15

const slackLocal = {
  lastError: null as string | null,
  attempts: 0,
  isPolling: false,
  server: null as string | null,
  me: '',
  since: 0,
}

// Slack's after: filter takes a day and is exclusive, so it names the day before the window starts.
const slackDay = (sinceSeconds: number) => new Date((sinceSeconds - 24 * 3600) * 1000).toISOString().slice(0, 10)

// Reads up to `pages` pages of a timestamp-sorted search, stopping once a page reaches past the window.
async function slackSearch($: EngineInterface, args: Record<string, unknown>, pages: number): Promise<string> {
  let body = ''
  let cursor: string | undefined
  for (let page = 0; page < pages; page += 1) {
    let raw: Awaited<ReturnType<typeof slackRaw>>
    try {
      raw = await slackRaw($, 'slack_search_public_and_private', cursor === undefined ? args : { ...args, cursor })
    } catch (error) {
      slackLocal.lastError = error instanceof Error ? error.message : String(error)
      break
    }
    if (raw === null) break
    body += `\n${raw.results}`
    const oldest = parseSlack(raw.results).at(-1)
    cursor = /cursor `([^`]+)`/.exec(raw.pagination)?.[1]
    if (cursor === undefined || oldest === undefined || Number(oldest.ts) < slackLocal.since) break
  }
  return body
}

async function slackRaw($: EngineInterface, tool: string, args: Record<string, unknown>): Promise<{ results: string; pagination: string } | null> {
  if (slackLocal.server === null) {
    return null
  }
  const result = await $.mcp.call(slackLocal.server, tool, args)
  if (result.isError) {
    slackLocal.lastError = firstLine(result.content.map(block => (block.type === 'text' ? block.text : '')).join(' ') || 'search failed', 160)
    return null
  }
  const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
  try {
    const parsed = JSON.parse(text) as { results?: unknown; pagination_info?: unknown }
    return {
      results: typeof parsed.results === 'string' ? parsed.results : text,
      pagination: typeof parsed.pagination_info === 'string' ? parsed.pagination_info : '',
    }
  } catch {
    return { results: text, pagination: '' }
  }
}

function parseSlack(body: string): (Omit<SlackItem, 'seenAt'> & { fromId: string })[] {
  const nameOf = (person: string) => person.replace(/\s*\(ID:.*$/, '').trim()
  return body
    .split(/\n### Result \d+ of \d+\n/)
    .slice(1)
    .map(block => {
      const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1]?.trim() ?? ''
      const from = field('From')
      const channel = field('Channel')
      const where = channel.replace(/\s*\(ID:.*$/, '')
      const sender = from.replace(/\s*[<(].*$/, '')
      const others = field('Participants')
        .split(/\),\s*/)
        .filter(person => person !== '' && !person.includes(slackLocal.me || '\u0000'))
        .map(nameOf)
      return {
        isBot: from.includes('[BOT]'),
        ts: field('Message_ts'),
        from: sender,
        fromId: /\(ID: (U[A-Z0-9]+)\)/.exec(from)?.[1] ?? '',
        where,
        channelId: /\(ID: ([A-Z0-9]+)\)/.exec(channel)?.[1] ?? where,
        convo: where.startsWith('#') ? where : others.length > 0 ? others.join(', ') : sender,
        text: (/\nText:\s*([\s\S]*?)\s*(?:\n---[\s\S]*)?$/.exec(block)?.[1] ?? '')
          .replace(/<@U[A-Z0-9]+\|([^>]+)>/g, '@$1')
          .replace(/\s+/g, ' ')
          .trim(),
        url: safeUrl(/\]\((https:[^)]+)\)/.exec(field('Permalink'))?.[1]?.replace(/\\\//g, '/')),
      }
    })
    .filter(item => item.ts !== '' && !item.isBot)
    .map(({ isBot: _isBot, ...item }) => item)
}

const TEST_TS_PREFIX = 'test-'

// /bit slack test messages live only in this session, so a poll that refreshes the shared list keeps them.
function withLocalTests(shared: SlackItem[], current: readonly SlackItem[]): SlackItem[] {
  return [...sharedItems(shared), ...sharedItems(current.filter(item => item.ts.startsWith(TEST_TS_PREFIX)))].slice(-SLACK_UNREAD_MAX)
}

// Items stored before conversations existed carry no channel id; they are dropped and the next poll refills them.
const sharedItems = (shared: unknown): SlackItem[] =>
  Array.isArray(shared) ? (shared as SlackItem[]).filter(item => typeof item.channelId === 'string') : []

async function startSlack($: EngineInterface) {
  const startMarks = await readSlackMarks($)
  await update($, slackMarksAtom, () => startMarks)
  if (slackLocal.server !== null) {
    return
  }
  slackLocal.attempts += 1
  const stored = await $.store.get('slackServer')
  // A claude.ai connector's server name is an ID that differs per account, so the session's own tool list names it.
  const listed = (await $.tool.list().catch(() => []))
    .map(tool => SLACK_PROFILE_TOOL.exec(tool.name)?.[1])
    .filter((server): server is string => server !== undefined)
  const candidates = [...new Set([...(typeof stored === 'string' ? [stored] : []), ...listed, ...SLACK_SERVERS])]
  const failures: string[] = []
  for (const server of candidates) {
    try {
      // Only the detailed profile carries the user ID; without it your own messages would count as waiting.
      const result = await $.mcp.call(server, 'slack_read_user_profile', { response_format: 'detailed' })
      if (result.isError) {
        const reason = result.content.map(block => (block.type === 'text' ? block.text : '')).join(' ')
        failures.push(`${server}: ${firstLine(reason || 'tool error', 300)}`)
        continue
      }
      const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
      const me = /User ID: (U[A-Z0-9]+)/.exec(text)?.[1] ?? ''
      if (me === '') {
        failures.push(`${server}: the profile has no user ID`)
        continue
      }
      slackLocal.server = server
      slackLocal.me = me
      await $.store.set('slackServer', server)
      break
    } catch (error) {
      failures.push(`${server}: ${firstLine(error instanceof Error ? error.message : String(error), 300)}`)
    }
  }
  if (slackLocal.server === null) {
    const reason = failures.join(' | ')
    $.ui.log(`pixel-pet: no Slack connector answered: ${reason}`, { to: 'debug' })
    await update($, slackAtom, (view): SlackView => ({ ...view, error: reason }))
    if (slackLocal.attempts < SLACK_RETRIES) {
      $.clock.after(SLACK_RETRY_MS, () => void startSlack($))
    }
    return
  }
  slackLocal.since = Math.floor((await $.clock.now()) / 1000) - SLACK_BACKFILL_S
  await update($, slackAtom, (view): SlackView => ({ ...view, error: null }))
  void pollSlack($)
  if (!slackLocal.isPolling) {
    slackLocal.isPolling = true
    $.clock.every(SLACK_POLL_MS, () => void pollSlack($))
  }
}

// Every session running Bit shares one poll per minute through the plugin store, so parallel sessions add no Slack calls and alert once.
async function pollSlack($: EngineInterface) {
  const marks = await readSlackMarks($)
  const now = await $.clock.now()
  const polledAt = Number((await $.store.get(SLACK_KEYS.polledAt)) ?? 0)
  if (now - polledAt < SLACK_POLL_MS - 10_000) {
    const shared = await $.store.get(SLACK_KEYS.items)
    await update($, slackAtom, view => ({ ...view, unread: Array.isArray(shared) ? withLocalTests(shared as SlackItem[], view.unread) : view.unread }))
    await update($, slackMarksAtom, () => marks)
    return
  }
  await $.store.set(SLACK_KEYS.polledAt, now)
  slackLocal.lastError = null
  const common = {
    after: String(slackLocal.since),
    sort: 'timestamp',
    limit: 20,
    include_context: false,
    response_format: 'detailed',
    natural_language_query: '',
  }
  try {
    const [direct, mentions, mine] = await Promise.all([
      slackSearch($, { ...common, channel_types: 'im,mpim', filters: `after:${slackDay(slackLocal.since)}` }, SLACK_DM_PAGES),
      slackSearch($, { ...common, channel_types: 'public_channel,private_channel', keywords: [`<@${slackLocal.me}>`] }, 1),
      slackSearch($, { ...common, filters: `from:<@${slackLocal.me}>` }, SLACK_MINE_PAGES),
    ])
    // Your latest message per conversation: replying in Slack is what clears a conversation here.
    // The DM search holds both sides, so a DM you answered hours ago clears even when it is past the pages of your own messages.
    const parsedDirect = parseSlack(direct)
    for (const item of [...parseSlack(mine), ...parsedDirect.filter(item => item.fromId === slackLocal.me)]) {
      if (Number(item.ts) > Number(marks.replied[item.channelId] ?? 0)) marks.replied[item.channelId] = item.ts
    }
    await $.store.set(SLACK_KEYS.marks, marks)
    await update($, slackMarksAtom, () => marks)
    const items = [...parsedDirect, ...parseSlack(mentions)]
      .filter(item => item.fromId !== slackLocal.me)
      .sort((a, b) => Number(a.ts) - Number(b.ts))
    const shared = await $.store.get(SLACK_KEYS.items)
    const before = sharedItems(shared)
    const known = new Set(before.map(item => item.ts))
    const alerted = await $.store.get(SLACK_KEYS.alertedTs)
    // The very first poll is backfill: it lists history without lighting the fading line.
    const seenAt = alerted === undefined ? 0 : now
    const fresh = items.filter(item => !known.has(item.ts)).map(({ fromId: _fromId, ...item }) => ({ ...item, seenAt }))
    const unread = [...before, ...fresh].filter(item => Number(item.ts) >= slackLocal.since).slice(-SLACK_UNREAD_MAX)
    await $.store.set(SLACK_KEYS.items, unread)

    // The first poll ever only sets the mark, so the 2h backfill shows without an alert.
    const latest = fresh.at(-1)
    if (latest !== undefined) {
      if (alerted === undefined) {
        await $.store.set(SLACK_KEYS.alertedTs, latest.ts)
      } else if (Number(latest.ts) > Number(alerted)) {
        await $.store.set(SLACK_KEYS.alertedTs, latest.ts)
        $.ui.toast(`Slack · ${latest.from} (${latest.where}): ${clip(latest.text, 120)}`, { timeoutMs: 15_000 })
      }
    }
    await update($, slackAtom, view => ({ ...view, unread: withLocalTests(unread, view.unread) }))
    if (fresh.some(item => item.seenAt > 0)) {
      scheduleSlackFade($)
    }
  } catch (error) {
    slackLocal.lastError = error instanceof Error ? error.message : String(error)
    $.ui.log(`pixel-pet: Slack poll failed: ${slackLocal.lastError}`, { to: 'debug' })
  }
}

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const triple = (a << 16) | (b << 8) | c
    out += alphabet[(triple >> 18) & 63]
    out += alphabet[(triple >> 12) & 63]
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : '='
    out += i + 2 < bytes.length ? alphabet[triple & 63] : '='
  }
  return out
}

// A short two-note chime, synthesized once so the mod ships no audio file and plays on any platform.
const CHIME_BASE64 = (() => {
  const rate = 22050
  const length = Math.round(rate * 0.38)
  const samples = new Float32Array(length)
  const notes: readonly [number, number, number][] = [
    [880, 0, 0.16],
    [1318.5, 0.1, 0.28],
  ]
  for (const [freq, start, duration] of notes) {
    const from = Math.round(start * rate)
    const count = Math.round(duration * rate)
    for (let i = 0; i < count && from + i < length; i++) {
      const t = i / rate
      const envelope = Math.min(1, i / (rate * 0.004)) * Math.exp(-t * 14)
      samples[from + i] = (samples[from + i] ?? 0) + Math.sin(2 * Math.PI * freq * t) * envelope * 0.32
    }
  }
  const bytes = new Uint8Array(44 + length * 2)
  const view = new DataView(bytes.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) {
      view.setUint8(offset + i, text.charCodeAt(i))
    }
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  ascii(36, 'data')
  view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i] ?? 0))
    view.setInt16(44 + i * 2, Math.round(sample * 32767), true)
  }
  return toBase64(bytes)
})()

// Per-load facts that no drawing reads; a hot reload refills them at session.start.
const local = {
  lastPrompt: null as string | null,
  turnStartedAt: null as number | null,
  sessionId: '',
  hostSessionId: '',
  project: '',
  snapshotDir: '',
  // The desktop app's record of this session, which carries the title the sidebar shows.
  hostRecordPath: '',
  title: '',
  demo: null as { cancel: () => void } | null,
  // /bit demo: the band draws made-up data for screenshots; pollers leave the demo values alone.
  isDemo: false,
  needsYou: null as string | null,
  // The Sessions list as the band last drew it, so the wheel knows how far it may scroll; zero while it is not drawn.
  sessionsTotal: 0,
  sessionsShown: 0,
}

async function locateHostRecord($: EngineInterface) {
  if (local.hostSessionId === '') {
    return
  }
  const home = (await $.env.get('HOME')) ?? ''
  const found = await $.process
    .run(['find', `${home}/Library/Application Support/Claude/claude-code-sessions`, '-maxdepth', '3', '-name', `${local.hostSessionId}.json`], { timeoutMs: 10_000 })
    .catch(() => null)
  local.hostRecordPath = found?.exitCode === 0 ? (found.stdout.split('\n').find(line => line !== '') ?? '') : ''
}

// The app retitles a session after its first turns, so the title is re-read with every heartbeat.
async function refreshTitle($: EngineInterface) {
  if (local.hostRecordPath === '') {
    return
  }
  try {
    const record = JSON.parse(String(await $.fs.read(local.hostRecordPath))) as { title?: unknown }
    local.title = typeof record.title === 'string' ? record.title : ''
  } catch {
    // The app rewrites the record whole; a read mid-write parses on the next heartbeat.
  }
}

async function changePlan($: EngineInterface, change: (plan: Plan, now: number) => Plan) {
  const now = await $.clock.now()
  const before = await read($, planAtom)
  await update($, planAtom, plan => {
    const changed = change(plan, now)
    const total = changed.tasks.length
    const isFinished = total > 0 && countDone(changed.tasks) === total
    return {
      ...changed,
      endedAt: isFinished ? (changed.endedAt ?? now) : null,
    }
  })
  const plan = await read($, planAtom)
  const wasDone = new Set(before.tasks.filter(task => task.status === 'completed').map(task => task.id))
  const finished = plan.tasks.filter(task => task.status === 'completed' && !wasDone.has(task.id))
  if (plan.endedAt !== null && before.endedAt === null) {
    await react($, 'happy', `All ${plan.tasks.length} tasks done!`, 8000)
  } else if (finished.length > 0) {
    await react($, 'happy', `Task done: ${finished.at(-1)?.subject ?? ''}`, 5000)
  }
}

// A plan that already finished starts over when new tasks arrive; a /goal keeps its goal.
function begin(plan: Plan, now: number): Plan {
  if (plan.startedAt !== null && plan.endedAt === null) {
    return plan
  }
  return {
    ...plan,
    goal: plan.isGoal ? plan.goal : local.lastPrompt === null ? plan.goal : promptGist(local.lastPrompt, 160),
    tasks: plan.endedAt === null ? plan.tasks : [],
    startedAt: local.turnStartedAt ?? now,
    endedAt: null,
  }
}

function upsertTask(plan: Plan, task: Pick<PlanTask, 'id'> & Partial<PlanTask>): Plan {
  const existing = plan.tasks.find(one => one.id === task.id)
  const tasks = existing
    ? plan.tasks.map(one => (one.id === task.id ? { ...one, ...stripUndefined(task) } : one))
    : [
        ...plan.tasks,
        {
          id: task.id,
          subject: task.subject ?? `Task ${task.id}`,
          activeForm: task.activeForm ?? null,
          status: task.status ?? 'pending',
        },
      ]
  return { ...plan, tasks }
}

// `items` replaces the list; `advance`, `done` and `start` move the one in progress (1-based).
function applyPlanUpdate(plan: Plan, call: AnyCall): Plan {
  if (Array.isArray(call.items)) {
    const items = call.items as readonly { content?: unknown; status?: unknown }[]
    return {
      ...plan,
      tasks: items.map((item, index) => ({
        id: String(index + 1),
        subject: String(item.content ?? ''),
        activeForm: null,
        status: asStatus(item.status),
      })),
    }
  }
  let tasks = plan.tasks
  if (call.advance === true) {
    const current = tasks.findIndex(task => task.status === 'in_progress')
    const following = tasks.findIndex((task, index) => index > current && task.status === 'pending')
    tasks = tasks.map((task, index) =>
      index === current ? { ...task, status: 'completed' as const } : index === following ? { ...task, status: 'in_progress' as const } : task,
    )
  }
  if (Array.isArray(call.done)) {
    const done = new Set((call.done as unknown[]).map(Number))
    tasks = tasks.map((task, index) => (done.has(index + 1) ? { ...task, status: 'completed' as const } : task))
  }
  if (typeof call.start === 'number') {
    tasks = tasks.map((task, index) => (index + 1 === call.start ? { ...task, status: 'in_progress' as const } : task))
  }
  return { ...plan, tasks }
}

async function setGoal($: EngineInterface, text: string) {
  const goal = text.trim()
  if (goal === '') {
    return
  }
  if (/^(clear|off|stop|reset)$/i.test(goal)) {
    await changePlan($, () => EMPTY_PLAN)
    return
  }
  await changePlan($, (plan, now) =>
    plan.isGoal && plan.goal === goal
      ? plan
      : { ...EMPTY_PLAN, goal, isGoal: true, startedAt: now },
  )
}

async function snapshotOf($: EngineInterface): Promise<PlanSnapshot> {
  const plan = await read($, planAtom)
  return {
    sessionId: local.sessionId,
    hostSessionId: local.hostSessionId === '' ? null : local.hostSessionId,
    project: local.project,
    goal: plan.goal,
    task: currentTask(plan),
    phase: plan.phase,
    done: countDone(plan.tasks),
    total: plan.tasks.length,
    startedAt: plan.startedAt,
    endedAt: plan.endedAt,
    updatedAt: await $.clock.now(),
    isRunning: await read($, runningAtom),
    needsYou: local.needsYou,
    pr: prOf((await read($, githubAtom)).current),
    title: local.title === '' ? null : local.title,
  }
}

const prOf = (current: CurrentPr | null): SessionPr | null =>
  current === null ? null : { key: current.key, url: current.url, isMerged: current.isMerged }

async function publish($: EngineInterface) {
  if (local.snapshotDir === '' || local.sessionId === '') {
    return
  }
  await refreshTitle($)
  const snapshot = await snapshotOf($)
  await $.fs.write(`${local.snapshotDir}/${local.sessionId}.json`, JSON.stringify(snapshot))
}

async function snapshotDirOf($: EngineInterface) {
  const configDir = (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? ''}/.claude`
  return `${configDir}/plan-progress/sessions`
}

async function refreshOthers($: EngineInterface) {
  if (local.snapshotDir === '') {
    local.snapshotDir = await snapshotDirOf($)
  }
  if (!(await $.fs.exists(local.snapshotDir))) {
    return
  }
  const now = await $.clock.now()
  const entries = await $.fs.list(local.snapshotDir)
  const others: PlanSnapshot[] = []
  const pruned: string[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${local.sessionId}.json`) {
      continue
    }
    const path = `${local.snapshotDir}/${entry.name}`
    if (now - entry.mtimeMs > PRUNE_MS) {
      pruned.push(path)
      continue
    }
    if (now - entry.mtimeMs > STALE_MS) {
      continue
    }
    try {
      const snapshot = JSON.parse(String(await $.fs.read(path))) as PlanSnapshot
      if (typeof snapshot.project === 'string' && snapshot.project !== '') {
        others.push(snapshot)
      }
    } catch {
      // A snapshot caught mid-write parses on the next heartbeat.
    }
  }
  if (pruned.length > 0) {
    void $.process.run(['rm', '-f', ...pruned]).catch(() => undefined)
  }
  others.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
  const current = await read($, othersAtom)
  if (JSON.stringify(current) !== JSON.stringify(others)) {
    await update($, othersAtom, () => others)
  }
}

const SESSIONS_SHOWN = 5
// The band picks a layout from its width: wide shows everything, medium keeps Sessions and the plan side by side
// with tighter columns and fewer rows, narrow stacks them. Each step trims rows so the band fits without scrolling.
type BandLayout = 'wide' | 'medium' | 'narrow'
const WIDE_COLUMNS = 120
const MEDIUM_COLUMNS = 84
const LAYOUT: Record<BandLayout, { sessions: number; slack: number; tasks: number; nameWidth: number; sessionsMin: number; planMin: number; planGap: number }> = {
  wide: { sessions: SESSIONS_SHOWN, slack: SLACK_CONVOS_SHOWN, tasks: Infinity, nameWidth: 44, sessionsMin: 40, planMin: 30, planGap: 4 },
  medium: { sessions: 4, slack: 2, tasks: 4, nameWidth: 30, sessionsMin: 30, planMin: 26, planGap: 2 },
  narrow: { sessions: 3, slack: 2, tasks: 1, nameWidth: 30, sessionsMin: 0, planMin: 0, planGap: 0 },
}

const bandLayout = (columns: number): BandLayout => (columns >= WIDE_COLUMNS ? 'wide' : columns >= MEDIUM_COLUMNS ? 'medium' : 'narrow')

// Up to `max` tasks around the open one: one done task before it for context, then what comes next.
function visibleTasks(tasks: readonly PlanTask[], max: number): PlanTask[] {
  if (tasks.length <= max) return [...tasks]
  const open = tasks.findIndex(task => task.status === 'in_progress')
  const anchor = open === -1 ? tasks.findIndex(task => task.status !== 'completed') : open
  const start = Math.max(0, Math.min(anchor - (max > 1 ? 1 : 0), tasks.length - max))
  return tasks.slice(start, start + max)
}

// The desktop app opens one of its sessions from this link; macOS `open` hands it over.
// The app's id is the one it published to the session's process; a snapshot from an older Bit has none,
// and its Claude Code id matches the app's only while the session was never handed off or resumed.
const sessionLink = (other: PlanSnapshot) => `claude://claude.ai/epitaxy/${other.hostSessionId ?? `local_${other.sessionId}`}`

async function openSession($: EngineInterface, other: PlanSnapshot) {
  await $.process.run(['open', sessionLink(other)]).catch(() => undefined)
}

const currentTask = (plan: Plan) => {
  const task = plan.tasks.find(one => one.status === 'in_progress')
  return task === undefined ? null : (task.activeForm ?? task.subject)
}

// The app's title for a session; a snapshot from an older Bit has none, and its project folder stands in.
const sessionName = (other: PlanSnapshot) => other.title ?? other.project

// One short line on what a session is doing: its task in progress; with no title, its goal stands in for one.
const sessionGist = (other: PlanSnapshot) => (other.isRunning && other.task ? other.task : other.title ? '' : (other.goal ?? ''))

const sessionRank = (other: PlanSnapshot) => (other.needsYou ? 0 : other.isRunning ? 1 : other.pr?.isMerged ? 2 : 3)

// What a session is up to, as the band says it: mark, text, color.
function sessionState(other: PlanSnapshot): [string, string, string] {
  if (other.needsYou) {
    return ['●', other.needsYou === 'idle' ? 'waiting for you' : `waiting: ${other.needsYou}`, 'yellow']
  }
  if (other.isRunning) {
    return ['●', `running${other.phase ? ` · ${other.phase}` : ''}${other.total > 0 ? ` ${other.done}/${other.total}` : ''}`, 'green']
  }
  if (other.pr?.isMerged) {
    return ['✓', 'merged', 'green']
  }
  return ['○', 'idle', 'gray']
}

async function openPane($: EngineInterface, view: PlanView) {
  await update($, viewAtom, () => view)
  if (view === 'all') {
    await refreshOthers($)
  }
  return $.ui.open({ id: PANE, title: TITLE })
}

async function playChime($: EngineInterface) {
  if (!(await read($, mutedAtom))) {
    void $.audio.play({ base64: CHIME_BASE64, mime: 'audio/wav' }, { gain: 0.8 }).catch(() => undefined)
  }
}

const DEMO_STEP_MS = 2500

const DEMO_TASKS: readonly Omit<PlanTask, 'status'>[] = [
  { id: 'd1', subject: 'Read the mod API types', activeForm: 'Reading the mod API types' },
  { id: 'd2', subject: 'Design the pane layout', activeForm: 'Designing the pane layout' },
  { id: 'd3', subject: 'Write the hooks module', activeForm: 'Writing the hooks module' },
  { id: 'd4', subject: 'Validate and type-check', activeForm: 'Validating and type-checking' },
  { id: 'd5', subject: 'Review the diff', activeForm: 'Reviewing the diff' },
]

// Each step: the phase shown and how many demo tasks are done; the next one is in progress.
const DEMO_SCRIPT: readonly { phase: PlanPhase; done: number }[] = [
  { phase: 'researching', done: 0 },
  { phase: 'researching', done: 0 },
  { phase: 'planning', done: 1 },
  { phase: 'planning', done: 1 },
  { phase: 'building', done: 2 },
  { phase: 'building', done: 2 },
  { phase: 'building', done: 2 },
  { phase: 'testing', done: 3 },
  { phase: 'testing', done: 3 },
  { phase: 'auditing', done: 4 },
  { phase: 'auditing', done: 4 },
  { phase: 'auditing', done: 5 },
]

const DEMO_OTHERS = [
  { sessionId: 'demo-a', project: 'web', goal: 'Move the checkout page to Vite', phase: 'testing', total: 6, isRunning: true, from: 3 },
  { sessionId: 'demo-b', project: 'api', goal: 'Fix the OTP retry loop', phase: 'building', total: 4, isRunning: false, from: 1 },
] as const

async function writeDemoOthers($: EngineInterface, step: number, isOver: boolean) {
  const now = await $.clock.now()
  for (const other of DEMO_OTHERS) {
    const snapshot: PlanSnapshot = {
      sessionId: other.sessionId,
      project: other.project,
      goal: isOver ? null : other.goal,
      phase: other.phase,
      done: isOver ? 0 : Math.min(other.total, other.from + Math.floor(step / 6)),
      total: isOver ? 0 : other.total,
      startedAt: now - (other.from + 2) * 4 * 60 * 1000,
      endedAt: null,
      updatedAt: now,
      isRunning: other.isRunning,
    }
    await $.fs.write(`${local.snapshotDir}/${other.sessionId}.json`, JSON.stringify(snapshot))
  }
}

async function demoStep($: EngineInterface, step: number) {
  const script = DEMO_SCRIPT[step]
  if (script === undefined) {
    return
  }
  await changePlan($, plan => ({
    ...plan,
    phase: script.phase,
    tasks: DEMO_TASKS.map((task, index) => ({
      ...task,
      status: index < script.done ? 'completed' : index === script.done ? 'in_progress' : 'pending',
    })),
  }))
  const isLast = step === DEMO_SCRIPT.length - 1
  await writeDemoOthers($, step, isLast)
  await refreshOthers($)
  if (isLast) {
    local.demo?.cancel()
    local.demo = null
    await update($, runningAtom, () => false)
    await playChime($)
  }
}

// ---- /bit demo: a band full of made-up data, for screenshots that carry no real names ----

const DEMO_SESSION_PREFIX = 'demo-band-'
const DEMO_TS_PREFIX = `${TEST_TS_PREFIX}demo-`
const DEMO_PR_URL = 'https://github.com/example/app/pull/'

const DEMO_SESSIONS: readonly (Partial<PlanSnapshot> & { sessionId: string; project: string })[] = [
  { sessionId: 'demo-band-1', project: 'app', title: 'feat(band): draw the pet above the prompt', phase: 'building', done: 2, total: 5, isRunning: true },
  { sessionId: 'demo-band-2', project: 'app', title: 'fix(auth): stop the OTP retry loop', needsYou: 'permission', pr: { key: 'app#412', url: `${DEMO_PR_URL}412`, isMerged: false } },
  { sessionId: 'demo-band-3', project: 'app', title: 'chore(ci): drop the flaky e2e step', pr: { key: 'app#398', url: `${DEMO_PR_URL}398`, isMerged: true } },
  { sessionId: 'demo-band-4', project: 'docs', title: 'docs: write the mod guide', goal: 'polish the README before the launch' },
  { sessionId: 'demo-band-5', project: 'app', title: 'refactor(api): split the billing router', pr: { key: 'app#401', url: `${DEMO_PR_URL}401`, isMerged: false } },
  { sessionId: 'demo-band-6', project: 'infra', title: 'spike: move the crons to Cloud Run', goal: 'is it cheaper than the GKE pool?' },
  { sessionId: 'demo-band-7', project: 'app', title: 'test(quiz): cover the returning-user path' },
]

const DEMO_SLACK: readonly { channelId: string; convo: string; from: string; texts: string[] }[] = [
  { channelId: 'demo-dm-1', convo: 'Dana Levi', from: 'Dana Levi', texts: ['Approved! One nit: the progress bar could use a label.', 'Also, love the dog.'] },
  { channelId: 'demo-dm-2', convo: 'Noa Cohen', from: 'Noa Cohen', texts: ['Can you take a look at the OTP retry PR when you have a minute?'] },
  { channelId: 'demo-grp', convo: 'Omri Barak, Maya Ron, Tal Shani', from: 'Omri Barak', texts: ['Deploy is out.', 'Error rate flat.', 'Latency flat.', 'Sign-ups up a bit.', 'Nothing in Sentry.', 'Deploy looks good from here, metrics are flat.'] },
]

async function writeDemoSessions($: EngineInterface) {
  const now = await $.clock.now()
  for (const [index, session] of DEMO_SESSIONS.entries()) {
    const snapshot: PlanSnapshot = {
      goal: null,
      phase: null,
      done: 0,
      total: 0,
      startedAt: now - (index + 1) * 11 * 60_000,
      endedAt: null,
      isRunning: false,
      ...session,
      updatedAt: now,
    }
    await $.fs.write(`${local.snapshotDir}/${session.sessionId}.json`, JSON.stringify(snapshot))
  }
}

async function startBandDemo($: EngineInterface) {
  local.demo?.cancel()
  local.isDemo = true
  const now = await $.clock.now()
  await changePlan($, () => ({
    ...EMPTY_PLAN,
    goal: 'Build the pet band',
    phase: 'building',
    startedAt: now - 7 * 60_000,
    tasks: DEMO_TASKS.map((task, index) => ({ ...task, status: index < 2 ? 'completed' : index === 2 ? 'in_progress' : 'pending' })),
  }))
  await update($, branchAtom, () => ({ name: 'pet-42-feat-pet-band', ticket: 'PET-42', changed: 3, ahead: 2, behind: 0, globals: [], hasSlash: false }))
  // Older than the flash window, so the rows show at once instead of one message taking over the line.
  const seenAt = now - SLACK_SHOW_MS - 60_000
  const items: SlackItem[] = DEMO_SLACK.flatMap(convo =>
    convo.texts.map((text, index) => ({
      ts: `${DEMO_TS_PREFIX}${convo.channelId}-${index}`,
      from: convo.from,
      where: convo.convo,
      channelId: convo.channelId,
      convo: convo.convo,
      text,
      url: `https://slack.com/archives/${convo.channelId}`,
      seenAt: seenAt + index * 1000,
    })),
  )
  await update($, slackAtom, view => ({ ...view, unread: [...view.unread.filter(item => !item.ts.startsWith(DEMO_TS_PREFIX)), ...items].slice(-SLACK_UNREAD_MAX) }))
  await writeDemoSessions($)
  await refreshOthers($)
  // Snapshots older than STALE_MS read as closed sessions, so the demo keeps them fresh.
  local.demo = $.clock.every(HEARTBEAT_MS, () => void writeDemoSessions($))
}

async function stopBandDemo($: EngineInterface) {
  local.demo?.cancel()
  local.demo = null
  local.isDemo = false
  await changePlan($, () => EMPTY_PLAN)
  await update($, slackAtom, view => ({ ...view, unread: view.unread.filter(item => !item.ts.startsWith(DEMO_TS_PREFIX)) }))
  void $.process.run(['rm', '-f', ...DEMO_SESSIONS.map(session => `${local.snapshotDir}/${session.sessionId}.json`)]).catch(() => undefined)
  await refreshOthers($)
  await refreshBranch($)
}

async function startDemo($: EngineInterface) {
  local.demo?.cancel()
  const now = await $.clock.now()
  await changePlan($, () => ({
    ...EMPTY_PLAN,
    goal: 'Demo: build the Plan Progress mod',
    isGoal: true,
    startedAt: now,
  }))
  await update($, runningAtom, () => true)
  await openPane($, 'plan')
  await demoStep($, 0)
  let step = 0
  local.demo = $.clock.every(DEMO_STEP_MS, () => {
    step += 1
    void demoStep($, step)
  })
}

// ---- cache keeper: prompt-cache countdown, context, limits and cost ----

const cacheAtAtom = atom({ plugin: 'pixel-pet', key: 'lastRequestAt' } as const, null)
const cacheNowAtom = atom({ plugin: 'pixel-pet', key: 'now' } as const, 0)
const ttlAtom = atom({ plugin: 'pixel-pet', key: 'ttl' } as const, { minutes: 60, source: 'default' } as CacheKeeperTtl)
const usageAtom = atom({ plugin: 'pixel-pet', key: 'usage' } as const, null as CacheKeeperUsage | null)
const handoffAtom = atom({ plugin: 'pixel-pet', key: 'handoff' } as const, 'idle' as CacheKeeperHandoff)

const DEFAULT_TTL_MINUTES = 60
const FINE_COUNTDOWN_MS = 2 * 60_000
const STORE_TTL_OVERRIDE = 'ttlOverrideMinutes'
const STORE_TTL_DETECTED = 'ttlDetectedMinutes'

// Input list prices per million tokens; first match wins, so longer ids come first.
const PRICES: ReadonlyArray<[string, number]> = [
  ['fable-5-1', 10],
  ['mythos-5-1', 10],
  ['fable', 10],
  ['mythos', 10],
  ['opus-5-5', 4],
  ['opus', 5],
  ['sonnet-5', 2],
  ['sonnet', 3],
  ['haiku', 1],
]

const HANDOFF_PROMPT = `Write a handoff brief so a fresh Claude Code session with none of this conversation can continue the work.
Use Markdown with these sections: Goal, Current state, Decisions made (and why), Files and commands that matter (exact paths), Open questions, Next steps (numbered, concrete).
Include exact identifiers: branch names, PR/ticket ids, file paths, error messages. Leave out anything already finished and irrelevant to what comes next.
Start directly with the first heading. No preamble and no sign-off.`

// Per-load facts no drawing reads; a hot reload refills them at session.start.
const cacheLocal = {
  transcriptPath: null as string | null,
  model: null as string | null,
  warnedFor: null as number | null,
  cooledFor: null as number | null,
  burn: { five: null, week: null } as Record<'five' | 'week', BurnBase | null>,
}

type BurnBase = { at: number; percent: number; resetsAt: string }

// The pace since this window's first reading; a projection shows only when it reaches 100% before the reset.
function projectLimit(key: 'five' | 'week', limit: CacheKeeperLimit | null | undefined, t: number): string | null {
  if (!limit?.resetsAt || t === 0) {
    return null
  }
  const base = cacheLocal.burn[key]
  if (base === null || base.resetsAt !== limit.resetsAt || limit.percentUsed < base.percent) {
    cacheLocal.burn[key] = { at: t, percent: limit.percentUsed, resetsAt: limit.resetsAt }
    return null
  }
  const elapsed = t - base.at
  const used = limit.percentUsed - base.percent
  if (elapsed < 10 * 60_000 || used <= 0) {
    return null
  }
  const eta = t + ((100 - limit.percentUsed) / used) * elapsed
  return eta < Date.parse(limit.resetsAt) ? `→100% at ${clockTime(eta)}` : null
}

async function configDirOf($: EngineInterface): Promise<string> {
  return (await $.env.get('CLAUDE_CONFIG_DIR')) ?? `${(await $.env.get('HOME')) ?? '~'}/.claude`
}

async function refreshCacheUsage($: EngineInterface) {
  const u = await $.session.usage()
  cacheLocal.model = cacheLocal.model ?? (await $.session.model())
  await update($, usageAtom, () => toUsage(u.context, u.rateLimits, cacheLocal.model ?? ''))
}

async function refreshCacheTtl($: EngineInterface) {
  if (!cacheLocal.transcriptPath) {
    const slug = (await $.session.cwd()).replace(/[^a-zA-Z0-9]/g, '-')
    const guess = `${await configDirOf($)}/projects/${slug}/${await $.session.id()}.jsonl`
    cacheLocal.transcriptPath = (await $.fs.exists(guess)) ? guess : null
  }
  let scan: TranscriptScan = { minutes: null, lastAt: null }
  if (cacheLocal.transcriptPath) {
    try {
      const ran = await $.process.run(['tail', '-c', '1000000', cacheLocal.transcriptPath], { timeoutMs: 5000 })
      scan = scanTranscriptTail(ran.stdout)
    } catch {
      // An unreadable transcript leaves the remembered or default window in place.
    }
  }
  if (scan.minutes !== null) {
    await $.store.set(STORE_TTL_DETECTED, scan.minutes)
  }
  const seeded = scan.lastAt
  if (seeded !== null) {
    await update($, cacheAtAtom, current => current ?? seeded)
  }
  const override = await $.store.get(STORE_TTL_OVERRIDE)
  const remembered = await $.store.get(STORE_TTL_DETECTED)
  const resolved: CacheKeeperTtl =
    typeof override === 'number'
      ? { minutes: override, source: 'manual' }
      : typeof remembered === 'number'
        ? { minutes: remembered, source: 'detected' }
        : { minutes: DEFAULT_TTL_MINUTES, source: 'default' }
  await update($, ttlAtom, () => resolved)
}

async function notifyCache($: EngineInterface, text: string) {
  $.ui.toast(text, { timeoutMs: 15_000 })
  const quoted = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  try {
    await $.process.run(
      ['osascript', '-e', `display notification ${quoted(text)} with title "Cache Keeper" sound name "Glass"`],
      { timeoutMs: 5000 },
    )
  } catch {
    try {
      await $.process.run(['notify-send', 'Cache Keeper', text], { timeoutMs: 5000 })
    } catch {
      // The toast already showed; this host has no OS notifier.
    }
  }
}

async function cacheTick($: EngineInterface) {
  const t = await $.clock.now()
  const at = await read($, cacheAtAtom)
  const win = await read($, ttlAtom)
  const remaining = at === null ? null : at + win.minutes * 60_000 - t
  const shown = await read($, cacheNowAtom)
  if (shown === 0 || t - shown >= 30_000 || (remaining !== null && remaining <= FINE_COUNTDOWN_MS)) {
    await update($, cacheNowAtom, () => t)
  }
  if (at === null || remaining === null) {
    return
  }
  if (remaining > 0 && remaining <= warnLeadMs(win.minutes) && cacheLocal.warnedFor !== at) {
    cacheLocal.warnedFor = at
    const minutes = Math.max(1, Math.round(remaining / 60_000))
    await notifyCache($, `Prompt cache goes cold in ${minutes} min. Send a message to keep it warm, or Summarize, start fresh.`)
  }
  if (remaining <= 0 && cacheLocal.cooledFor !== at) {
    cacheLocal.cooledFor = at
    $.ui.toast('Prompt cache is cold: the next message re-writes the whole context.', { timeoutMs: 10_000 })
  }
}

async function runHandoff($: EngineInterface) {
  if ((await read($, handoffAtom)) !== 'idle') {
    return
  }
  await update($, handoffAtom, (): CacheKeeperHandoff => 'writing')
  try {
    const reply = await $.model.fork({ prompt: HANDOFF_PROMPT })
    if (!reply.isAnswered) {
      $.ui.toast(`The summary failed (${reply.reason}). Nothing was cleared.`, { timeoutMs: 10_000 })
      return
    }
    const brief = reply.text.trim()
    const stamp = new Date(await $.clock.now()).toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const path = `${await configDirOf($)}/cache-keeper/handoffs/${stamp}-${(await $.session.id()).slice(0, 8)}.md`
    await $.fs.write(path, `${brief}\n`)
    await update($, handoffAtom, (): CacheKeeperHandoff => 'clearing')
    await $.command.run({ command: 'clear' })
    const text = `Continue from this summary of the last session (saved at ${path}):\n\n${brief}`
    const filled = await $.prompt.fill({ text })
    if (filled.isFilled) {
      $.ui.toast('Fresh session started. The summary is in the prompt box: review it, then press Enter.')
    } else {
      await $.ui.copy({ text })
      $.ui.toast(`Fresh session started. The prompt box was busy, so the summary is on the clipboard (also at ${path}).`, {
        timeoutMs: 15_000,
      })
    }
  } catch (error) {
    $.ui.toast(`Summarize, start fresh stopped: ${error instanceof Error ? error.message : String(error)}`, {
      timeoutMs: 10_000,
    })
  } finally {
    await update($, handoffAtom, (): CacheKeeperHandoff => 'idle')
  }
}

async function startCacheKeeper($: EngineInterface) {
  await $.command.register({
    name: 'cache-keeper',
    description: 'Cache Keeper: status, `ttl <minutes|auto>`, or `fresh` (summarize, start a fresh session, summary in the prompt box)',
    argumentHint: '[ttl <minutes|auto> | fresh]',
  })
  $.clock.every(1000, () => void cacheTick($))
  void refreshCacheTtl($).then(() => refreshCacheUsage($))
}

async function endCacheKeeper($: EngineInterface, e: SessionEndInput) {
  if (e.reason === 'clear') {
    cacheLocal.transcriptPath = null
    cacheLocal.warnedFor = null
    cacheLocal.cooledFor = null
    await update($, cacheAtAtom, () => null)
    void refreshCacheUsage($)
  }
}

async function drawCacheLine($: EngineInterface, ui: BandElements, isWorking: boolean) {
  const { Box, Text, Button } = ui
  const at = await read($, cacheAtAtom)
  const t = await read($, cacheNowAtom)
  const win = await read($, ttlAtom)
  const u = await read($, usageAtom)
  const state = await read($, handoffAtom)

  const remaining = at === null || t === 0 ? null : at + win.minutes * 60_000 - t
  const cacheColor =
    remaining === null ? undefined : remaining <= 0 ? 'red' : remaining <= warnLeadMs(win.minutes) ? 'yellow' : 'green'
  const cacheText =
    remaining === null
      ? 'cache: no request yet'
      : remaining <= 0
        ? 'cache COLD'
        : remaining <= FINE_COUNTDOWN_MS
          ? `cache ${clock(remaining)}`
          : `cache ${Math.ceil(remaining / 60_000)}m`
  const windowText = `${win.minutes >= 60 && win.minutes % 60 === 0 ? `${win.minutes / 60}h` : `${win.minutes}m`} ${win.source}`

  const tokens = u?.contextTokens ?? null
  const price = priceFor(u?.model || cacheLocal.model || '')
  const writeMultiplier = win.minutes > 5 ? 2 : 1.25
  const coldUsd = tokens === null ? null : (tokens / 1e6) * price * writeMultiplier
  const isAtRisk = remaining !== null && remaining <= warnLeadMs(win.minutes)
  const isBlocked = state !== 'idle' || isWorking
  const fiveEta = projectLimit('five', u?.fiveHour, t)
  const weekEta = projectLimit('week', u?.weekly, t)

  return (
    <Box key="cache-line" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
      <Text color={cacheColor} bold>
        {cacheText}
      </Text>
      <Text dimColor>({windowText})</Text>
      <Text dimColor>·</Text>
      <Text>
        {`ctx ${tokens === null ? '—' : fmtTokens(tokens)}/${fmtTokens(u?.contextWindow ?? 0)}${u?.contextPercent != null ? ` ${u.contextPercent}%` : ''}`}
      </Text>
      <Text dimColor>·</Text>
      <Text color={limitColor(u?.fiveHour)}>{`5h ${limitText(u?.fiveHour, t)}`}</Text>
      {fiveEta !== null && <Text color="red">{fiveEta}</Text>}
      <Text dimColor>·</Text>
      <Text color={limitColor(u?.weekly)}>{`wk ${limitText(u?.weekly, t)}`}</Text>
      {weekEta !== null && <Text color="red">{weekEta}</Text>}
      {isAtRisk && coldUsd !== null && (
        <Text color={remaining <= 0 ? 'red' : 'yellow'}>
          {remaining <= 0 ? `· next message re-writes the cache: ${usd(coldUsd)}` : `· a cold cache will cost ${usd(coldUsd)}`}
        </Text>
      )}
      <Button
        key="handoff"
        label={state === 'writing' ? 'Summarizing…' : state === 'clearing' ? 'Starting fresh…' : 'Summarize, start fresh'}
        hotkey="h"
        dimColor={isBlocked}
        onPress={() => {
          if (!isBlocked) {
            void runHandoff($)
          }
        }}
      />
    </Box>
  )
}

function toUsage(
  context: SessionContextUsage,
  limits: SessionRateLimit[],
  model: string,
): CacheKeeperUsage {
  const limit = (kind: string): CacheKeeperLimit | null => {
    const found = limits.find(one => one.kind === kind)

    return found ? { percentUsed: found.percentUsed, resetsAt: found.resetsAt ?? null } : null
  }

  return {
    contextTokens: context.tokens ?? null,
    contextWindow: context.window,
    contextPercent: context.percent ?? null,
    fiveHour: limit('five_hour'),
    weekly: limit('seven_day'),
    model,
  }
}

type TranscriptScan = { minutes: number | null; lastAt: number | null }

type TranscriptRow = {
  type?: string
  isSidechain?: boolean
  timestamp?: string
  message?: { usage?: { cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } } }
}

// The API reports which TTL each cache write used; the newest main-thread write is the live window.
function scanTranscriptTail(tail: string): TranscriptScan {
  let minutes: number | null = null
  let lastAt: number | null = null
  for (const line of tail.split('\n').reverse()) {
    if (!line.includes('"assistant"')) {
      continue
    }
    let row: TranscriptRow
    try {
      row = JSON.parse(line) as TranscriptRow
    } catch {
      continue
    }
    if (row.type !== 'assistant' || row.isSidechain) {
      continue
    }
    if (lastAt === null && row.timestamp) {
      lastAt = Date.parse(row.timestamp)
    }
    const written = row.message?.usage?.cache_creation
    if (minutes === null && written) {
      if ((written.ephemeral_1h_input_tokens ?? 0) > 0) {
        minutes = 60
      } else if ((written.ephemeral_5m_input_tokens ?? 0) > 0) {
        minutes = 5
      }
    }
    if (minutes !== null && lastAt !== null) {
      break
    }
  }

  return { minutes, lastAt }
}

// A 5-minute window gets a 1-minute warning; anything longer gets 5 minutes.
function warnLeadMs(minutes: number): number {
  return minutes > 10 ? 5 * 60_000 : 60_000
}

function priceFor(id: string): number {
  const found = PRICES.find(([key]) => id.includes(key))

  return found ? found[1] : 4
}

function limitColor(limit: CacheKeeperLimit | null | undefined): string | undefined {
  if (!limit) {
    return undefined
  }

  return limit.percentUsed >= 90 ? 'red' : limit.percentUsed >= 70 ? 'yellow' : undefined
}

function limitText(limit: CacheKeeperLimit | null | undefined, t: number): string {
  if (!limit) {
    return '—'
  }
  const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) - t : NaN

  return Number.isFinite(resetMs) && resetMs > 0 && t > 0
    ? `${Math.round(limit.percentUsed)}% ↻${span(resetMs)}`
    : `${Math.round(limit.percentUsed)}%`
}

function clock(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60

  return `${m}:${String(s).padStart(2, '0')}`
}

function span(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 60) {
    return `${minutes}m`
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return `${hours}h${String(minutes % 60).padStart(2, '0')}m`
  }

  return `${Math.floor(hours / 24)}d${hours % 24}h`
}

function fmtTokens(n: number): string {
  if (n >= 1e6) {
    return `${Number((n / 1e6).toFixed(n % 1e6 === 0 ? 0 : 1))}M`
  }

  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function usd(n: number): string {
  return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`
}

// ---- self-critique: /critique pane reviewing the last response ----

const CRITIQUE_PANE = 'self-critique'
const CRITIQUE_TITLE = 'Self-Critique'

const critiqueAtom = atom({ plugin: 'pixel-pet', key: 'critique' } as const, null)
const statusAtom = atom({ plugin: 'pixel-pet', key: 'critiqueStatus' } as const, { phase: 'idle' })
const isAutoAtom = atom({ plugin: 'pixel-pet', key: 'isCritiqueAuto' } as const, false)
const critiqueModelAtom = atom({ plugin: 'pixel-pet', key: 'critiqueModel' } as const, 'session')
const sentFixesAtom = atom({ plugin: 'pixel-pet', key: 'sentFixes' } as const, [])

const MODELS: readonly { value: CritiqueModel; label: string }[] = [
  { value: 'session', label: 'Same as session' },
  { value: 'opus', label: 'Opus' },
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'haiku', label: 'Haiku' },
]

const VERDICT_COLOR: Record<CritiqueVerdict, string> = {
  Strong: 'green',
  Mixed: 'yellow',
  Weak: 'red',
}

const SYSTEM = `You review one response an AI coding assistant gave to its user. Be rigorous and unsentimental: judge correctness, whether it did what was asked (no more, no less), unverified or overconfident claims, risky or irreversible actions, missed edge cases, and clarity and concision. Do not praise for its own sake and do not invent flaws to look thorough.

Reply with ONLY one JSON object, no prose and no code fence:
{"verdict":"Strong"|"Mixed"|"Weak","summary":"at most two sentences","strengths":["..."],"flaws":[{"issue":"what is wrong, one sentence","fix":"an imperative instruction the assistant can act on to fix it"}]}

Strong: no material flaws. Mixed: useful but with material flaws. Weak: wrong, incomplete or misleading. At most 4 strengths and 6 flaws, most important first. Flaws may be empty only for Strong.`

const REQUEST_CAP = 6000
const RESPONSE_CAP = 24000

let controller: AbortController | undefined
let runId = 0

const clipText = (text: string, cap: number, keep: 'start' | 'end') => {
  if (text.length <= cap) {
    return text
  }

  return keep === 'start'
    ? `${text.slice(0, cap)}\n[…truncated]`
    : `[…truncated]\n${text.slice(-cap)}`
}

const describeToolUse = (use: SessionMessage['toolUses'][number]) => {
  const input = use.input
  const brief = ['command', 'file_path', 'pattern', 'url', 'description']
    .map(field => input[field])
    .find(value => typeof value === 'string') as string | undefined
  const detail = brief ?? JSON.stringify(input)

  return `[${use.tool}: ${clipText(detail, 200, 'start')}${use.isError ? ' → error' : ''}]`
}

const isPrompt = (message: SessionMessage) =>
  message.role === 'user' && !message.toolResults?.length && message.text.trim() !== ''

const gatherLastTurn = async ($: EngineInterface, finalAnswer?: string) => {
  const messages = await $.session.messages()
  const end = messages.findLastIndex(
    message => message.role === 'assistant' && (message.text !== '' || message.toolUses.length > 0),
  )
  const last = messages[end]
  if (!last) {
    return undefined
  }

  const start = messages.slice(0, end).findLastIndex(isPrompt)
  const prompt = messages[start]

  const steps = messages
    .slice(start + 1, end + 1)
    .filter(message => message.role === 'assistant')
    .map(message => [message.text, ...message.toolUses.map(describeToolUse)].filter(Boolean).join('\n'))
  const lastText = last.text.trim()
  if (finalAnswer && finalAnswer.trim() && finalAnswer.trim() !== lastText) {
    steps.push(finalAnswer)
  }

  return {
    request: prompt ? prompt.text : '(no user prompt found)',
    response: steps.join('\n\n'),
    excerpt: (finalAnswer?.trim() || lastText || steps.at(-1) || '').replace(/\s+/g, ' ').slice(0, 90),
  }
}

const parseCritique = (text: string) => {
  const open = text.indexOf('{')
  const close = text.lastIndexOf('}')
  if (open < 0 || close <= open) {
    return undefined
  }
  const raw = JSON.parse(text.slice(open, close + 1)) as Record<string, unknown>
  const verdict = ['Strong', 'Mixed', 'Weak'].includes(raw.verdict as string)
    ? (raw.verdict as CritiqueVerdict)
    : undefined
  if (!verdict) {
    return undefined
  }
  const strings = (value: unknown) =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
  const flaws = Array.isArray(raw.flaws)
    ? raw.flaws
        .filter((flaw): flaw is { issue: string; fix: string } =>
          typeof flaw?.issue === 'string' && typeof flaw?.fix === 'string')
        .map(({ issue, fix }) => ({ issue, fix }))
    : []

  return {
    verdict,
    summary: typeof raw.summary === 'string' ? raw.summary : '',
    strengths: strings(raw.strengths).slice(0, 4),
    flaws: flaws.slice(0, 6),
  }
}

const setStatus = ($: EngineInterface, status: CritiqueStatus) => update($, statusAtom, () => status)

const runCritique = async ($: EngineInterface, finalAnswer?: string) => {
  controller?.abort()
  const mine = new AbortController()
  controller = mine
  const id = ++runId

  const choice = await read($, critiqueModelAtom)
  const model = choice === 'session' ? await $.session.model() : choice
  await setStatus($, { phase: 'running', model })

  const turn = await gatherLastTurn($, finalAnswer)
  if (!turn) {
    await setStatus($, { phase: 'error', message: 'No response to review yet.' })
    return
  }

  const prompt = `<user_request>\n${clipText(turn.request, REQUEST_CAP, 'start')}\n</user_request>\n\n<assistant_response>\n${clipText(turn.response, RESPONSE_CAP, 'end')}\n</assistant_response>`

  let reply: Awaited<ReturnType<EngineInterface['model']['complete']>>
  try {
    reply = await $.model.complete(
      { model, system: SYSTEM, prompt, maxTokens: 2000, timeoutMs: 120_000 },
      { signal: mine.signal },
    )
  } catch (error) {
    if (id === runId) {
      await setStatus($, { phase: 'error', message: `Model call refused: ${String(error)}` })
    }
    return
  }
  if (id !== runId) {
    return
  }
  if (!reply.isAnswered) {
    const message = reply.reason === 'api-error' ? `API error ${reply.status}` : `No answer (${reply.reason})`
    await setStatus($, { phase: 'error', message })
    return
  }

  let parsed: ReturnType<typeof parseCritique>
  try {
    parsed = parseCritique(reply.text)
  } catch {
    parsed = undefined
  }
  if (!parsed) {
    await setStatus($, { phase: 'error', message: 'The reviewer did not return a readable critique. Try Rerun.' })
    return
  }

  const critique: Critique = { ...parsed, model, excerpt: turn.excerpt, at: await $.clock.now() }
  await update($, sentFixesAtom, () => [])
  await update($, critiqueAtom, () => critique)
  await setStatus($, { phase: 'idle' })
  $.ui.status(`Critique: ${critique.verdict} · ${critique.flaws.length} flaw${critique.flaws.length === 1 ? '' : 's'}`)
  if (critique.verdict === 'Strong') {
    await react($, 'happy', 'Critique: Strong answer', 6000)
  } else if (critique.verdict === 'Weak') {
    await react($, 'sad', `Critique: Weak, ${critique.flaws.length} flaws to fix`, 10_000)
  }
}

const launchCritique = ($: EngineInterface, finalAnswer?: string) => {
  void runCritique($, finalAnswer).catch(error =>
    setStatus($, { phase: 'error', message: String(error) }),
  )
}

const clockTime = (at: number) => {
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

async function startCritique($: EngineInterface) {
  await $.command.register({
    name: 'critique',
    description: "Review Claude's last response in a side pane",
  })
  const storedAuto = await $.store.get('critiqueAuto')
  const storedModel = await $.store.get('critiqueModel')
  if (typeof storedAuto === 'boolean') {
    await update($, isAutoAtom, () => storedAuto)
  }
  if (MODELS.some(option => option.value === storedModel)) {
    await update($, critiqueModelAtom, () => storedModel as CritiqueModel)
  }
}

async function completeCritique($: EngineInterface, e: TurnCompleteInput) {
  if (e.agentId === undefined && e.reason === 'answer' && (await read($, isAutoAtom))) {
    const answer = e.answer
    $.clock.after(300, () => {
      void $.ui.open({ id: CRITIQUE_PANE, title: CRITIQUE_TITLE })
      launchCritique($, answer)
    })
  }
}

export const register: Register = (on, options) => {
  config.extraBots = stringList(options.extraBots).map(login => login.toLowerCase())
  config.previewMarker = typeof options.previewMarker === 'string' ? options.previewMarker : ''
  config.previewLinkMatch = typeof options.previewLinkMatch === 'string' ? options.previewLinkMatch : ''
  config.globalsFiles = stringList(options.globalsFiles)
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    local.sessionId = await $.session.id()
    local.hostSessionId = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) ?? ''
    void locateHostRecord($)
    const root = await $.session.root()
    local.project = root.split('/').filter(Boolean).at(-1) ?? root
    local.snapshotDir = await snapshotDirOf($)
    const stored = await $.store.get('isMuted')
    await update($, mutedAtom, () => stored === true)

    await $.command.register({ name: 'pet', description: 'Show or hide Bit, the pixel puppy above the prompt' })
    $.clock.every(PET_TICK_MS, async () => {
      if (await read($, hiddenAtom)) {
        return
      }
      const now = await $.clock.now()
      await update($, moodAtom, mood => (mood.kind !== 'idle' && now > mood.until ? CALM : mood))
      await update($, frameAtom, frame => (frame + 1) % 1320)
    })
    void startCockpit($).then(() => refreshBranch($)).then(() => refreshGitHub($))
    $.clock.every(GITHUB_POLL_MS, () => void refreshGitHub($))
    $.clock.every(BRANCH_POLL_MS, () => void refreshBranch($))
    await $.command.register({
      name: 'plan-progress',
      description: 'Open the Plan Progress pane (args: all, plan, demo, mute, unmute)',
    })

    $.clock.every(1000, async () => {
      const plan = await read($, planAtom)
      const view = await read($, viewAtom)
      const isTicking = plan.startedAt !== null && plan.endedAt === null
      const isShown = (await $.ui.panes()).some(pane => pane.id === PANE)
      if (isShown && (isTicking || view === 'all')) {
        $.ui.invalidate('ui.render')
      }
    })
    $.clock.every(HEARTBEAT_MS, async () => {
      await publish($)
      await refreshOthers($)
    })
    await publish($)
    const storedCollapsed = await $.store.get('isCollapsed')
    await update($, collapsedAtom, () => storedCollapsed === true)
    const storedFavorite = await $.store.get('favoriteAction')
    await update($, favoriteAtom, () => (typeof storedFavorite === 'string' ? actionById(storedFavorite).id : DEFAULT_ACTION))
    await startCacheKeeper($)
    await startCritique($)
    void startSlack($)
    const startedAt = await $.clock.now()
    await update($, lastActiveAtom, () => startedAt)
    await $.command.register({
      name: 'bit',
      description: 'Bit: recap | 1on1 <login> | concentration | impact <pr> | worktrees | squad [add|remove <login>...] | slack | demo [off]',
    })

    return started
  })

  on('session.end', async ($, e, next) => {
    if (local.snapshotDir !== '') {
      await $.fs.write(`${local.snapshotDir}/${e.sessionId}.json`, JSON.stringify({ sessionId: e.sessionId, updatedAt: 0, total: 0, goal: null }))
    }
    if (e.reason === 'clear') {
      await update($, planAtom, () => EMPTY_PLAN)
      local.sessionId = await $.session.id()
    }
    await endCacheKeeper($, e)
    return next(e)
  })

  on('command.run', { command: 'plan-progress' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'mute' || arg === 'unmute') {
      const isMuted = arg === 'mute'
      await update($, mutedAtom, () => isMuted)
      await $.store.set('isMuted', isMuted)
      return { text: `Plan Progress: turn-end sound ${isMuted ? 'off' : 'on'}.` }
    }
    if (arg === 'demo') {
      await startDemo($)
      return { text: 'Plan Progress demo started: a 5-step session over about 30 seconds. Press a in the pane for All tasks.' }
    }
    const view: PlanView = arg === 'all' ? 'all' : 'plan'
    await openPane($, view)
    return { text: `Plan Progress opened${view === 'all' ? ' (All tasks)' : ''}.` }
  })

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    await setGoal($, e.args)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    const text = e.text.trim()
    const goal = /^\/goal\s+([\s\S]+)$/.exec(text)
    if (goal?.[1] !== undefined) {
      await setGoal($, goal[1])
    } else if (!text.startsWith('/') && e.origin.kind !== 'task-notification' && e.turnId === undefined) {
      local.lastPrompt = text
    }
    if (local.needsYou !== null) {
      local.needsYou = null
      void publish($)
    }
    if (e.origin.kind === 'task-notification') {
      await update($, backgroundAtom, list => list.slice(1))
    }
    await update($, attentionAtom, () => false)
    const at = await $.clock.now()
    await update($, lastActiveAtom, () => at)
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    local.turnStartedAt = await $.clock.now()
    await update($, runningAtom, () => true)
    await update($, attentionAtom, () => false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    await completeCritique($, e)
    if (e.agentId !== undefined) {
      return done
    }
    await update($, runningAtom, () => false)
    const endedAt = await $.clock.now()
    await update($, lastActiveAtom, () => endedAt)
    void publish($)
    if (!e.isAborted) {
      await playChime($)
    }
    return done
  })

  on('tool.call', async ($, e, next) => {
    const call = e as unknown as AnyCall
    const phase = phaseOfCall(call)
    if (phase !== null) {
      const plan = await read($, planAtom)
      if (plan.phase !== phase) {
        await update($, planAtom, current => ({ ...current, phase }))
      }
    }

    const isMain = call.agentId === undefined
    if (isMain && call.tool === 'TodoWrite' && Array.isArray(call.todos)) {
      const todos = call.todos as readonly { content?: unknown; activeForm?: unknown; status?: unknown }[]
      await changePlan($, (plan, now) => ({
        ...begin(plan, now),
        tasks: todos.map((todo, index) => ({
          id: String(index + 1),
          subject: String(todo.content ?? ''),
          activeForm: typeof todo.activeForm === 'string' ? todo.activeForm : null,
          status: asStatus(todo.status),
        })),
      }))
    }

    // The desktop app's task list arrives through update_plan, not TodoWrite.
    if (isMain && call.tool === 'mcp__ccd_turn__update_plan') {
      await changePlan($, (plan, now) => applyPlanUpdate(begin(plan, now), call))
    }

    const ran = await next(e)
    if (!isMain || ran.deny !== undefined || ran.isError === true) {
      return ran
    }

    if (call.tool === 'TaskCreate') {
      const record = ran.result as { task?: { id?: unknown } } | undefined
      const id = record?.task?.id ?? /#(\d+)/.exec(ran.text ?? '')?.[1]
      if (id !== undefined) {
        await changePlan($, (plan, now) =>
          upsertTask(begin(plan, now), {
            id: String(id),
            subject: String(call.subject ?? ''),
            activeForm: typeof call.activeForm === 'string' ? call.activeForm : null,
          }),
        )
      }
    }

    if (call.tool === 'TaskUpdate' && call.taskId !== undefined) {
      const id = String(call.taskId)
      if (call.status === 'deleted') {
        await changePlan($, plan => ({ ...plan, tasks: plan.tasks.filter(task => task.id !== id) }))
      } else {
        await changePlan($, plan =>
          upsertTask(plan, {
            id,
            status: call.status === undefined ? undefined : asStatus(call.status),
            subject: typeof call.subject === 'string' ? call.subject : undefined,
            activeForm: typeof call.activeForm === 'string' ? call.activeForm : undefined,
          }),
        )
      }
    }

    return ran
  })

  on('classic.TaskCreated', async ($, e, next) => {
    if (e.teammate_name === undefined) {
      await changePlan($, (plan, now) => upsertTask(begin(plan, now), { id: e.task_id, subject: e.task_subject }))
    }
    return next(e)
  })

  on('classic.TaskCompleted', async ($, e, next) => {
    if (e.teammate_name === undefined) {
      await changePlan($, plan => upsertTask(plan, { id: e.task_id, subject: e.task_subject, status: 'completed' }))
    }
    return next(e)
  })

  on('command.run', { command: 'pet' }, async $ => {
    const isHidden = await update($, hiddenAtom, hidden => !hidden)
    return { text: isHidden ? `${PET} went for a nap.` : `${PET} is back!` }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const isMain = e.agentId === undefined
    const isPush = /\bgit\s+push\b/.test(e.command)
    if (isMain && (e as AnyCall).run_in_background === true) {
      await addBackground($, { id: e.tool_use_id, type: 'shell', description: firstLine(e.command, 80) })
    }
    if (isMain && isPush) {
      const stopped = await pushGuard($)
      if (stopped !== null) {
        return { deny: stopped }
      }
    }
    const ran = await next(e)
    if (ran.deny !== undefined || !isMain) {
      return ran
    }
    const hasFailed = ran.isError === true
    const cause = hasFailed ? classifyFailure(outputOf(ran), (await read($, githubAtom)).masterCi) : null
    if (cause !== null) {
      $.ui.toast(`${cause.label}${cause.fix === null ? '' : `. Fix: ${cause.fix}`}`, { timeoutMs: 15_000 })
      if (cause.fix !== null) {
        void $.prompt.suggest({ text: `Run \`${cause.fix}\` and retry` }).catch(() => undefined)
      }
      await react($, 'sad', cause.label, 10_000)
    } else {
      await react($, hasFailed ? 'sad' : 'happy', hasFailed ? firstLine(e.command, 200) : '', hasFailed ? 8000 : 4000)
    }
    if (!hasFailed && isPush) {
      await startPushWatch($)
    }
    if (!hasFailed && /\bpnpm\b/.test(e.command) && !/--frozen-lockfile/.test(e.command)) {
      void checkLockfile($)
    }
    void refreshBranch($)
    return ran
  })

  on('command.run', { command: 'bit' }, async ($, e) => ({ text: await runBit($, e.args) }))

  on('classic.Notification', async ($, e, next) => {
    local.needsYou = e.notification_type.replace(/_prompt$/, '').replace(/_/g, ' ') || 'input'
    // An idle prompt is the normal wait after a turn; anything else is a question or permission waiting on you.
    if (e.notification_type !== 'idle_prompt') {
      await update($, attentionAtom, () => true)
    }
    void publish($)
    return next(e)
  })

  on('classic.PreModelSwitch', async ($, e, next) => {
    if (e.prompt_cache_warm && e.estimated_cache_write_usd >= 0.05) {
      $.ui.toast(
        `Switching to ${e.to_model} drops the warm cache: re-writing ${fmtTokens(e.context_tokens)} tokens costs about ${usd(e.estimated_cache_write_usd)}.`,
        { timeoutMs: 10_000 },
      )
    }
    return next(e)
  })

  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source !== 'startup' || result.sessionTitle !== undefined) {
      return result
    }
    const title = await ticketTitle($)
    return title === null ? result : { ...result, sessionTitle: title }
  })

  on('ui.render', { component: 'Pane', requestId: WORKTREE_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const scan = await read($, worktreesAtom)
    const isScanning = await read($, scanningAtom)
    const now = await $.clock.now()
    const header = (
      <Box key="wt-head" flexDirection="row" gap={1} marginBottom={1}>
        <Button key="wt-scan" label={isScanning ? 'scanning…' : 'rescan'} onPress={() => void refreshWorktrees($)} />
        {scan !== null && (
          <Text dimColor>{`${scan.rows.length} worktrees · ${scan.rows.filter(row => row.isMerged).length} merged · ${scan.rows.filter(row => now - row.lastCommitAt > STALE_DRAFT_MS).length} idle >14d`}</Text>
        )}
      </Box>
    )
    if (scan === null) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>{isScanning ? 'Scanning worktrees…' : 'No scan yet.'}</Text>
        </Box>
      )
    }
    const rows = [...scan.rows].sort((a, b) => Number(b.isMerged) - Number(a.isMerged) || a.lastCommitAt - b.lastCommitAt)
    return (
      <Box flexDirection="column">
        {header}
        {scan.isBare && (
          <Box key="wt-bare" flexDirection="row" gap={1} marginBottom={1}>
            <Text color="red">core.bare=true breaks every worktree</Text>
            <Button key="wt-bare-fix" label="Fix" variant="primary" onPress={() => void fixBare($)} />
          </Box>
        )}
        {rows.map(row => (
          <Box key={`wt-${row.path}`} flexDirection="row" gap={1}>
            <Box key={`wt-age-${row.path}`} flexShrink={0}>
              <Text color={now - row.lastCommitAt > STALE_DRAFT_MS ? 'yellow' : 'gray'}>
                {row.lastCommitAt === 0 ? '  ?' : formatAge(now - row.lastCommitAt).padStart(4)}
              </Text>
            </Box>
            <Box key={`wt-tag-${row.path}`} flexShrink={0}>
              <Text color={row.isMerged ? 'green' : 'gray'}>{row.isMain ? 'main  ' : row.isCurrent ? 'here  ' : row.isMerged ? 'merged' : '      '}</Text>
            </Box>
            <Text wrap="truncate-middle">{row.branch}</Text>
            {!row.isMain && !row.isCurrent && (
              <Button key={`wt-rm-${row.path}`} label="remove" onPress={() => void removeWorktree($, row)} />
            )}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: ACTIONS_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const favorite = await read($, favoriteAtom)
    const usage = await read($, usageAtom)
    const isWorking = await read($, runningAtom)
    return (
      <Box flexDirection="column">
        <Text dimColor>★ marks the button the band shows</Text>
        {ACTIONS.map(action => (
          <Box key={`row-${action.id}`} flexDirection="row" alignItems="center" gap={1}>
            <Button
              key={`fav-${action.id}`}
              plain
              label={action.id === favorite ? '★' : '☆'}
              dimColor={action.id !== favorite}
              onPress={() => void setFavorite($, action.id)}
            />
            <Box key={`act-box-${action.id}`} width={11} flexShrink={0}>
              <Button
                key={`act-${action.id}`}
                label={actionLabel(action, usage)}
                dimColor={needsIdle(action) && isWorking}
                onPress={() => runAction($, action, isWorking)}
              />
            </Box>
            <Text dimColor wrap="truncate-end">{action.hint}</Text>
          </Box>
        ))}
      </Box>
    )
  })

  // While the band fits, the wheel over it scrolls the Sessions list; a band taller than its room scrolls as the engine's.
  on('ui.scroll', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.origin.kind !== 'person' || e.contentRows > e.bodyRows || local.sessionsTotal <= local.sessionsShown) {
      return next(e)
    }
    await scrollSessions($, e.by)
    return {}
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    local.sessionsTotal = 0
    if (e.props.hasSurvey) {
      return next(e)
    }
    if (await read($, hiddenAtom)) {
      if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
      const { Box, Button } = $.ui.resolve(e)
      return (
        <Box flexDirection="row" justifyContent="flex-end">
          <Button key="pet-reopen" plain dimColor label={`🐾 ${PET}`} onPress={() => void update($, hiddenAtom, () => false)} />
        </Box>
      )
    }
    const layout = bandLayout(e.props.bodyColumns)
    const fit = LAYOUT[layout]
    const isNarrow = layout === 'narrow'
    const mood = await read($, moodAtom)
    const plan = await read($, planAtom)
    const github = await read($, githubAtom)
    const branch = await read($, branchAtom)
    const others = (await read($, othersAtom)).filter(other => !local.isDemo || other.sessionId.startsWith(DEMO_SESSION_PREFIX))
    const isRefreshing = await read($, refreshingAtom)
    const win = await read($, winAtom)
    const pushWatch = await read($, pushWatchAtom)
    const slackView = await read($, slackAtom)
    const slack: SlackView = local.isDemo ? { ...slackView, unread: slackView.unread.filter(item => item.ts.startsWith(DEMO_TS_PREFIX)) } : slackView
    const usage = await read($, usageAtom)
    const now = await $.clock.now()
    const isWorking = e.props.isWorking
    const lastActiveAt = await read($, lastActiveAtom)
    const pose: Pose =
      mood.kind !== 'idle'
        ? mood.kind
        : (await read($, attentionAtom))
          ? 'attention'
          : isWorking
            ? 'working'
            : lastActiveAt > 0 && now - lastActiveAt > SLEEP_AFTER_MS
              ? 'sleeping'
              : 'idle'
    const slackConvos = slackConversations(slack, await read($, slackMarksAtom), now)
    const slackWaiting = slackConvos.reduce((sum, convo) => sum + convo.count, 0)
    const newestSlack = slack.unread.filter(item => item.seenAt > 0).sort((a, b) => b.seenAt - a.seenAt)[0]
    // A message that just arrived takes over the line for 15 seconds, then the conversations come back.
    const flashSlack = newestSlack !== undefined && now - newestSlack.seenAt < SLACK_SHOW_MS ? newestSlack : undefined

    const done = countDone(plan.tasks)
    const hasPlan = isActive(plan)
    let pet
    let progressBar = null
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const frame = await read($, frameAtom)
      pet = <Raster key="pet" columns={WIDTH} rows={HEIGHT / 2} cells={toRasterCells(drawDog(pose, frame))} />
    } else if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      pet = (
        <Svg
          source={animatedSvg(pose)}
          alt={`${PET} is ${pose}`}
          width={WIDTH * PIXEL_PX}
          height={HEIGHT * PIXEL_PX}
          isInteractive
        />
      )
      progressBar = (
        <Svg
          source={progressSvg(done, plan.tasks.length)}
          alt={`${done} of ${plan.tasks.length} tasks done`}
          width={PROGRESS_W}
          height={PROGRESS_H}
          isInteractive
        />
      )
    } else {
      return next(e)
    }

    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Link } = ui
    let slackCountdown = null
    if (flashSlack !== undefined && e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      slackCountdown = <Svg source={countdownSvg(now - flashSlack.seenAt)} alt="back to conversations soon" width={46} height={12} isInteractive />
    } else if (flashSlack !== undefined) {
      slackCountdown = <Text color="magenta">{'·'.repeat(Math.max(1, Math.ceil((SLACK_SHOW_MS - (now - flashSlack.seenAt)) / SLACK_DOT_MS)))}</Text>
    }
    const [filled, empty] = miniBar(done, plan.tasks.length, 24)
    const elapsed = plan.startedAt === null ? '' : ` · ${formatAge((plan.endedAt ?? now) - plan.startedAt)}`
    const background = await read($, backgroundAtom)
    const needy = others.filter(other => other.needsYou)
    // Sessions waiting on you first, then the running ones, then merged, then idle.
    const sessions = [...others].sort((a, b) => sessionRank(a) - sessionRank(b))
    const sessionsShown = fit.sessions
    const sessionsOffset = Math.min(await read($, sessionsOffsetAtom), Math.max(0, sessions.length - sessionsShown))
    const sessionsBelow = Math.max(0, sessions.length - sessionsOffset - sessionsShown)

    const favorite = actionById(await read($, favoriteAtom))
    const actionRow = (
      <Box key="pet-actions" flexDirection="row" gap={1}>
        <Button
          key="pet-favorite"
          label={actionLabel(favorite, usage)}
          variant="primary"
          dimColor={needsIdle(favorite) && isWorking}
          onPress={() => runAction($, favorite, isWorking)}
        />
        <Button key="pet-actions-open" label="actions" onPress={() => void $.ui.open({ id: ACTIONS_PANE, title: 'Actions' })} />
      </Box>
    )

    const status = (
      <Box key="pet-status" flexDirection="column" marginLeft={fit.planGap} marginTop={isNarrow ? 1 : 0} flexShrink={1} minWidth={fit.planMin}>
        {mood.kind === 'happy' && mood.text !== '' && (
          <Text color="green" wrap="truncate-end">
            ✓ {mood.text}
          </Text>
        )}
        {mood.kind === 'sad' && (
          <Text color="red" wrap="truncate-end">
            ✗ {mood.text}
          </Text>
        )}
        {hasPlan && (
          <Box key="pet-phases" flexDirection="row" columnGap={1}>
            {PHASES.map(phase =>
              phase === plan.phase ? (
                <Text key={`pp-${phase}`} color="cyan">{`● ${phase}`}</Text>
              ) : (
                <Text key={`pp-${phase}`} dimColor>{`○ ${phase}`}</Text>
              ),
            )}
          </Box>
        )}
        <Box key="pet-plan-line" flexDirection="row">
          {!hasPlan && <Text color="cyan">{(isWorking ? 'working' : 'idle') + ' '}</Text>}
          <Box key="pet-plan-bar" flexDirection="row" alignItems="center" gap={1}>
            {progressBar ?? (
              <Text>
                <Text color="green">{filled}</Text>
                <Text dimColor>{empty}</Text>
              </Text>
            )}
            <Text bold>{`${done}/${plan.tasks.length}`}</Text>
          </Box>
          <Text dimColor>{elapsed}</Text>
          {background.length > 0 && <Text color="cyan">{` · ⟳ ${background.length} in background`}</Text>}
        </Box>
        {hasPlan && (
          <Box key="pet-tasks" flexDirection="column">
            {visibleTasks(plan.tasks, fit.tasks).map(task => (
              <Box key={`pt-${task.id}`} flexDirection="row" gap={1}>
                {task.status === 'completed' ? (
                  <Text color="green">✔</Text>
                ) : task.status === 'in_progress' ? (
                  <Text color="yellow">▶</Text>
                ) : (
                  <Text dimColor>○</Text>
                )}
                <Text
                  dimColor={task.status !== 'in_progress'}
                  strikethrough={task.status === 'completed'}
                  bold={task.status === 'in_progress'}
                  wrap="truncate-end"
                >
                  {task.status === 'in_progress' ? (task.activeForm ?? task.subject) : task.subject}
                </Text>
              </Box>
            ))}
          </Box>
        )}
        {background.length > 0 && (
          <Box key="pet-background" flexDirection="row">
            <Text dimColor wrap="truncate-end">
              {background.map(task => `${task.type}: ${clip(task.description, 50)}`).join(' · ')}
            </Text>
          </Box>
        )}
        {branch !== null && (branch.globals.length > 0 || github.current?.previewUrl) && (
          <Box key="pet-hygiene" flexDirection="row" gap={1}>
            {github.current?.previewUrl && <Link href={github.current.previewUrl} label="preview" />}
            {branch.globals.length > 0 && (
              <Text color="yellow" wrap="truncate-end">{`${branch.globals[0]} changed: every app rebuilds and redeploys`}</Text>
            )}
          </Box>
        )}
        {win !== null && now - win.at < WIN_SHOW_MS && (
          <Box key="pet-win" flexDirection="row" gap={1}>
            <Text color="green">{`merged ${win.key}`}</Text>
            <Button key="pet-impact" label="watch impact" variant="primary" onPress={() => watchImpact($, win)} />
            <Button key="pet-logwin" label="log win" onPress={() => logWin($, win)} />
          </Box>
        )}
        {pushWatch !== null && now - pushWatch.at < PUSH_WATCH_MS && (
          <Box key="pet-push" flexDirection="row" gap={1}>
            <Text color="cyan">
              {now - pushWatch.at < CODERABBIT_MS
                ? `CodeRabbit re-review in ~${Math.ceil((CODERABBIT_MS - (now - pushWatch.at)) / 60_000)}m on ${pushWatch.key}`
                : `CodeRabbit should have re-reviewed ${pushWatch.key}`}
            </Text>
            <Button key="pet-cr-reply" label="draft replies" onPress={() => draftCodeRabbitReplies($, pushWatch)} />
          </Box>
        )}
      </Box>
    )

    const queue = (
      <Box key="pet-sessions" flexDirection="column" flexShrink={1} minWidth={fit.sessionsMin}>
        <Box key="pet-sessions-label" flexDirection="row" gap={1}>
          <Text bold>Sessions</Text>
          <Text color={needy.length > 0 ? 'yellow' : 'gray'}>{String(sessions.length)}</Text>
          {needy.length > 0 && <Text color="yellow">{`${needy.length} need you`}</Text>}
        </Box>
        <Box key="pet-sessions-rows" flexDirection="column" flexShrink={1}>
          {sessions.length === 0 && <Text dimColor>no other sessions</Text>}
          {sessions.slice(sessionsOffset, sessionsOffset + sessionsShown).map(other => {
            const [mark, text, color] = sessionState(other)
            const gist = sessionGist(other)
            return (
              <Box key={`ss-${other.sessionId}`} flexDirection="row" gap={1}>
                <Text color={color}>{mark}</Text>
                <Box key={`ss-name-${other.sessionId}`} flexShrink={0}>
                  <Button key={`ss-open-${other.sessionId}`} plain label={clip(sessionName(other), fit.nameWidth)} onPress={() => void openSession($, other)} />
                </Box>
                <Box key={`ss-state-${other.sessionId}`} flexShrink={0}>
                  <Text color={color} dimColor={color === 'gray'}>{text}</Text>
                </Box>
                {other.pr && (
                  <Box key={`ss-pr-${other.sessionId}`} flexShrink={0}>
                    <Link href={other.pr.url} label={other.pr.key} />
                  </Box>
                )}
                {gist !== '' && <Text dimColor wrap="truncate-end">{clip(gist, 72)}</Text>}
              </Box>
            )
          })}
          {sessions.length > sessionsShown && (
            <Box key="pet-sessions-scroll" flexDirection="row" gap={2}>
              {sessionsOffset > 0 && (
                <Button key="pet-sessions-up" plain dimColor label={`▲ ${sessionsOffset} above`} onPress={() => void scrollSessions($, -sessionsShown)} />
              )}
              {sessionsBelow > 0 && (
                <Button key="pet-sessions-down" plain dimColor label={`▼ ${sessionsBelow} more`} onPress={() => void scrollSessions($, sessionsShown)} />
              )}
            </Box>
          )}
        </Box>
      </Box>
    )

    const cacheLine = await drawCacheLine($, ui, isWorking)
    const isCollapsed = await read($, collapsedAtom)
    const slackChip =
      slackWaiting > 0 ? (
        <Text key="pet-slack-count" color="magenta" bold>{`Slack ${slackWaiting}`}</Text>
      ) : null
    const caret = (
      <Button
        key="pet-collapse"
        label={isCollapsed ? '▸' : '▾'}
        plain
        onPress={() => void toggleCollapsed($)}
      />
    )
    if (isCollapsed) {
      const failing = github.mine.filter(pr => pr.ci === 'failing').length
      return (
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
          {caret}
          {slackChip}
          <Text bold color={mood.kind === 'happy' ? 'green' : mood.kind === 'sad' ? 'red' : undefined}>
            {mood.kind === 'happy' ? `${PET} ✓` : mood.kind === 'sad' ? `${PET} ✗` : PET}
          </Text>
          {failing > 0 && <Text color="red">{`${failing} PR CI failing`}</Text>}
          {github.masterCi === 'failing' && <Text color="red">master CI ✗</Text>}
          {needy.length > 0 && <Text color="yellow">{`${needy.length} session${needy.length === 1 ? '' : 's'} need you`}</Text>}
          <Text dimColor>·</Text>
          {cacheLine}
        </Box>
      )
    }
    local.sessionsTotal = sessions.length
    local.sessionsShown = sessionsShown
    return (
      <Box flexDirection="row" alignItems="flex-start" columnGap={2}>
        <Box key="pet-col" flexDirection="column" alignItems="center" flexShrink={0}>
          {pet}
          <Text color={POSE_LABEL[pose][1]} bold={pose === 'attention'} dimColor={pose === 'sleeping'}>
            {pose === 'sleeping' ? `asleep · ${formatAge(now - lastActiveAt)} idle` : POSE_LABEL[pose][0]}
          </Text>
        </Box>
        <Box key="pet-main" flexDirection="column" flexShrink={1} flexGrow={1}>
          {(flashSlack !== undefined || slackConvos.length > 0) && (
            <Box key="pet-slack" flexDirection="row" alignItems="flex-start" gap={1} marginBottom={1}>
              <Box key="pet-slack-label" flexShrink={0}>
                <Text color="magenta" bold>
                  Slack
                </Text>
              </Box>
              <Box key="pet-slack-rows" flexDirection="column" flexShrink={1}>
                {flashSlack !== undefined && (
                  <Box key="pet-slack-flash" flexDirection="row" alignItems="center" gap={1}>
                    <Text bold wrap="truncate-end">{`${flashSlack.from}: ${clip(flashSlack.text, 90)}`}</Text>
                    {slackCountdown}
                    {flashSlack.url !== null && <Link href={flashSlack.url} label="open" />}
                    <Button key="pet-slack-flash-done" plain label="✓" onPress={() => void dismissSlack($, flashSlack.channelId, slackTime(flashSlack))} />
                  </Box>
                )}
                {slackConvos.slice(0, fit.slack).map(convo => {
                  const latest = convo.waiting.at(-1)
                  return (
                    <Box key={`sc-${convo.channelId}`} flexDirection="row" alignItems="center" gap={1}>
                      <Box key={`sc-name-${convo.channelId}`} flexShrink={0}>
                        {convo.url !== null ? <Link href={convo.url} label={convo.name} /> : <Text>{convo.name}</Text>}
                      </Box>
                      <Text color="magenta" bold>
                        {String(convo.count)}
                      </Text>
                      {latest !== undefined && (
                        <Text dimColor italic wrap="truncate-end">{`${latest.from}: “${clip(latest.text, 70)}”`}</Text>
                      )}
                      {convo.url !== null && <Link href={convo.url} label="open" />}
                      <Button key={`sc-done-${convo.channelId}`} plain label="✓" onPress={() => void dismissSlack($, convo.channelId, convo.latestTs)} />
                    </Box>
                  )
                })}
                {slackConvos.length > 0 && (
                  <Box key="pet-slack-foot" flexDirection="row" gap={1}>
                    {slackConvos.length > fit.slack && <Text dimColor>{`+${slackConvos.length - fit.slack} more ·`}</Text>}
                    <Button key="pet-slack-clear" plain dimColor label="clear all" onPress={() => void clearSlack($)} />
                  </Box>
                )}
              </Box>
            </Box>
          )}
          <Box key="pet-row" flexDirection={isNarrow ? 'column' : 'row'} flexWrap={layout === 'wide' ? 'wrap' : 'nowrap'} alignItems="flex-start">
            {queue}
            {status}
          </Box>
          {branch !== null && (
            <Box key="pet-branch" flexDirection="row" flexWrap="wrap" columnGap={1} justifyContent={isNarrow ? 'flex-start' : 'flex-end'}>
              {branch.ticket !== null && <Text color="cyan" bold>{branch.ticket}</Text>}
              <Text dimColor wrap="truncate-middle">{clip(branch.name, 32)}</Text>
              {branch.changed > 0 && <Text color="yellow">{`${branch.changed} changed`}</Text>}
              {(branch.ahead > 0 || branch.behind > 0) && (
                <Text color={branch.behind > 20 ? 'yellow' : 'gray'}>{`↑${branch.ahead} ↓${branch.behind}`}</Text>
              )}
              {branch.hasSlash && <Text color="yellow">{"'/' in name"}</Text>}
            </Box>
          )}
          <Box key="pet-bottom" flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={1}>
            {caret}
            {github.masterCi === 'failing' && <Text color="red" bold>master CI ✗</Text>}
            {cacheLine}
            {actionRow}
          </Box>
        </Box>
        <Box key="pet-close" flexShrink={0}>
          <Button key="pet-close-button" plain dimColor role="dismiss" label="✕" onPress={() => void update($, hiddenAtom, () => true)} />
        </Box>
      </Box>
    )
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      cacheLocal.model = e.model
      const at = await $.clock.now()
      await update($, cacheAtAtom, () => at)
    }

    return yield* next(e)
  })

  on('classic.UserPromptSubmit', ($, e, next) => {
    cacheLocal.transcriptPath = e.transcript_path

    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    cacheLocal.transcriptPath = e.transcript_path
    void refreshCacheTtl($)
    const tasks = (e as { background_tasks?: { id: string; type: string; description: string }[] }).background_tasks
    if (Array.isArray(tasks)) {
      await update($, backgroundAtom, () => tasks.map(task => ({ id: task.id, type: task.type, description: task.description })))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (e.background) {
      await addBackground($, { id: e.tool_use_id, type: 'subagent', description: e.description })
    }
    return spawned
  })

  on('session.measure', async ($, e, next) => {
    await update($, usageAtom, () => toUsage(e.context, e.rateLimits, cacheLocal.model ?? ''))

    return next(e)
  })

  on('command.run', { command: 'cache-keeper' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().split(/\s+/)

    if (sub === 'ttl') {
      if (arg === 'auto' || arg === '') {
        await $.store.delete(STORE_TTL_OVERRIDE)
      } else {
        const minutes = Number(arg)
        if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
          return { text: 'Cache Keeper: give the cache window in minutes (1-1440), or `auto`.' }
        }
        await $.store.set(STORE_TTL_OVERRIDE, minutes)
      }
      await refreshCacheTtl($)
      const current = await read($, ttlAtom)

      return { text: `Cache Keeper: cache window is ${current.minutes} min (${current.source}).` }
    }

    if (sub === 'fresh' || sub === 'restart' || sub === 'handoff') {
      $.clock.after(0, () => void runHandoff($))

      return { text: 'Cache Keeper: summarizing, then starting a fresh session…' }
    }

    const current = await read($, ttlAtom)
    const at = await read($, cacheAtAtom)
    const remaining = at === null ? null : at + current.minutes * 60_000 - (await $.clock.now())

    return {
      text: [
        `Cache window: ${current.minutes} min (${current.source}).`,
        `Cache: ${remaining === null ? 'no request yet' : remaining > 0 ? `warm for ${clock(remaining)}` : 'cold'}.`,
        'Usage: /cache-keeper ttl <minutes|auto> · /cache-keeper fresh',
      ].join('\n'),
    }
  })

  on('command.run', { command: 'critique' }, async $ => {
    await $.ui.open({ id: CRITIQUE_PANE, title: CRITIQUE_TITLE })
    launchCritique($)

    return { text: 'Self-Critique pane opened; reviewing the last response.' }
  })

  on('ui.render', { component: 'Pane', requestId: CRITIQUE_PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const critique = await read($, critiqueAtom)
    const status = await read($, statusAtom)
    const isAuto = await read($, isAutoAtom)
    const model = await read($, critiqueModelAtom)
    const sentFixes = await read($, sentFixesAtom)
    const sessionModel = await $.session.model()

    const pickModel = async (value: string) => {
      const picked = value as CritiqueModel
      await update($, critiqueModelAtom, () => picked)
      await $.store.set('critiqueModel', picked)
    }
    const toggleAuto = async () => {
      const turnedOn = await update($, isAutoAtom, value => !value)
      await $.store.set('critiqueAuto', turnedOn)
    }
    const makeFix = async (index: number, issue: string, fix: string) => {
      await update($, sentFixesAtom, list => [...list, index])
      await $.prompt.submit({
        text: `Self-critique flagged this in your last response: ${issue}\n\nFix it: ${fix}`,
        asUser: true,
      })
    }

    const modelOptions = MODELS.map(option => ({
      value: option.value,
      label: option.value === 'session' ? `${option.label} (${sessionModel})` : option.label,
    }))

    const Picker = 'Select' in ui ? ui.Select : undefined
    const picker =
      !Picker ? (
        <Box flexWrap="wrap" columnGap={1}>
          {modelOptions.map(option => (
            <Button
              key={`model-${option.value}`}
              label={`${option.value === model ? '● ' : ''}${option.label}`}
              dimColor={option.value !== model}
              onPress={() => pickModel(option.value)}
            />
          ))}
        </Box>
      ) : (
        <Picker key="model" label="Model: " options={modelOptions} value={model} onSelect={pickModel} />
      )

    const isRunning = status.phase === 'running'

    return (
      <Box flexDirection="column" rowGap={1}>
        <Box flexDirection="column">
          <Box flexWrap="wrap" columnGap={2}>
            <Button
              key="rerun"
              hotkey="r"
              variant="primary"
              label={isRunning ? 'Rerun (running…)' : 'Rerun'}
              onPress={() => launchCritique($)}
            />
            <Button key="auto" hotkey="a" label={`Auto: ${isAuto ? 'On' : 'Off'}`} onPress={toggleAuto} />
          </Box>
          {picker}
        </Box>

        {status.phase === 'running' && <Text dimColor>Reviewing the last response with {status.model}…</Text>}
        {status.phase === 'error' && <Text color="red">{status.message}</Text>}

        {critique === null ? (
          status.phase === 'idle' && <Text dimColor>No critique yet. Press Rerun to review the last response.</Text>
        ) : (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="column">
              <Text>
                <Text bold color={VERDICT_COLOR[critique.verdict]}>
                  ● {critique.verdict}
                </Text>
                <Text dimColor>
                  {'  '}
                  {critique.model} · {clockTime(critique.at)}
                </Text>
              </Text>
              <Text dimColor wrap="truncate-end">
                Re: “{critique.excerpt}”
              </Text>
            </Box>

            {critique.summary !== '' && <Text>{critique.summary}</Text>}

            <Box flexDirection="column">
              <Text bold>Strengths</Text>
              {critique.strengths.length === 0 && <Text dimColor>None noted.</Text>}
              {critique.strengths.map(strength => (
                <Text>
                  <Text color="green">+ </Text>
                  {strength}
                </Text>
              ))}
            </Box>

            <Box flexDirection="column" rowGap={1}>
              <Text bold>Flaws</Text>
              {critique.flaws.length === 0 && <Text dimColor>None found.</Text>}
              {critique.flaws.map((flaw, index) => {
                const isSent = sentFixes.includes(index)

                return (
                  <Box flexDirection="column">
                    <Text>
                      <Text color="red">{index + 1}. </Text>
                      {flaw.issue}
                    </Text>
                    <Text dimColor>   Fix: {flaw.fix}</Text>
                    <Box paddingLeft={3}>
                      {isSent ? (
                        <Text color="green">Sent to Claude</Text>
                      ) : (
                        <Button
                          key={`fix-${index}`}
                          hotkey={index < 9 ? String(index + 1) : undefined}
                          label="Make this fix"
                          onPress={() => makeFix(index, flaw.issue, flaw.fix)}
                        />
                      )}
                    </Box>
                  </Box>
                )
              })}
            </Box>
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const view = await read($, viewAtom)
    const isMuted = await read($, mutedAtom)
    const now = await $.clock.now()
    const columns = Math.max(24, e.props.bodyColumns)

    const bar = (done: number, total: number, key: string) => {
      const pct = percentOf(done, total)
      const width = Math.max(8, columns - 6)
      const filled = Math.round((pct / 100) * width)
      return (
        <Box key={key} flexDirection="row">
          <Text color="green">{'█'.repeat(filled)}</Text>
          <Text dimColor>{'░'.repeat(width - filled)}</Text>
          <Text bold>{` ${pct}%`}</Text>
        </Box>
      )
    }

    const elapsedOf = (startedAt: number | null, endedAt: number | null) =>
      startedAt === null ? '—' : formatElapsed((endedAt ?? now) - startedAt)

    const tabs = (
      <Box key="tabs" flexDirection="row" gap={1} marginBottom={1}>
        <Button
          key="tab-plan"
          label="Plan"
          hotkey="p"
          {...(view === 'plan' ? { variant: 'primary' as const } : {})}
          onPress={() => void update($, viewAtom, () => 'plan')}
        />
        <Button
          key="tab-all"
          label="All tasks"
          hotkey="a"
          {...(view === 'all' ? { variant: 'primary' as const } : {})}
          onPress={() => void openPane($, 'all')}
        />
        <Button
          key="mute"
          label={isMuted ? 'Sound: off' : 'Sound: on'}
          hotkey="s"
          onPress={() => {
            void update($, mutedAtom, muted => !muted)
            void $.store.set('isMuted', !isMuted)
          }}
        />
      </Box>
    )

    if (view === 'all') {
      const self = await snapshotOf($)
      const others = await read($, othersAtom)
      const rows = [...(isActive(await read($, planAtom)) ? [self] : []), ...others]
      return (
        <Box flexDirection="column">
          {tabs}
          {rows.length === 0 && (
            <Text dimColor wrap="wrap">
              No session is running a goal or a task list. Sessions show here when they load this mod.
            </Text>
          )}
          {rows.map(row => (
            <Box key={`s-${row.sessionId}`} flexDirection="column" marginBottom={1}>
              <Box flexDirection="row" gap={1}>
                <Text color={row.isRunning ? 'green' : 'gray'}>{row.isRunning ? '●' : '○'}</Text>
                <Text bold wrap="truncate-end">{row.project}</Text>
                <Text dimColor>
                  {row.sessionId === local.sessionId ? '(this session) ' : ''}
                  {row.phase ?? '—'} · {elapsedOf(row.startedAt, row.endedAt)}
                </Text>
              </Box>
              <Text wrap="truncate-end">{row.goal ?? 'No goal set'}</Text>
              {bar(row.done, row.total, `bar-${row.sessionId}`)}
              <Text dimColor>
                {row.done}/{row.total} tasks{row.endedAt !== null ? ' · done' : ''}
              </Text>
            </Box>
          ))}
        </Box>
      )
    }

    const plan = await read($, planAtom)
    if (!isActive(plan)) {
      return (
        <Box flexDirection="column">
          {tabs}
          <Text dimColor wrap="wrap">
            No plan yet. This pane fills in when Claude builds a task list or you set a /goal.
          </Text>
        </Box>
      )
    }

    const done = countDone(plan.tasks)
    return (
      <Box flexDirection="column">
        {tabs}
        <Text bold>{plan.isGoal ? 'Goal' : 'Task'}</Text>
        <Text wrap="wrap">{plan.goal ?? '—'}</Text>
        <Box key="phases" flexDirection="row" flexWrap="wrap" columnGap={2} marginTop={1}>
          {PHASES.map(phase =>
            phase === plan.phase ? (
              <Text key={`p-${phase}`} bold color="cyan">
                ● {phase}
              </Text>
            ) : (
              <Text key={`p-${phase}`} dimColor>
                ○ {phase}
              </Text>
            ),
          )}
        </Box>
        <Box key="progress" flexDirection="column" marginTop={1}>
          {bar(done, plan.tasks.length, 'bar-self')}
          <Text dimColor>
            {done}/{plan.tasks.length} tasks · {elapsedOf(plan.startedAt, plan.endedAt)}
            {plan.endedAt !== null ? ' · done' : ''}
          </Text>
        </Box>
        <Box key="tasks" flexDirection="column" marginTop={1}>
          {plan.tasks.map(task => {
            if (task.status === 'completed') {
              return (
                <Box key={`t-${task.id}`} flexDirection="row" gap={1}>
                  <Text color="green">✔</Text>
                  <Text dimColor strikethrough wrap="wrap">
                    {task.subject}
                  </Text>
                </Box>
              )
            }
            if (task.status === 'in_progress') {
              return (
                <Box key={`t-${task.id}`} flexDirection="row" gap={1}>
                  <Text color="yellow">▶</Text>
                  <Text bold wrap="wrap">
                    {task.activeForm ?? task.subject}
                  </Text>
                </Box>
              )
            }
            return (
              <Box key={`t-${task.id}`} flexDirection="row" gap={1}>
                <Text dimColor>○</Text>
                <Text wrap="wrap">{task.subject}</Text>
              </Box>
            )
          })}
        </Box>
      </Box>
    )
  })
}

const stripUndefined = <T extends object>(value: T): Partial<T> =>
  Object.fromEntries(Object.entries(value).filter(([, one]) => one !== undefined)) as Partial<T>
