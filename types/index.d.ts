export type MoodKind = 'idle' | 'happy' | 'sad'

export type Mood = {
  kind: MoodKind
  text: string
  until: number
}

export type PlanPhase = 'researching' | 'planning' | 'building' | 'testing' | 'auditing'

export type PlanTaskStatus = 'pending' | 'in_progress' | 'completed'

export type PlanTask = {
  id: string
  subject: string
  activeForm: string | null
  status: PlanTaskStatus
}

export type Plan = {
  goal: string | null
  isGoal: boolean
  phase: PlanPhase | null
  tasks: PlanTask[]
  startedAt: number | null
  endedAt: number | null
}

export type PlanSnapshot = {
  sessionId: string
  project: string
  goal: string | null
  task?: string | null
  phase: PlanPhase | null
  done: number
  total: number
  startedAt: number | null
  endedAt: number | null
  updatedAt: number
  isRunning: boolean
  needsYou?: string | null
  // The desktop app's own id for the session (`local_…`); it differs from `sessionId` after a hand-off or resume.
  hostSessionId?: string | null
  // The session branch's PR, open or merged; a snapshot from an older Bit has none.
  pr?: SessionPr | null
  // The title the desktop app shows for the session; a snapshot from an older Bit has none.
  title?: string | null
}

export type SessionPr = {
  key: string
  url: string
  isMerged: boolean
}

export type PlanView = 'plan' | 'all'

export type BackgroundTask = {
  id: string
  type: string
  description: string
}

export type ReviewItem = {
  key: string
  repo: string
  number: number
  title: string
  url: string
  author: string
  waitingSince: number
  size: number
  isSquad: boolean
  isFanOut: boolean
  isAuthorsTurn: boolean
}

export type CiState = 'passing' | 'failing' | 'running' | 'none'

export type ReviewState = 'approved' | 'changes' | 'pending'

export type MyPr = {
  key: string
  repo: string
  number: number
  title: string
  url: string
  isDraft: boolean
  ci: CiState
  review: ReviewState
  isBotBlocking: boolean
  size: number
  isStacked: boolean
  headRef: string
  isMergeable: boolean
  updatedAt: number
}

export type CurrentPr = {
  key: string
  url: string
  approvals: number
  previewUrl: string | null
  isMerged: boolean
}

export type GitHubView = {
  reviews: ReviewItem[]
  reviewCount: number
  mine: MyPr[]
  fetchedAt: number | null
  error: string | null
  masterCi: CiState
  current: CurrentPr | null
}

export type BranchState = {
  name: string
  ticket: string | null
  changed: number
  ahead: number
  behind: number
  globals: string[]
  hasSlash: boolean
}

export type Win = {
  key: string
  title: string
  url: string
  at: number
}

export type PushWatch = {
  key: string
  url: string
  at: number
}

export type WorktreeRow = {
  path: string
  branch: string
  lastCommitAt: number
  isMerged: boolean
  isMain: boolean
  isCurrent: boolean
}

export type WorktreeScan = {
  rows: WorktreeRow[]
  isBare: boolean
  scannedAt: number
}

export type CacheKeeperTtlSource = 'detected' | 'manual' | 'default'

export type CacheKeeperTtl = { minutes: number; source: CacheKeeperTtlSource }

export type CacheKeeperLimit = { percentUsed: number; resetsAt: string | null }

export type CacheKeeperUsage = {
  contextTokens: number | null
  contextWindow: number
  contextPercent: number | null
  fiveHour: CacheKeeperLimit | null
  weekly: CacheKeeperLimit | null
  model: string
}

export type CacheKeeperHandoff = 'idle' | 'writing' | 'clearing'

export type CritiqueVerdict = 'Strong' | 'Mixed' | 'Weak'

export type CritiqueFlaw = { issue: string; fix: string }

export type Critique = {
  verdict: CritiqueVerdict
  summary: string
  strengths: string[]
  flaws: CritiqueFlaw[]
  model: string
  excerpt: string
  at: number
}

export type CritiqueStatus =
  | { phase: 'idle' }
  | { phase: 'running'; model: string }
  | { phase: 'error'; message: string }

export type CritiqueModel = 'session' | 'opus' | 'sonnet' | 'haiku'

export type SlackItem = {
  ts: string
  from: string
  where: string
  text: string
  url: string | null
  seenAt: number
  channelId: string
  convo: string
}

export type SlackMarks = {
  replied: Record<string, string>
  dismissed: Record<string, string>
}

export type SlackView = {
  unread: SlackItem[]
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'pixel-pet': {
      mood: Mood
      frame: number
      isHidden: boolean
      isCollapsed: boolean
      favoriteAction: string
      needsAttention: boolean
      lastActiveAt: number
      plan: Plan
      view: PlanView
      others: PlanSnapshot[]
      isRunning: boolean
      isMuted: boolean
      github: GitHubView
      branch: BranchState | null
      isRefreshing: boolean
      win: Win | null
      pushWatch: PushWatch | null
      squad: string[]
      worktrees: WorktreeScan | null
      isScanningWorktrees: boolean
      slack: SlackView
      slackMarks: SlackMarks
      lastRequestAt: number | null
      now: number
      ttl: CacheKeeperTtl
      usage: CacheKeeperUsage | null
      handoff: CacheKeeperHandoff
      critique: Critique | null
      critiqueStatus: CritiqueStatus
      isCritiqueAuto: boolean
      critiqueModel: CritiqueModel
      sentFixes: number[]
      background: BackgroundTask[]
    }
  }
}
