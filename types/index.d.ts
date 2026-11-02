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
  // When the session was opened; a snapshot from an older Bit has none.
  openedAt?: number | null
  // The ticket the session works on, from its branch or title; a snapshot from an older Bit has none.
  ticket?: string | null
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

export type BitLayout = 'band' | 'side-pane'

// A lane is drawn as steps; `lane` is the step in progress, the step count once every step is done.
export type TicketPr = {
  key: string
  number: number
  url: string
  title: string
  state: 'open' | 'draft' | 'merged'
  ci: CiState
  failing: string[]
  review: string
  isConfig: boolean
  lane: number
}

export type TicketVariant = {
  label: string
  url: string | null
  share: string
}

export type TicketExperiment = {
  name: string
  title: string
  url: string | null
  lane: number
  variants: TicketVariant[]
}

export type TicketDraft = {
  code: string
  config: string
  url: string | null
  hoursLeft: number
  change: string
}

export type TicketLinkKind = 'figma' | 'notion' | 'claude'

export type TicketLink = {
  kind: TicketLinkKind
  label: string
  url: string
}

export type TicketRelated = {
  id: string
  title: string
  url: string | null
}

export type TicketPerson = {
  name: string
  role: string
  url: string | null
}

export type TicketView = {
  id: string
  title: string
  url: string | null
  next: string
  tldr: string | null
  drafts: TicketDraft[]
  prs: TicketPr[]
  codeLane: number | null
  experiments: TicketExperiment[]
  links: TicketLink[]
  related: TicketRelated[]
  people: TicketPerson[]
  errors: string[]
  isCiRunning: boolean
  loadedAt: number
}

// A review thread still open whose last comment is not yours: it waits on your reply.
export type ReviewThread = {
  author: string
  text: string
  url: string | null
}

// Where review stands on one of the session's PRs.
export type SessionReview = {
  key: string
  url: string
  decision: 'approved' | 'changes' | 'pending'
  changesBy: string[]
  requested: string[]
  waiting: ReviewThread[]
}

// A session in this one's linked family, as the desktop app lists it.
export type LinkedSession = {
  id: string
  title: string
  isRunning: boolean
  lastActivityAt: number
}

// A subagent of this session that has not finished.
export type RunningAgent = {
  id: string
  description: string
  type: string
  isWaiting: boolean
}

export type SessionStats = {
  prs: TicketPr[]
  reviews: SessionReview[]
  errors: string[]
  loadedAt: number
}

export type ContextPart = {
  tokens: number
  color: string
}

export type ContextView = {
  tokens: number
  window: number
  percent: number
  parts: ContextPart[]
}

declare module 'claude-code' {
  interface PluginState {
    'pixel-pet': {
      mood: Mood
      frame: number
      isHidden: boolean
      isCollapsed: boolean
      sessionsOffset: number
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
      ticket: Shaped<TicketView | null>
      contextView: ContextView | null
      sessionTldr: string | null
      collapsedSections: Record<string, boolean>
      blinkUntil: Record<string, number>
      isWatchingPr: boolean
      sessionStats: Shaped<SessionStats | null>
      sessionPrUrls: string[]
      paneOffset: number
      sessionMode: { model: string; effort: string | null; fast: string | null } | null
      isKeepingWarm: boolean
      linkedSessions: LinkedSession[]
      runningAgents: RunningAgent[]
    }
  }
}
