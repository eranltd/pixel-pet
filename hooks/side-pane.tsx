import type { Elements, EngineInterface, RenderElement, RenderNode } from 'claude-code'

import type {
  CiState,
  ContextView,
  TicketDraft,
  TicketExperiment,
  TicketLink,
  TicketLinkKind,
  TicketPerson,
  TicketPr,
  TicketRelated,
  TicketVariant,
  TicketView,
  ReviewThread,
  SessionReview,
  SessionStats,
} from '../types'

// ---- side-pane: the ticket the session works on, beside the chat, with Bit's Sessions and Slack ----

export const SIDE_PANE = 'ticket'
// The app draws the pane tab; a title is all a mod gives it, so it says the session's state at a glance:
// a mark for running, waiting on you or idle, the ticket (else the session's title), and the plan's progress.
export const TAB_MARKS = { running: '🟢', waiting: '🟠', idle: '⚪' }
const TAB_NAME_MAX = 22

export function sidePaneTitle(mark: string, ticketId: string | null, sessionTitle: string, done: number, total: number): string {
  const name = ticketId ?? (sessionTitle === '' ? 'Bit' : sessionTitle.length > TAB_NAME_MAX ? `${sessionTitle.slice(0, TAB_NAME_MAX - 1)}…` : sessionTitle)
  return `${mark} ${name}${total > 0 ? ` · ${done}/${total}` : ''}`
}

// Each value names one source; empty hides the part that source feeds.
export type SidePaneSettings = {
  codeRepo: string
  configRepo: string
  linearServer: string
  slackDomain: string
  designer: string
  experimentType: string
  configCli: string
  draftPath: string
  variantQuery: string
  previewMarker: string
  previewLinkMatch: string
}

export type SidePaneContext = {
  id: string
  slackServer: string | null
  slackMe: string
  transcriptPath: string
  now: number
}

// A Link with an href the surface refuses would refuse the whole tree, so only clean https URLs pass.
export const safeUrl = (url: string | undefined): string | null => {
  if (url === undefined || url.length > 2048 || !/^https:\/\/[\x21-\x7e]+$/.test(url) || url.includes('@')) return null
  try {
    return new URL(url).href === url ? url : null
  } catch {
    return null
  }
}

const oneLine = (text: string, max: number) => {
  const line = text.trim().split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const TICKET_ID = /(?:^|[^a-z])([a-z]{2,6})-(\d{2,6})(?![a-z0-9])/i

export const ticketIdIn = (text: string): string | null => {
  const match = TICKET_ID.exec(text)
  return match?.[1] && match[2] ? `${match[1].toUpperCase()}-${match[2]}` : null
}

const errorText = (error: unknown) => oneLine(error instanceof Error ? error.message : String(error), 160)

type Ran = { exitCode: number; stdout: string; stderr: string }

function runCli($: EngineInterface, argv: string[], timeoutMs = 30_000): Promise<Ran | null> {
  return $.process.run(argv, { timeoutMs }).catch(() => null)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown) => (typeof value === 'string' ? value : '')

// Every string a JSON value holds, for finding links and ids in answers whose shape is loose.
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) value.forEach(one => stringsOf(one, out))
  else if (isRecord(value)) Object.values(value).forEach(one => stringsOf(one, out))
  return out
}

async function mcpJson($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<{ value: unknown } | { error: string }> {
  try {
    const result = await $.mcp.call(server, tool, args)
    const text = result.content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
    if (result.isError) return { error: oneLine(text || 'tool error', 160) }
    return { value: parseJson(text) ?? text }
  } catch (error) {
    return { error: errorText(error) }
  }
}

// Module facts a reload refills: which Linear server answered, which transcript was scanned for drafts,
// and your GitHub login, to tell the threads that wait on you.
const paneLocal = {
  linearServer: null as string | null,
  scannedTranscript: '',
  login: null as string | null,
}

// ---- Linear ----

type LinearIssue = {
  title: string
  url: string | null
  description: string
  createdBy: string
  assignee: string
  attachments: string[]
  related: TicketRelated[]
}

async function linearServers($: EngineInterface, preferred: string): Promise<string[]> {
  const names = new Set((await $.tool.list().catch(() => [])).map(tool => tool.name))
  const listed = [...names]
    .map(name => /^mcp__(.+)__get_issue$/.exec(name)?.[1])
    .filter((server): server is string => server !== undefined && names.has(`mcp__${server}__list_issue_statuses`))
  return [...new Set([preferred, paneLocal.linearServer ?? '', ...listed].filter(server => server !== ''))]
}

async function loadIssue($: EngineInterface, settings: SidePaneSettings, id: string, errors: string[]): Promise<{ issue: LinearIssue | null; comments: string[] }> {
  const failures: string[] = []
  for (const server of await linearServers($, settings.linearServer)) {
    const got = await mcpJson($, server, 'get_issue', { id, includeRelations: true })
    if ('error' in got || !isRecord(got.value)) {
      failures.push(`${server}: ${'error' in got ? got.error : 'unreadable answer'}`)
      continue
    }
    paneLocal.linearServer = server
    const raw = got.value
    const url = safeUrl(str(raw.url))
    const base = url === null ? null : url.replace(/\/issue\/.*$/, '/issue/')
    const relations = isRecord(raw.relations) ? raw.relations : {}
    const related: TicketRelated[] = []
    for (const value of Object.values(relations)) {
      for (const item of Array.isArray(value) ? value : value === null || value === undefined ? [] : [value]) {
        const relatedId = isRecord(item) ? ticketIdIn(str(item.identifier) || str(item.id)) : ticketIdIn(str(item))
        if (relatedId === null || relatedId === id || related.some(one => one.id === relatedId)) continue
        related.push({ id: relatedId, title: isRecord(item) ? str(item.title) : '', url: base === null ? null : safeUrl(`${base}${relatedId}`) })
      }
    }
    const comments = await mcpJson($, server, 'list_comments', { issueId: id, limit: 50 })
    if ('error' in comments) errors.push(`Linear comments: ${comments.error}`)
    return {
      issue: {
        title: str(raw.title),
        url,
        description: str(raw.description),
        createdBy: str(raw.createdBy),
        assignee: str(raw.assignee),
        attachments: (Array.isArray(raw.attachments) ? raw.attachments : []).map(one => (isRecord(one) ? str(one.url) : '')),
        related,
      },
      comments: 'error' in comments ? [] : stringsOf(comments.value),
    }
  }
  errors.push(failures.length === 0 ? 'Linear: no connected server has get_issue' : `Linear: ${failures.join(' | ')}`)
  return { issue: null, comments: [] }
}

// ---- pull requests ----

const PR_URL = /https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

type GhCheck = { name?: string; context?: string; status?: string; conclusion?: string; state?: string; startedAt?: string }

type GhPr = {
  number: number
  title: string
  url: string
  state: string
  isDraft: boolean
  reviewDecision: string
  statusCheckRollup: GhCheck[]
  body: string
  headRefName: string
  comments: { body: string }[]
}

// Only the newest run of each check counts; a cancelled or skipped run is no failure.
export function ciOfChecks(checks: readonly GhCheck[]): { ci: CiState; failing: string[] } {
  const newest = new Map<string, GhCheck>()
  for (const check of checks) {
    const name = check.name ?? check.context ?? ''
    const before = newest.get(name)
    if (before === undefined || (Date.parse(check.startedAt ?? '') || 0) >= (Date.parse(before.startedAt ?? '') || 0)) newest.set(name, check)
  }
  const failing: string[] = []
  let isRunning = false
  for (const [name, check] of newest) {
    const outcome = check.conclusion || check.state || ''
    if (FAILED.has(outcome)) failing.push(name)
    else if ((check.status !== undefined && check.status !== '' && check.status !== 'COMPLETED') || outcome === 'PENDING' || outcome === 'EXPECTED') isRunning = true
  }
  return { ci: failing.length > 0 ? 'failing' : isRunning ? 'running' : newest.size > 0 ? 'passing' : 'none', failing }
}

const plainTitle = (title: string) =>
  title
    .replace(/^\w+(\([^)]*\))?!?:\s*/, '')
    .replace(/\s*\[[A-Z]{2,6}-\d+\]\s*/g, ' ')
    .trim()

async function loadPrs(
  $: EngineInterface,
  settings: SidePaneSettings,
  id: string,
  attachments: string[],
  errors: string[],
): Promise<{ prs: TicketPr[]; raw: (GhPr & { repo: string })[] }> {
  const found = new Map<string, { repo: string; number: number; isLinked: boolean }>()
  const note = (isLinked: boolean) => (text: string) => {
    for (const match of text.matchAll(PR_URL)) {
      const key = `${match[1]}#${match[2]}`
      if (match[1] && match[2]) found.set(key, { repo: match[1], number: Number(match[2]), isLinked: isLinked || (found.get(key)?.isLinked ?? false) })
    }
  }
  attachments.forEach(note(true))
  const org = settings.codeRepo.split('/')[0] ?? ''
  if (org !== '') {
    const search = await runCli($, ['gh', 'search', 'prs', id, '--owner', org, '--json', 'url', '--limit', '30'])
    if (search === null || search.exitCode !== 0) errors.push(`GitHub search: ${oneLine(search?.stderr || 'gh is not installed', 140)}`)
    else stringsOf(parseJson(search.stdout)).forEach(note(false))
  }
  // GitHub search splits ABC-12 into words, so a hit counts only when it names the ticket itself.
  const namesTicket = new RegExp(`(^|[^a-z0-9])${id}(?![0-9])`, 'i')
  const raw = (
    await Promise.all(
      [...found.values()].map(async ({ repo, number, isLinked }) => {
        const pr = await viewPr($, repo, number, errors)
        return pr === null || (!isLinked && !namesTicket.test(`${pr.title}\n${pr.headRefName}\n${pr.body}`)) ? null : pr
      }),
    )
  ).filter((pr): pr is GhPr & { repo: string } => pr !== null && pr.state !== 'CLOSED')
  const prs = raw.map(pr => toTicketPr(pr, settings))
  prs.sort((a, b) => Number(a.isConfig) - Number(b.isConfig) || b.number - a.number)
  return { prs, raw }
}

async function viewPr($: EngineInterface, repo: string, number: number, errors: string[]): Promise<(GhPr & { repo: string }) | null> {
  const view = await runCli($, ['gh', 'pr', 'view', String(number), '-R', repo, '--json', 'number,title,url,state,isDraft,reviewDecision,statusCheckRollup,body,comments,headRefName'])
  if (view === null || view.exitCode !== 0) {
    errors.push(`${repo}#${number}: ${oneLine(view?.stderr || 'gh failed', 120)}`)
    return null
  }
  const pr = parseJson(view.stdout) as GhPr | undefined
  return pr === undefined ? null : { ...pr, repo }
}

function toTicketPr(pr: GhPr & { repo: string }, settings: SidePaneSettings): TicketPr {
  const isMerged = pr.state === 'MERGED'
  const { ci, failing } = isMerged ? { ci: 'none' as CiState, failing: [] } : ciOfChecks(pr.statusCheckRollup ?? [])
  return {
    key: `${pr.repo.split('/')[1] ?? pr.repo} #${pr.number}`,
    number: pr.number,
    url: safeUrl(pr.url) ?? `https://github.com/${pr.repo}/pull/${pr.number}`,
    title: plainTitle(pr.title),
    state: isMerged ? 'merged' : pr.isDraft ? 'draft' : 'open',
    ci,
    failing,
    review: pr.reviewDecision === 'APPROVED' ? 'approved' : pr.reviewDecision === 'CHANGES_REQUESTED' ? 'changes requested' : 'waiting for review',
    isConfig: settings.configRepo !== '' && pr.repo.toLowerCase() === settings.configRepo.toLowerCase(),
    lane: isMerged ? 3 : pr.isDraft ? 0 : 1,
  }
}

// ---- the session's own PRs: the branch's and each one it opened, with where review stands ----

const REVIEW_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewDecision
      reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
      latestReviews(first: 10) { nodes { state author { login } } }
      reviewThreads(first: 50) { nodes { isResolved comments(last: 1) { nodes { author { login } body url } } } }
    }
  }
}`

type GraphReviewPr = {
  reviewDecision: string | null
  reviewRequests: { nodes: { requestedReviewer: { login?: string; name?: string } | null }[] }
  latestReviews: { nodes: { state: string; author: { login: string } | null }[] }
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { author: { login: string } | null; body: string; url: string }[] } }[] }
}

// A comment's words without its markdown, HTML and code, on one line.
const plainComment = (body: string) =>
  oneLine(
    body
      .replace(/<!--[\s\S]*?-->|<[^>]+>/g, ' ')
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[*_`#>]+/g, '')
      .replace(/\s+/g, ' '),
    200,
  )

async function loadReview($: EngineInterface, pr: TicketPr, repo: string, login: string, errors: string[]): Promise<SessionReview | null> {
  const [owner = '', name = ''] = repo.split('/')
  const ran = await runCli($, ['gh', 'api', 'graphql', '-f', `query=${REVIEW_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`])
  const answer = ran?.exitCode === 0 ? parseJson(ran.stdout) : undefined
  const review = isRecord(answer) && isRecord(answer.data) && isRecord(answer.data.repository) ? (answer.data.repository.pullRequest as GraphReviewPr | null) : null
  if (review === null || review === undefined) {
    errors.push(`Review of ${pr.key}: ${oneLine(ran?.stderr || 'unreadable answer', 120)}`)
    return null
  }
  const waiting = review.reviewThreads.nodes
    .filter(thread => !thread.isResolved)
    .map(thread => thread.comments.nodes.at(-1))
    .filter((comment): comment is NonNullable<typeof comment> => comment !== undefined && (comment.author?.login ?? '') !== login)
    .map((comment): ReviewThread => ({ author: comment.author?.login ?? 'someone', text: plainComment(comment.body), url: safeUrl(comment.url) }))
  return {
    key: pr.key,
    url: pr.url,
    decision: review.reviewDecision === 'APPROVED' ? 'approved' : review.reviewDecision === 'CHANGES_REQUESTED' ? 'changes' : 'pending',
    changesBy: review.latestReviews.nodes.filter(one => one.state === 'CHANGES_REQUESTED').map(one => one.author?.login ?? 'someone'),
    requested: review.reviewRequests.nodes.map(one => one.requestedReviewer?.login ?? one.requestedReviewer?.name ?? '').filter(Boolean),
    waiting,
  }
}

export async function loadSessionStats($: EngineInterface, settings: SidePaneSettings, prUrls: readonly string[], now: number): Promise<SessionStats> {
  const errors: string[] = []
  const wanted = [...new Map([...prUrls.join('\n').matchAll(PR_URL)].map(match => [`${match[1]}#${match[2]}`, { repo: match[1] ?? '', number: Number(match[2]) }])).values()]
  const viewed = (await Promise.all(wanted.map(({ repo, number }) => viewPr($, repo, number, errors)))).filter((pr): pr is GhPr & { repo: string } => pr !== null)
  const prs = viewed.map(pr => toTicketPr(pr, settings))
  if (paneLocal.login === null && viewed.length > 0) {
    const user = await runCli($, ['gh', 'api', 'user', '--jq', '.login'])
    paneLocal.login = user?.exitCode === 0 ? user.stdout.trim() : ''
  }
  const reviews = (
    await Promise.all(viewed.filter(pr => pr.state === 'OPEN').map(pr => loadReview($, toTicketPr(pr, settings), pr.repo, paneLocal.login ?? '', errors)))
  ).filter((review): review is SessionReview => review !== null)
  return { prs, reviews, errors, loadedAt: now }
}

const laneOf = (prs: readonly TicketPr[]): number | null => {
  if (prs.length === 0) return null
  const open = prs.filter(pr => pr.state !== 'merged')
  return open.length === 0 ? 3 : Math.min(...open.map(pr => pr.lane))
}

// The one thing to do next: the code PRs first, then the config PRs, then the experiments.
export function nextStep(prs: readonly TicketPr[], experiments: readonly TicketExperiment[]): string {
  const STEPS: [(pr: TicketPr) => boolean, (pr: TicketPr, label: string) => string][] = [
    [pr => pr.ci === 'failing', (pr, label) => `Fix CI on ${label}: ${pr.failing.slice(0, 3).join(', ')}`],
    [pr => pr.review === 'changes requested', (_, label) => `Changes requested on ${label}`],
    [pr => pr.state === 'draft', (_, label) => `${label} is a draft`],
    [pr => pr.review === 'waiting for review', (_, label) => `${label} waits for review`],
    [pr => pr.ci === 'running', (_, label) => `CI running on ${label}`],
    [() => true, (_, label) => `${label} is ready to merge`],
  ]
  for (const isConfig of [false, true]) {
    const open = prs.filter(pr => pr.isConfig === isConfig && pr.state !== 'merged')
    for (const [matches, say] of STEPS) {
      const pr = open.find(matches)
      if (pr !== undefined) {
        const text = say(pr, isConfig ? `config #${pr.number}` : `#${pr.number}`)
        return text.charAt(0).toUpperCase() + text.slice(1)
      }
    }
  }
  const draft = experiments.find(exp => exp.lane === 0)
  if (draft !== undefined) return `Launch ${draft.name}`
  const live = experiments.find(exp => exp.lane === 1)
  if (live !== undefined) return `${live.name} is live`
  return prs.length > 0 ? 'All shipped' : 'No PR yet'
}

// ---- experiments and config drafts, through a dash-style CLI (`<cli> config search`, `<cli> curl`) ----

type ConfigItem = { subType: string; url: string | null; remoteUrl: string; lastUpdate: number }

async function searchConfigs($: EngineInterface, settings: SidePaneSettings, filter: string[], errors: string[]): Promise<ConfigItem[]> {
  const ran = await runCli($, [settings.configCli, 'config', 'search', '--type', settings.experimentType, ...filter, '--no-content'])
  if (ran === null || ran.exitCode !== 0) {
    errors.push(`Experiments: ${oneLine(ran?.stderr || ran?.stdout || `${settings.configCli} is not installed`, 140)}`)
    return []
  }
  const answer = parseJson(ran.stdout)
  const rows = isRecord(answer) && isRecord(answer.data) && Array.isArray(answer.data.data) ? answer.data.data : []
  return rows.filter(isRecord).map(row => ({
    subType: str(row.sub_type),
    url: safeUrl(str(row.url)),
    remoteUrl: str(row.remote_url),
    lastUpdate: Date.parse(str(row.last_update)) || 0,
  }))
}

// A config file's live content, read from the GitHub blob URL the search names.
async function readLive($: EngineInterface, remoteUrl: string): Promise<Record<string, unknown> | null> {
  const blob = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/blob\/([^/]+)\/(.+)$/.exec(remoteUrl)
  if (!blob) return null
  const ran = await runCli($, ['gh', 'api', '-H', 'Accept: application/vnd.github.raw', `repos/${blob[1]}/${blob[2]}/contents/${blob[4]}?ref=${blob[3]}`])
  const content = ran?.exitCode === 0 ? parseJson(ran.stdout) : undefined
  return isRecord(content) ? content : null
}

const EXPERIMENT_NAME = /\bexp_[a-z0-9]+(?:_[a-z0-9]+)*\b/g

// Each variant's force link carries the query the site reads (`variantQuery`), each value encoded,
// on the newest preview build of the same app when a bot posted one on the PR.
export function variantUrl(preview: string, template: string, name: string, variant: string, zone: string, builds: readonly string[], buildParam: string): string | null {
  let url: URL
  try {
    url = new URL(preview)
  } catch {
    return null
  }
  const segments = (path: string) => path.split('/').filter(Boolean)
  const target = segments(url.pathname)
  let best = -1
  for (const build of builds) {
    try {
      const candidate = new URL(build)
      const path = segments(candidate.pathname)
      const value = candidate.searchParams.get(buildParam)
      if (candidate.host !== url.host || value === null || path.length <= best || !path.every((part, i) => target[i] === part)) continue
      best = path.length
      url.searchParams.set(buildParam, value)
    } catch {
      // A malformed link in the comment is skipped.
    }
  }
  for (const pair of template.split('&')) {
    const [key = '', value = ''] = pair.split('=')
    if (key === '') continue
    url.searchParams.set(key, value.replaceAll('{name}', name).replaceAll('{variant}', variant).replaceAll('{zone}', zone))
  }
  return safeUrl(url.href.replace(/\+/g, '%20'))
}

const isControl = (arm: string) => /^(original|control)$/i.test(arm)

async function loadExperiments(
  $: EngineInterface,
  settings: SidePaneSettings,
  id: string,
  mentioned: string[],
  builds: string[],
  errors: string[],
): Promise<{ experiments: TicketExperiment[]; origin: string | null }> {
  if (settings.configCli === '' || settings.experimentType === '') return { experiments: [], origin: null }
  const names = [...new Set(mentioned)]
  const items = [
    ...(await searchConfigs($, settings, ['--search', id], errors)),
    ...(await Promise.all(names.map(name => searchConfigs($, settings, ['--name', name], [])))).flat().filter(item => names.includes(item.subType)),
  ]
  const unique = [...new Map(items.map(item => [item.subType, item])).values()]
  const buildParam = /^([^=&?]+)=/.exec(settings.previewLinkMatch)?.[1] ?? ''
  const experiments = (
    await Promise.all(
      unique.map(async (item): Promise<TicketExperiment | null> => {
        const config = await readLive($, item.remoteUrl)
        if (config === null || (str(config.ticket_id) !== id && !names.includes(item.subType))) return null
        const status = str(config.status).toLowerCase()
        const isEnded = /^(stopped|ended|concluded|done|archived)$/.test(status) || str(config.stopped_date) !== ''
        const lane = isEnded ? 3 : /^(live|running|active)$/.test(status) ? 1 : 0
        const variants = isRecord(config.variants) ? config.variants : {}
        const active = Object.values(variants).filter(one => isRecord(one) && one.active !== false).length
        const perc = typeof config.perc === 'number' ? config.perc : 100
        const zone = str(config.zone)
        const preview = str(config.preview_url)
        const rows = Object.entries(variants)
          .map(([key, value]): TicketVariant & { isControl: boolean } => {
            const arm = key.split('@').at(-1) ?? key
            const isOn = !isRecord(value) || value.active !== false
            const weight = isRecord(value) && typeof value.weight === 'number' ? value.weight : null
            return {
              label: isControl(arm) ? `${arm} (control)` : arm,
              url: preview === '' || settings.variantQuery === '' ? null : variantUrl(preview, settings.variantQuery, item.subType, key, zone, builds, buildParam),
              share: !isOn ? 'off' : lane !== 1 ? '0%' : `${Math.round(weight ?? perc / Math.max(1, active))}%`,
              isControl: isControl(arm),
            }
          })
          .sort((a, b) => Number(a.isControl) - Number(b.isControl) || a.label.localeCompare(b.label))
          .map(({ isControl: _isControl, ...variant }) => variant)
        return { name: item.subType, title: str(config.title), url: item.url, lane, variants: rows }
      }),
    )
  ).filter((exp): exp is TicketExperiment => exp !== null)
  experiments.sort((a, b) => a.name.localeCompare(b.name))
  const origin = unique.map(item => item.url).find((url): url is string => url !== null)
  return { experiments, origin: origin === undefined ? null : new URL(origin).origin }
}

// Drafts cannot be listed, so their codes are collected where they appear: tool results and the transcript.
// The earliest sighting stands for the save time; they are shared across sessions in the store.
type DraftSighting = { seenAt: number; url: string | null; ticket?: string | null; isDone?: boolean }

const DRAFTS_KEY = 'side-pane.v1.drafts'
const DRAFT_CODE = /CFG-[A-Z0-9]{10}/g
const DRAFT_LINK = /https:\/\/[^\s"'\\)<>]+(?:fromDraft=|\/config\/)(CFG-[A-Z0-9]{10})/g
const DRAFT_TTL_MS = 24 * 3600_000

async function readSightings($: EngineInterface): Promise<Record<string, DraftSighting>> {
  const stored = await $.store.get(DRAFTS_KEY)
  return isRecord(stored) ? (stored as Record<string, DraftSighting>) : {}
}

export async function noteDrafts($: EngineInterface, text: string, at: number) {
  const codes = text.match(DRAFT_CODE)
  if (codes === null) return
  const sightings = await readSightings($)
  const links = new Map([...text.matchAll(DRAFT_LINK)].map(match => [match[1] ?? '', safeUrl(match[0])]))
  let isChanged = false
  for (const code of new Set(codes)) {
    const before = sightings[code]
    if (before !== undefined && before.seenAt <= at && (before.url !== null || !links.get(code))) continue
    sightings[code] = { ...before, seenAt: Math.min(before?.seenAt ?? at, at), url: before?.url ?? links.get(code) ?? null }
    isChanged = true
  }
  if (isChanged) await $.store.set(DRAFTS_KEY, sightings)
}

// The transcript is read once per load of the module; tool results add later codes as they arrive.
async function scanTranscript($: EngineInterface, path: string) {
  if (path === '' || paneLocal.scannedTranscript === path || !(await $.fs.exists(path))) return
  paneLocal.scannedTranscript = path
  const text = String(await $.fs.read(path))
  for (const line of text.split('\n')) {
    if (!line.includes('CFG-')) continue
    const at = Date.parse(/"timestamp":"([^"]+)"/.exec(line)?.[1] ?? '')
    if (at > 0) await noteDrafts($, line.replace(/\\"/g, '"').replace(/\\\//g, '/'), at)
  }
}

const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : isRecord(value)
      ? `{${Object.keys(value)
          .sort()
          .map(key => `${JSON.stringify(key)}:${canonical(value[key])}`)
          .join(',')}}`
      : JSON.stringify(value)

// What a draft changes against the live config, in a few words: "adds a.b", "changes sections".
export function describeChange(live: unknown, draft: unknown): string {
  const diffs: { path: string[]; kind: string }[] = []
  const walk = (a: unknown, b: unknown, path: string[]) => {
    if (isRecord(a) && isRecord(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], [...path, key])
    } else if (canonical(a) !== canonical(b)) {
      diffs.push({ path, kind: a === undefined ? 'adds' : b === undefined ? 'removes' : 'changes' })
    }
  }
  walk(live, draft, [])
  const [first] = diffs
  if (first === undefined) return 'no change'
  if (diffs.length === 1) return `${first.kind} ${first.path.join('.')}`
  const tops = new Set(diffs.map(diff => diff.path[0] ?? ''))
  return tops.size === 1 ? `changes ${first.path[0] ?? ''}` : `changes ${tops.size} keys`
}

const toBase64 = (text: string) => {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const bytes = [...text].map(char => char.charCodeAt(0) & 255)
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const triple = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += alphabet[(triple >> 18) & 63]
    out += alphabet[(triple >> 12) & 63]
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63] : '='
    out += i + 2 < bytes.length ? alphabet[triple & 63] : '='
  }
  return out
}

async function loadDrafts(
  $: EngineInterface,
  settings: SidePaneSettings,
  ctx: SidePaneContext,
  experiments: readonly TicketExperiment[],
  origin: string | null,
  errors: string[],
): Promise<TicketDraft[]> {
  if (settings.configCli === '' || settings.draftPath === '') return []
  await scanTranscript($, ctx.transcriptPath)
  const sightings = await readSightings($)
  const shown = new Map<string, TicketDraft & { seenAt: number }>()
  for (const [code, sighting] of Object.entries(sightings)) {
    if (sighting.isDone || (sighting.ticket !== undefined && sighting.ticket !== null && sighting.ticket !== ctx.id)) continue
    const done = () => {
      sightings[code] = { ...sighting, isDone: true }
    }
    if (ctx.now - sighting.seenAt > DRAFT_TTL_MS) {
      done()
      continue
    }
    const ran = await runCli($, [settings.configCli, 'curl', settings.draftPath.replaceAll('{code}', code)])
    if (ran === null) {
      errors.push(`Drafts: ${settings.configCli} is not installed`)
      break
    }
    if (/DRAFT_NOT_FOUND|not found/i.test(ran.stdout)) {
      done()
      continue
    }
    const answer = parseJson(ran.stdout)
    const item = isRecord(answer) && isRecord(answer.item) ? answer.item : null
    if (ran.exitCode !== 0 || item === null) {
      errors.push(`Draft ${code}: ${oneLine(ran.stderr || ran.stdout || 'unreadable answer', 120)}`)
      continue
    }
    const value = typeof item.value === 'string' ? parseJson(item.value) : item.value
    const ticket = isRecord(value) ? ticketIdIn(str(value.ticket_id)) : null
    sightings[code] = { ...sighting, ticket }
    if (ticket !== ctx.id) continue
    const type = str(item.type)
    const subType = str(item.sub_type)
    const isNew = str(item.id) === '-1' || str(item.id) === ''
    let change = `new ${subType}`
    if (isNew) {
      if (type === settings.experimentType && experiments.length > 0) {
        done()
        continue
      }
    } else {
      const live = (await searchConfigs($, { ...settings, experimentType: type }, ['--name', subType], [])).find(row => row.subType === subType)
      if (live !== undefined && live.lastUpdate > sighting.seenAt) {
        done()
        continue
      }
      const content = live === undefined ? null : await readLive($, live.remoteUrl)
      if (content !== null && canonical(content) === canonical(value)) {
        done()
        continue
      }
      change = content === null ? `changes ${subType}` : describeChange(content, value)
    }
    const config = `${type}/${subType}`
    const before = shown.get(config)
    if (before !== undefined && before.seenAt >= sighting.seenAt) continue
    const url =
      sighting.url ??
      (origin === null ? null : safeUrl(`${origin}/config/${isNew ? code : `${toBase64(str(item.id))}?fromDraft=${code}`}`))
    shown.set(config, {
      code,
      config: subType,
      url,
      hoursLeft: Math.max(1, Math.ceil((sighting.seenAt + DRAFT_TTL_MS - ctx.now) / 3600_000)),
      change,
      seenAt: sighting.seenAt,
    })
  }
  await $.store.set(DRAFTS_KEY, sightings)
  return [...shown.values()].map(({ seenAt: _seenAt, ...draft }) => draft)
}

// ---- links and people ----

const MD_LINK = /\[([^\]]*)\]\(<?(https:\/\/[^)\s>]+)>?\)/g
const BARE_LINK = /https:\/\/[^\s)\]>"'`<\\]+/g

const linkKind = (url: string): TicketLinkKind | null =>
  /^https:\/\/(www\.)?figma\.com\//.test(url)
    ? 'figma'
    : /^https:\/\/([\w-]+\.)?notion\.(so|site)\//.test(url)
      ? 'notion'
      : /^https:\/\/claude\.ai\/(artifact|code\/artifact|public\/artifacts|share)/.test(url)
        ? 'claude'
        : null

function linkLabel(kind: TicketLinkKind, url: string): string {
  const parsed = new URL(url)
  const parts = parsed.pathname.split('/').filter(Boolean)
  if (kind === 'figma') {
    const name = decodeURIComponent(parts[2] ?? 'Figma').replace(/-+/g, ' ').trim()
    const node = parsed.searchParams.get('node-id')
    return node === null ? name : `${name} · ${node}`
  }
  if (kind === 'notion') {
    return decodeURIComponent(parts.at(-1) ?? 'Notion').replace(/-?[0-9a-f]{32}$/, '').replace(/-+/g, ' ').trim() || 'Notion page'
  }
  return 'Claude artifact'
}

export function linksIn(texts: readonly string[]): TicketLink[] {
  const links = new Map<string, TicketLink>()
  const add = (raw: string, label: string) => {
    const url = safeUrl(raw.replace(/[.,;:]+$/, ''))
    const kind = url === null ? null : linkKind(url)
    if (url === null || kind === null) return
    const key = url.replace(/[?&]t=[^&]*/, '')
    const before = links.get(key)
    const isNamed = label !== '' && !/^https?:\/\//.test(label)
    if (before === undefined || (isNamed && before.label === linkLabel(kind, url))) {
      links.set(key, { kind, url, label: isNamed ? label : linkLabel(kind, url) })
    }
  }
  for (const text of texts) {
    for (const match of text.matchAll(MD_LINK)) add(match[2] ?? '', (match[1] ?? '').trim())
    for (const match of text.matchAll(BARE_LINK)) add(match[0], '')
  }
  return [...links.values()]
}

type SlackPerson = { id: string | null; at: number }

const PEOPLE_KEY = 'side-pane.v1.people'
const MISS_KEEP_MS = 6 * 3600_000

async function slackIdOf($: EngineInterface, server: string, name: string, now: number, errors: string[]): Promise<string | null> {
  const stored = await $.store.get(PEOPLE_KEY)
  const people = isRecord(stored) ? (stored as Record<string, SlackPerson>) : {}
  const known = people[name]
  if (known !== undefined && (known.id !== null || now - known.at < MISS_KEEP_MS)) return known.id
  const got = await mcpJson($, server, 'slack_search_users', {
    keywords: name.split(/\s+/).filter(Boolean),
    limit: 20,
    natural_language_query: '',
  })
  if ('error' in got) {
    errors.push(`Slack: ${got.error}`)
    return null
  }
  const body = isRecord(got.value) && typeof got.value.results === 'string' ? got.value.results : str(got.value)
  const wanted = name.trim().toLowerCase()
  const match = [...body.matchAll(/Name: (.+)\nUser ID: (U[A-Z0-9]+)/g)].find(found => (found[1] ?? '').trim().toLowerCase() === wanted)
  people[name] = { id: match?.[2] ?? null, at: now }
  await $.store.set(PEOPLE_KEY, people)
  return people[name]?.id ?? null
}

async function loadPeople($: EngineInterface, settings: SidePaneSettings, ctx: SidePaneContext, issue: LinearIssue | null, errors: string[]): Promise<TicketPerson[]> {
  const roles = new Map<string, string[]>()
  for (const [name, role] of [
    [issue?.createdBy ?? '', 'wrote the ticket'],
    [issue?.assignee ?? '', 'assignee'],
    [settings.designer, 'design'],
  ] as const) {
    if (name.trim() !== '') roles.set(name.trim(), [...(roles.get(name.trim()) ?? []), role])
  }
  const server =
    ctx.slackServer ??
    (await $.tool.list().catch(() => [])).map(tool => /^mcp__(.+)__slack_search_users$/.exec(tool.name)?.[1]).find((one): one is string => one !== undefined) ??
    'claude.ai Slack'
  const people: TicketPerson[] = []
  const slackErrors: string[] = []
  for (const [name, role] of roles) {
    const id = await slackIdOf($, server, name, ctx.now, slackErrors)
    if (id !== null && id === ctx.slackMe) continue
    people.push({
      name,
      role: role.join(' · '),
      url: id === null || settings.slackDomain === '' ? null : safeUrl(`https://${settings.slackDomain}/app_redirect?channel=${id}`),
    })
  }
  if (slackErrors[0] !== undefined) errors.push(slackErrors[0])
  return people
}

// ---- the whole view ----

export async function loadTicket(
  $: EngineInterface,
  settings: SidePaneSettings,
  ctx: SidePaneContext,
  before: TicketView | null,
): Promise<{ view: TicketView; description: string }> {
  const errors: string[] = []
  const { issue, comments } = await loadIssue($, settings, ctx.id, errors)
  const { prs, raw } = await loadPrs($, settings, ctx.id, issue?.attachments ?? [], errors)
  const texts = [issue?.description ?? '', ...comments, ...raw.map(pr => pr.body ?? '')]
  const published =
    settings.previewMarker === ''
      ? []
      : raw.filter(pr => pr.repo.toLowerCase() === settings.codeRepo.toLowerCase()).flatMap(pr => pr.comments.filter(comment => comment.body.includes(settings.previewMarker)).slice(-1))
  const builds = published.flatMap(comment => comment.body.match(/https:\/\/[^\s)\]"'<>*]+/g) ?? []).filter(url => url.includes(settings.previewLinkMatch))
  const mentioned = texts.flatMap(text => text.match(EXPERIMENT_NAME) ?? [])
  const { experiments, origin } = await loadExperiments($, settings, ctx.id, mentioned, builds, errors)
  const drafts = await loadDrafts($, settings, ctx, experiments, origin, errors)
  const people = await loadPeople($, settings, ctx, issue, errors)
  const codePrs = prs.filter(pr => !pr.isConfig)
  const view: TicketView = {
    id: ctx.id,
    title: issue?.title ?? before?.title ?? '',
    url: issue?.url ?? before?.url ?? null,
    next: nextStep(prs, experiments),
    tldr: before?.id === ctx.id ? before.tldr : null,
    drafts,
    prs,
    codeLane: laneOf(codePrs),
    experiments,
    links: linksIn(texts),
    related: issue?.related ?? [],
    people,
    errors,
    isCiRunning: prs.some(pr => pr.ci === 'running'),
    loadedAt: ctx.now,
  }
  return { view, description: issue?.description ?? '' }
}

// The TL;DR: one model sentence on what the ticket delivers and where it stands, written again only when that changes.
const TICKET_TLDR_SYSTEM =
  'You write the one-sentence TL;DR at the top of a developer side panel about a ticket. Reply with exactly one sentence of at most 24 words, plain text, no markdown, no quotes, no preamble. Say what the ticket delivers and where it stands now.'

export const tldrKey = (view: TicketView) =>
  JSON.stringify([view.title, view.next, view.prs.map(pr => [pr.key, pr.state, pr.ci, pr.review]), view.experiments.map(exp => [exp.name, exp.lane]), view.drafts.map(draft => draft.code)])

export async function writeTldr($: EngineInterface, view: TicketView, description: string): Promise<string | null> {
  const stored = await $.store.get(`side-pane.v1.tldr.${view.id}`)
  const key = tldrKey(view)
  if (isRecord(stored) && stored.key === key && typeof stored.text === 'string') return stored.text
  const prompt = [
    `Ticket ${view.id}: ${view.title}`,
    description === '' ? '' : `Description: ${description.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, '').slice(0, 900)}`,
    `Next step: ${view.next}`,
    ...view.prs.map(pr => `PR ${pr.key} (${pr.state}, CI ${pr.ci}, ${pr.review}): ${pr.title}`),
    ...view.experiments.map(exp => `Experiment ${exp.name} (${['draft', 'live', 'live', 'ended'][exp.lane] ?? 'draft'}): ${exp.title}`),
    ...view.drafts.map(draft => `Unsaved config draft ${draft.code} on ${draft.config}: ${draft.change}`),
  ]
    .filter(Boolean)
    .join('\n')
  const reply = await $.model.complete({ model: 'haiku', system: TICKET_TLDR_SYSTEM, prompt, maxTokens: 120, timeoutMs: 30_000 }).catch(() => null)
  if (reply === null || !reply.isAnswered) return null
  const text = oneLine(reply.text.replace(/^["'\s]+|["'\s]+$/g, ''), 240)
  if (text === '') return null
  await $.store.set(`side-pane.v1.tldr.${view.id}`, { key, text })
  return text
}

// The session's TL;DR, the pane's first line: what the session is doing and where it stands, from a short brief of it.
const SESSION_TLDR_SYSTEM =
  "You write the one-sentence TL;DR at the top of a developer's side panel about their Claude Code session. Reply with exactly one sentence of at most 24 words, plain text, no markdown, no quotes, no preamble. Say what the session is working on and where it stands now."

export async function writeSessionTldr($: EngineInterface, brief: string): Promise<string | null> {
  const reply = await $.model.complete({ model: 'haiku', system: SESSION_TLDR_SYSTEM, prompt: brief, maxTokens: 120, timeoutMs: 30_000 }).catch(() => null)
  if (reply === null || !reply.isAnswered) return null
  const text = oneLine(reply.text.replace(/^["'\s]+|["'\s]+$/g, ''), 240)
  return text === '' ? null : text
}

// What /ticket and open_session_pane answer: the pane's content as text.
export function ticketReport(view: TicketView | null, id: string | null, tldr: string | null): string {
  const head = tldr === null ? [] : [`TL;DR: ${tldr}`]
  if (id === null) return [...head, 'Bit: this session is on no ticket branch, so the ticket sections are empty.'].join('\n')
  if (view === null) return [...head, `Bit: loading ${id}…`].join('\n')
  const lines = [...head, `${view.id} · ${view.title}`, ...(view.tldr === null ? [] : [`Ticket TL;DR: ${view.tldr}`]), `Next: ${view.next}`]
  view.drafts.forEach(draft => lines.push(`Unsaved draft: ${draft.config} ${draft.code} ${draft.change} (${draft.hoursLeft} h left)${draft.url ? ` ${draft.url}` : ''}`))
  view.prs.forEach(pr => lines.push(`PR ${pr.key}: ${pr.state}${pr.state === 'merged' ? '' : `, CI ${pr.ci}, ${pr.review}`} ${pr.url}`))
  view.experiments.forEach(exp => {
    lines.push(`Experiment ${exp.name} (${['draft', 'live', 'live', 'ended'][exp.lane] ?? 'draft'}): ${exp.title}${exp.url ? ` ${exp.url}` : ''}`)
    exp.variants.forEach(variant => lines.push(`  ${variant.label} ${variant.share}${variant.url ? ` ${variant.url}` : ''}`))
  })
  view.links.forEach(link => lines.push(`${link.kind}: ${link.label} ${link.url}`))
  view.related.forEach(one => lines.push(`Related: ${one.id} ${one.title}`.trim()))
  view.people.forEach(person => lines.push(`${person.name} (${person.role})${person.url ? ` ${person.url}` : ''}`))
  view.errors.forEach(error => lines.push(`Problem: ${error}`))
  return lines.join('\n')
}

// ---- drawing ----

type IconName =
  | 'linear'
  | 'github'
  | 'figma'
  | 'notion'
  | 'claude'
  | 'slack'
  | 'warning'
  | 'flask'
  | 'pr'
  | 'palette'
  | 'doc'
  | 'pie'
  | 'sessions'
  | 'arrow'
  | 'eye'
  | 'dot'
  | 'spark'
  | 'activity'
  | 'slackColor'
  | 'gmail'
  | 'blank'

// Brand marks from Simple Icons (CC0); the Figma mark in its own colors.
const BRAND: Partial<Record<IconName, string>> = {
  linear:
    'M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z',
  github:
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  notion:
    'M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.139c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z',
  gmail:
    'M24 5.457v13.909c0 .904-.732 1.636-1.636 1.636h-3.819V11.73L12 16.64l-6.545-4.91v9.273H1.636A1.636 1.636 0 0 1 0 19.366V5.457c0-2.023 2.309-3.178 3.927-1.964L5.455 4.64 12 9.548l6.545-4.91 1.528-1.145C21.69 2.28 24 3.434 24 5.457z',
  slack:
    'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z',
}

const STROKE: Partial<Record<IconName, string>> = {
  warning: '<path d="M8 1.8 14.8 13.8H1.2Z"/><path d="M8 6.2v3.6"/><circle cx="8" cy="11.8" r=".5"/>',
  flask: '<path d="M6 1.6h4M6.6 1.6v4.6L2.6 12.9a1.2 1.2 0 0 0 1 1.7h8.8a1.2 1.2 0 0 0 1-1.7L9.4 6.2V1.6"/><path d="M4.4 10h7.2"/>',
  pr: '<circle cx="4" cy="3.6" r="1.7"/><circle cx="4" cy="12.4" r="1.7"/><circle cx="12" cy="12.4" r="1.7"/><path d="M4 5.3v5.4M12 10.7V6.4a1.9 1.9 0 0 0-1.9-1.9H7.4M9 2.9 7.4 4.5 9 6.1"/>',
  palette:
    '<path d="M8 1.6a6.4 6.4 0 1 0 0 12.8c1 0 1.4-.7 1.1-1.5-.4-.9.2-1.8 1.2-1.8h1.6a2.6 2.6 0 0 0 2.6-2.6C14.5 4.6 11.6 1.6 8 1.6Z"/><circle cx="4.9" cy="7.2" r=".6"/><circle cx="7.4" cy="4.6" r=".6"/><circle cx="10.6" cy="5.4" r=".6"/>',
  doc: '<path d="M4 1.6h5.4L12.6 4.8v9.6H4Z"/><path d="M9.4 1.6v3.2h3.2M6.2 8.2h4.2M6.2 10.8h4.2"/>',
  pie: '<circle cx="8" cy="8" r="6.2"/><path d="M8 1.8V8h6.2"/>',
  sessions: '<rect x="2" y="4.4" width="9.6" height="9.2" rx="1.6"/><path d="M5 2h7.4A1.6 1.6 0 0 1 14 3.6V11"/>',
  arrow: '<path d="M6 4l4 4-4 4"/>',
  activity: '<path d="M1.4 8.6h3.1l1.9-4.4 3 7.8 2-4.6h3.2"/>',
  eye: '<path d="M1.4 8S3.8 3.4 8 3.4 14.6 8 14.6 8 12.2 12.6 8 12.6 1.4 8 1.4 8Z"/><circle cx="8" cy="8" r="2.1"/>',
}

// Slack's mark in its own colors: each pair of the path's pieces (a dot and a bar) is one color.
const SLACK_COLORS = ['#E01E5A', '#36C5F0', '#2EB67D', '#ECB22E']

const FIGMA_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 38 57" width="16" height="16"><path d="M19 28.5a9.5 9.5 0 1 1 19 0 9.5 9.5 0 0 1-19 0z" fill="#1ABCFE"/><path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0z" fill="#0ACF83"/><path d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19z" fill="#FF7262"/><path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5z" fill="#F24E1E"/><path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5z" fill="#A259FF"/></svg>'

// Claude's mark: rays around a center, drawn here rather than copied.
const CLAUDE_MARK = (color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16"><g stroke="${color}" stroke-width="1.6" stroke-linecap="round">${Array.from({ length: 8 }, (_, i) => {
    const angle = (i * Math.PI) / 4
    return `<line x1="${(8 + Math.cos(angle) * 2).toFixed(2)}" y1="${(8 + Math.sin(angle) * 2).toFixed(2)}" x2="${(8 + Math.cos(angle) * 6.6).toFixed(2)}" y2="${(8 + Math.sin(angle) * 6.6).toFixed(2)}"/>`
  }).join('')}</g></svg>`

export function iconSvg(name: IconName, color: string): string {
  const open = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">'
  if (name === 'figma') return FIGMA_MARK
  if (name === 'claude') return CLAUDE_MARK(color)
  if (name === 'dot') return `${open}<circle cx="8" cy="8" r="3.6" fill="${color}"/></svg>`
  if (name === 'slackColor') {
    const pieces = (BRAND.slack ?? '').split(/(?=M)/)
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16">${pieces.map((piece, i) => `<path d="${piece}" fill="${SLACK_COLORS[Math.floor(i / 2)] ?? color}"/>`).join('')}</svg>`
  }
  if (name === 'spark') return `${open}<path d="M8 1.6l1.5 4.9 4.9 1.5-4.9 1.5L8 14.4l-1.5-4.9L1.6 8l4.9-1.5Z" fill="${color}"/></svg>`
  if (name === 'blank') return `${open}</svg>`
  const brand = BRAND[name]
  if (brand !== undefined) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16"><path d="${brand}" fill="${color}"/></svg>`
  }
  return `${open}<g fill="none" stroke="${color}" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${STROKE[name] ?? ''}</g></svg>`
}

const GLYPH: Record<IconName, string> = {
  linear: '◆',
  github: '⑂',
  figma: '◈',
  notion: '▤',
  claude: '✳',
  slack: '#',
  warning: '⚠',
  flask: '⚗',
  pr: '⑂',
  palette: '◐',
  doc: '▤',
  pie: '◔',
  sessions: '▣',
  arrow: '›',
  eye: '◉',
  dot: '●',
  spark: '✦',
  activity: '∿',
  slackColor: '#',
  gmail: '✉',
  blank: ' ',
}

const escapeXml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif"

// The desktop's Text takes no size or weight, so a section title is drawn as an SVG.
export const titleSvg = (title: string, color: string) => {
  const width = Math.ceil(title.length * 8.6) + 4
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 20" width="${width}" height="20"><text x="0" y="15" font-family="${FONT}" font-size="15" font-weight="650" fill="${color}">${escapeXml(title)}</text></svg>`
}

const ACCENT = '#D97757'
// A section whose source has nothing draws its headline at this opacity.
const EMPTY_OPACITY = 0.45

// A hairline across the pane, sized from its width in columns (a column is at least 7px on a graphical surface).
const separatorSvg = (width: number) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 9" width="${width}" height="9"><line x1="0" y1="4.5" x2="${width}" y2="4.5" stroke="#8b949e" stroke-opacity=".35" stroke-width="1"/></svg>`

// A headline that blinks: its whole drawing pulses, the browser animating it with no redraw.
const blinking = (svg: string) =>
  svg.replace(/^(<svg[^>]*>)/, '$1<g><animate attributeName="opacity" values="1;0.25;1" dur="1.4s" repeatCount="indefinite"/>').replace(/<\/svg>$/, '</g></svg>')

// The pane's pet: a pixel snake on the footer row. It never sits still: it slithers across, fast while a turn
// runs and at an amble while the session is idle, flicking its tongue.
const SNAKE_CELL = 4
const SNAKE_LENGTH = 9
const SNAKE_COLORS = ['#56d364', '#3fb950', '#2ea043']

export function snakeSvg(width: number, isFast: boolean): string {
  const height = SNAKE_CELL * 6
  const segments = Array.from({ length: SNAKE_LENGTH }, (_, i) => {
    const x = (SNAKE_LENGTH - 1 - i) * SNAKE_CELL
    const fill = i === 0 ? SNAKE_COLORS[0] : SNAKE_COLORS[1 + (i % 2)]
    // Each segment rides the same wave a little behind the one before it.
    const wave = `<animate attributeName="y" values="${SNAKE_CELL * 2};${SNAKE_CELL * 3};${SNAKE_CELL * 2};${SNAKE_CELL};${SNAKE_CELL * 2}" dur="${isFast ? 0.9 : 1.6}s" begin="${(-i * (isFast ? 0.1 : 0.18)).toFixed(2)}s" repeatCount="indefinite" calcMode="discrete"/>`
    return `<rect x="${x}" y="${SNAKE_CELL * 2}" width="${SNAKE_CELL}" height="${SNAKE_CELL}" fill="${fill}">${wave}</rect>`
  })
  const head = (SNAKE_LENGTH - 1) * SNAKE_CELL
  // The head rides the wave with the first segment; the tongue flicks as it goes.
  const headWave = (offset: number) =>
    `<animate attributeName="y" values="${SNAKE_CELL * 2 + offset};${SNAKE_CELL * 3 + offset};${SNAKE_CELL * 2 + offset};${SNAKE_CELL + offset};${SNAKE_CELL * 2 + offset}" dur="${isFast ? 0.9 : 1.6}s" repeatCount="indefinite" calcMode="discrete"/>`
  const eye = `<rect x="${head + 2}" y="${SNAKE_CELL * 2 + 1}" width="1" height="1" fill="#0d1117">${headWave(1)}</rect>`
  const tongue = `<rect x="${head + SNAKE_CELL}" y="${SNAKE_CELL * 2 + 1}" width="${SNAKE_CELL}" height="2" fill="#f85149">${headWave(1)}<animate attributeName="opacity" values="0;0;1;0" dur="${isFast ? 1.2 : 2.6}s" repeatCount="indefinite" calcMode="discrete"/></rect>`
  const body = `${segments.join('')}${eye}${tongue}`
  // Out at the right, back in at the left: fast while a turn runs, an idle amble otherwise.
  const travel = `<animateTransform attributeName="transform" type="translate" values="${-head - SNAKE_CELL * 2} 0;${width} 0" dur="${(width / (isFast ? 40 : 14)).toFixed(1)}s" repeatCount="indefinite"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" shape-rendering="crispEdges"><g>${body}${travel}</g></svg>`
}

const faded = (svg: string) => svg.replace('<svg ', `<svg opacity="${EMPTY_OPACITY}" `)
const MUTED = '#8b949e'

// A lane as dots on a track: done steps filled with a check, the current one ringed.
export function laneSvg(steps: readonly string[], lane: number): string {
  const width = 132
  // The end dots sit in far enough that a centered label (Merged) is not cut.
  const xs = steps.map((_, i) => 20 + (i * (width - 40)) / Math.max(1, steps.length - 1))
  const parts: string[] = []
  for (let i = 0; i < steps.length - 1; i += 1) {
    parts.push(`<line x1="${xs[i]}" y1="7" x2="${xs[i + 1]}" y2="7" stroke="${i < lane ? ACCENT : '#555'}" stroke-width="1.2"/>`)
  }
  steps.forEach((step, i) => {
    const x = xs[i] ?? 0
    if (i < lane) {
      parts.push(`<circle cx="${x}" cy="7" r="5" fill="${ACCENT}"/><path d="M${x - 2.4} 7.1l1.6 1.6 3.2-3.3" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>`)
    } else if (i === lane) {
      parts.push(`<circle cx="${x}" cy="7" r="6" fill="none" stroke="${ACCENT}" stroke-opacity=".45" stroke-width="1.5"/><circle cx="${x}" cy="7" r="3.4" fill="${ACCENT}"/>`)
    } else {
      parts.push(`<circle cx="${x}" cy="7" r="3.4" fill="none" stroke="${MUTED}" stroke-width="1.2"/>`)
    }
    const color = i === lane ? ACCENT : i < lane ? '#c9c9c9' : MUTED
    parts.push(`<text x="${x}" y="23" text-anchor="middle" font-family="${FONT}" font-size="9.5" font-weight="${i === lane ? 650 : 400}" fill="${color}">${escapeXml(step)}</text>`)
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 26" width="${width}" height="26">${parts.join('')}</svg>`
}

// A message too long for its line scrolls past like a ticker: a pause, then the whole text, then again.
// Text widths are estimated per character, so `textLength` pins each copy to the width the scroll assumes.
const TICKER_PX_PER_CHAR = 7
const TICKER_GAP_PX = 48
const TICKER_PX_PER_S = 32
const TICKER_HOLD_S = 2

// A right-to-left message (its first strong letter Hebrew or Arabic) starts at the right edge and scrolls the other way.
const FIRST_STRONG = /[A-Za-z\u0590-\u08FF]/

export function tickerSvg(text: string, width: number, color: string): string {
  const length = Math.ceil(text.length * TICKER_PX_PER_CHAR)
  const step = length + TICKER_GAP_PX
  const total = step / TICKER_PX_PER_S + TICKER_HOLD_S
  const isRtl = /[\u0590-\u08FF]/.test(FIRST_STRONG.exec(text)?.[0] ?? '')
  const copy = (x: number) =>
    `<text x="${x}" y="15" direction="${isRtl ? 'rtl' : 'ltr'}" textLength="${length}" lengthAdjust="spacing" font-family="${FONT}" font-size="14" fill="${color}">${escapeXml(text)}</text>`
  const copies = isRtl ? `${copy(width)}${copy(width - step)}` : `${copy(0)}${copy(step)}`
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} 20" width="${width}" height="20"><g>${copies}<animateTransform attributeName="transform" type="translate" values="0 0;0 0;${isRtl ? step : -step} 0" keyTimes="0;${(TICKER_HOLD_S / total).toFixed(3)};1" dur="${total.toFixed(2)}s" repeatCount="indefinite"/></g></svg>`
}


// The prompt cache, as the model line says it: nothing while it is warm, a warning near the end, cold once it lapsed.
export function cacheBadge(remaining: number | null, warnLead: number): { text: string; color: string } | null {
  if (remaining === null || remaining > warnLead) return null
  if (remaining <= 0) return { text: '❄ cache cold', color: '#f85149' }
  const seconds = Math.ceil(remaining / 1000)
  const left = remaining <= 2 * 60_000 ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}` : `${Math.ceil(remaining / 60_000)}m`
  return { text: `⚠ cache ${left}`, color: '#F0883E' }
}

// A model id as people say it: claude-opus-5-5 is Opus 5.5.
export const modelName = (id: string) => {
  const match = /claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(id)
  return match?.[1] ? `${match[1].charAt(0).toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}` : id.replace(/\[.*\]$/, '')
}

export function contextSvg(view: ContextView, barWidth: number): string {
  let x = 0
  const parts = view.parts.map(part => {
    const width = Math.max(0, Math.min(barWidth - x, (part.tokens / Math.max(1, view.window)) * barWidth))
    const rect = `<rect x="${x.toFixed(1)}" y="0" width="${width.toFixed(1)}" height="6" fill="${part.color}"/>`
    x += width
    return rect
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${barWidth} 6" width="${barWidth}" height="6"><clipPath id="r"><rect width="${barWidth}" height="6" rx="3"/></clipPath><g clip-path="url(#r)"><rect width="${barWidth}" height="6" fill="#3d3d3d"/>${parts.join('')}</g></svg>`
}

// Category colors for the context bar, in the order /context lists the used rows.
export const CONTEXT_COLORS = ['#4C8DF6', ACCENT, '#3fb950', '#a371f7', '#D4A72C', '#E01E5A', '#2dd4bf', MUTED]

export const fmtK = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n))

export type PaneElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button' | 'Link'> & { Svg?: Elements['desktop']['Svg'] }

export type SessionLine = {
  key: string
  name: string
  state: string
  color: string
  prKey: string | null
  prUrl: string | null
  gist: string
  // A subagent has no session to open.
  onOpen: (() => void) | null
}

export type SlackLine = {
  key: string
  name: string
  url: string | null
  latest: string
  // When the latest message came, HH:MM.
  at: string
  onDone: () => void
}

export type SidePaneParts = {
  columns: number
  tldr: string | null
  // What the session is doing in one line (the task in hand, else its state), in its state's color.
  status: { text: string; color: string }
  // The model, its effort and fast mode, as the app last reported them; null until it has.
  mode: { model: string; effort: string | null; fast: string | null } | null
  // The prompt cache's state; null before the first request.
  cache: { text: string; color: string } | null
  ticketId: string | null
  ticket: TicketView | null
  sessions: SessionLine[]
  needYou: number
  // Where review stands on each of the session's open PRs.
  reviews: SessionReview[]
  sessionsOffset: number
  sessionsShown: number
  isCollapsed: (section: string) => boolean
  onToggleSection: (section: string) => void
  onFoldAll: (sections: readonly string[], isCollapsed: boolean) => void
  // Sections whose status just changed, or Code Review while the session watches a PR.
  blinking: readonly string[]
  isWorking: boolean
  onScrollSessions: (by: number) => void
  slack: SlackLine[]
  slackError: string | null
  onClearSlack: () => void
  context: ContextView | null
  // The prompt cache's minutes left while Keep warm is on; null while it is off.
  warmFor: string | null
  onKeepWarm: () => void
  isKissDimmed: boolean
  onKiss: () => void
  onRefresh: () => void
  isLoading: boolean
  clock: (at: number) => string
  // The pane's room in rows, how far its body is scrolled, and how to move it.
  rows: number
  offset: number
  onScroll: (by: number) => void
  onBodyRows: (maxOffset: number) => void
}

// Below this many rows of room the footer is not pinned; the ▲ ▼ buttons move the body by this much.
const STICKY_MIN_ROWS = 8
const SCROLL_STEP_ROWS = 6

const COLOR = {
  tldr: ACCENT,
  ticket: '#5E6AD2',
  drafts: '#F0883E',
  prs: '#3fb950',
  experiment: '#D4A72C',
  design: '#A259FF',
  docs: MUTED,
  people: '#E01E5A',
  slack: '#d946ef',
  gmail: '#EA4335',
  sessions: '#2dd4bf',
  review: '#58a6ff',
  context: '#4C8DF6',
}

const PR_COLOR: Record<TicketPr['state'], string> = { open: '#3fb950', draft: MUTED, merged: '#a371f7' }
const REVIEW_COLOR: Record<SessionReview['decision'], string> = { approved: '#3fb950', changes: '#f85149', pending: MUTED }
// A PR shows its first few threads waiting on you; the rest are counted.
const REVIEW_THREADS_SHOWN = 4
const CI_COLOR: Record<CiState, string> = { passing: '#3fb950', failing: '#f85149', running: '#D4A72C', none: MUTED }

// Full-size triangles: the small ones read as specks beside a title. U+FE0E keeps ▶ a glyph, never an emoji.
export const CARET_CLOSED = '▶\uFE0E'
export const CARET_OPEN = '▼'

type PaneFold = Pick<SidePaneParts, 'isCollapsed' | 'onToggleSection' | 'blinking'>

// The drawing both panes share: the line grid, faded and blinking headlines, carets, lanes and links.
function paneKit(ui: PaneElements, parts: PaneFold) {
  const { Box, Text, Button, Link, Svg } = ui

  const linkOrText = (url: string | null, label: string) =>
    url !== null ? <Link href={url} label={label} /> : <Text wrap="truncate-end">{label}</Text>

  const plainButton = (key: string, label: string, onPress: () => void, isDimmed = true) => (
    <Button key={key} plain dimColor={isDimmed} label={label} onPress={onPress} />
  )

  const slot = (key: string, icon: IconName, color: string, alt: string, isFaded = false, isBlinking = false) => (
    <Box key={`${key}-icon`} flexShrink={0}>
      {Svg ? (
        <Svg source={(isBlinking ? blinking : isFaded ? faded : String)(iconSvg(icon, color))} alt={alt} width={16} height={16} isInteractive={isBlinking} />
      ) : (
        <Text color={color} dimColor={isFaded}>
          {GLYPH[icon]}
        </Text>
      )}
    </Box>
  )

  // Every line is the same grid: a 16px icon slot, the content, and an optional value on the right.
  // The content gives way (minWidth 0) so long text truncates instead of pushing the right value out.
  const line = (key: string, icon: IconName, color: string, alt: string, content: RenderNode, right?: RenderNode | RenderNode[], isFaded = false, isBlinking = false) => (
    <Box key={key} flexDirection="row" gap={1} alignItems="flex-start">
      {slot(key, icon, color, alt, isFaded, isBlinking)}
      <Box key={`${key}-body`} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {content}
      </Box>
      {right !== undefined && (
        <Box key={`${key}-right`} flexShrink={0} flexDirection="row" gap={1} alignItems="center">
          {right}
        </Box>
      )}
    </Box>
  )

  const dim = (text: string) => (
    <Text dimColor wrap="truncate-end">
      {text}
    </Text>
  )

  const lane = (key: string, steps: readonly string[], at: number) =>
    Svg ? (
      <Svg source={laneSvg(steps, at)} alt={`${steps[Math.min(at, steps.length - 1)] ?? ''}${at >= steps.length ? ' done' : ''}`} width={132} height={26} />
    ) : (
      <Text key={key}>{steps.map((step, i) => (i < at ? `✓${step} ` : i === at ? `●${step} ` : `○${step} `)).join('')}</Text>
    )

  // Every section with rows collapses from a caret right after its title; `count` rides on the caret.
  // `foldable` gathers them for the hide all button.
  const foldable: string[] = []
  // About how many rows the sections drawn so far take: a headline, its margin and each open row.
  let rowsDrawn = 0
  const section = (key: string, title: string, icon: IconName, color: string, rows: RenderNode[], right?: RenderNode | RenderNode[], count?: number, isFoldable = true) => {
    const isEmpty = rows.length === 0
    const isCollapsed = isFoldable && !isEmpty && parts.isCollapsed(key)
    const isBlinking = parts.blinking.includes(key)
    if (isFoldable && !isEmpty) foldable.push(key)
    rowsDrawn += 2 + (isCollapsed ? 0 : rows.length)
    const caret = isEmpty || !isFoldable ? undefined : plainButton(`${key}-toggle`, `${isCollapsed ? CARET_CLOSED : CARET_OPEN}${count === undefined ? '' : ` ${count}`}`, () => parts.onToggleSection(key))
    return (
    <Box key={key} flexDirection="column" marginTop={1}>
      {line(
        `${key}-title`,
        icon,
        color,
        isEmpty ? `${title}: nothing yet` : title,
        <Box key={`${key}-title-row`} flexDirection="row" gap={1} alignItems="center">
          {Svg ? (
            <Svg
              source={(isBlinking ? blinking : isEmpty ? faded : String)(titleSvg(title, color))}
              alt={title}
              width={Math.ceil(title.length * 8.6) + 4}
              height={20}
              isInteractive={isBlinking}
            />
          ) : (
            <Text color={color} bold dimColor={isEmpty && !isBlinking} inverse={isBlinking}>
              {title}
            </Text>
          )}
          {caret}
        </Box>,
        right,
        isEmpty && !isBlinking,
        isBlinking,
      )}
      {!isCollapsed && (
        // Rows sit one step in, their icons under the headline's text.
        <Box key={`${key}-rows`} flexDirection="column" paddingLeft={Svg ? 3 : 2}>
          {rows}
        </Box>
      )}
    </Box>
    )
  }

  // A session: a dot and its age in its status color, the name that opens it, then its PR and task, dim.
  const sessionRows = (session: SessionLine) => [
    line(
      `tp-session-${session.key}`,
      session.onOpen === null ? 'spark' : 'dot',
      session.color,
      session.state,
      session.onOpen === null ? <Text wrap="truncate-end">{session.name}</Text> : <Button key={`tp-session-open-${session.key}`} plain label={session.name} onPress={session.onOpen} />,
      <Text color={session.color}>{session.state}</Text>,
    ),
    ...(session.gist === '' && session.prUrl === null
      ? []
      : [
          line(
            `tp-session-${session.key}-gist`,
            'blank',
            MUTED,
            'session detail',
            <Box key={`tp-session-${session.key}-gist-row`} flexDirection="row" gap={1} minWidth={0}>
              {session.prUrl !== null && <Link href={session.prUrl} label={session.prKey ?? 'PR'} />}
              {session.gist !== '' && dim(session.gist)}
            </Box>,
          ),
        ]),
  ]

  // A pull request: its link and state, its title, and while open its CI and review.
  const prRows = (pr: TicketPr, right?: RenderNode) => [
    line(`tp-pr-${pr.key}`, 'pr', PR_COLOR[pr.state], `${pr.state} pull request`, <Link href={pr.url} label={pr.key} />, right ?? <Text dimColor>{pr.state}</Text>),
    line(`tp-pr-${pr.key}-title`, 'blank', MUTED, 'pull request title', dim(pr.title)),
    ...(pr.state === 'merged'
      ? []
      : [
          line(
            `tp-pr-${pr.key}-ci`,
            'blank',
            MUTED,
            'checks',
            <Text wrap="truncate-end">
              <Text color={CI_COLOR[pr.ci]}>{pr.ci === 'none' ? 'no CI' : `CI ${pr.ci}`}</Text>
              <Text dimColor>{` · ${pr.review}`}</Text>
            </Text>,
          ),
        ]),
  ]

  return { slot, line, dim, lane, section, linkOrText, plainButton, foldable, sessionRows, prRows, rowsDrawn: () => rowsDrawn }
}

export function drawSidePane(ui: PaneElements, parts: SidePaneParts): RenderElement {
  const { Box, Text, Button, Link, Svg } = ui
  const { ticket } = parts
  const { slot, line, dim, lane, section, linkOrText, plainButton, foldable, sessionRows, prRows, rowsDrawn } = paneKit(ui, parts)

  // The room a message line has beside its indent, icon slot and time, in px.
  const messageWidth = parts.columns * 7 - 104
  const message = (text: string) =>
    Svg && text.length * TICKER_PX_PER_CHAR > messageWidth ? <Svg source={tickerSvg(text, messageWidth, MUTED)} alt={text} width={messageWidth} height={20} isInteractive /> : dim(text)

  // Every section keeps its headline when its source has nothing, so the pane's shape never shifts.
  const prs = ticket?.prs ?? []
  const experiments = ticket?.experiments ?? []
  const design = ticket?.links.filter(link => link.kind === 'figma') ?? []
  const docs = ticket?.links.filter(link => link.kind !== 'figma') ?? []
  const slackErrors = ticket?.errors.filter(error => error.startsWith('Slack')) ?? []
  const view = parts.context

  const sections: RenderNode[] = [
    section(
      'tp-ticket',
      'Ticket',
      'linear',
      COLOR.ticket,
      ticket === null
        ? []
        : [
            line('tp-ticket-link', 'linear', COLOR.ticket, 'Linear', linkOrText(ticket.url, `${ticket.id} · ${ticket.title}`)),
            ...(ticket.tldr === null ? [] : [line('tp-ticket-tldr', 'blank', MUTED, 'ticket TL;DR', <Text dimColor wrap="wrap">{ticket.tldr}</Text>)]),
            line('tp-ticket-next', 'blank', COLOR.ticket, 'next step', <Text bold>{ticket.next}</Text>),
          ],
    ),
    section(
      'tp-drafts',
      'Unsaved config drafts',
      'warning',
      COLOR.drafts,
      (ticket?.drafts ?? []).flatMap(draft => [
        line(
          `tp-draft-${draft.code}`,
          'warning',
          COLOR.drafts,
          'unsaved draft',
          linkOrText(draft.url, `${draft.config} · Save or Apply in Dash`),
          <Text color={COLOR.drafts}>{`${draft.hoursLeft} h left`}</Text>,
        ),
        line(`tp-draft-${draft.code}-what`, 'blank', MUTED, 'draft change', dim(`${draft.code} ${draft.change}`)),
      ]),
    ),
    section(
      'tp-prs',
      'Pull requests',
      'github',
      COLOR.prs,
      prs.flatMap(pr => prRows(pr, pr.isConfig ? lane(`tp-pr-lane-${pr.key}`, ['Build', 'Review', 'Merged'], pr.lane) : undefined)),
      ticket === null || ticket.codeLane === null ? undefined : lane('tp-code-lane', ['Build', 'Review', 'Merged'], ticket.codeLane),
    ),
    section(
      'tp-exp',
      experiments.length > 1 ? 'Experiments' : 'Experiment',
      'flask',
      COLOR.experiment,
      experiments.flatMap(exp => [
        line(`tp-exp-${exp.name}`, 'flask', COLOR.experiment, 'experiment', linkOrText(exp.url, exp.name), lane(`tp-exp-lane-${exp.name}`, ['Draft', 'Live', 'Ended'], exp.lane)),
        line(`tp-exp-${exp.name}-title`, 'blank', MUTED, 'experiment title', dim(exp.title)),
        ...exp.variants.map(variant =>
          line(
            `tp-exp-${exp.name}-${variant.label}`,
            'blank',
            MUTED,
            'variant',
            <Box key={`tp-exp-${exp.name}-${variant.label}-row`} flexDirection="row" gap={1} minWidth={0}>
              {slot(`tp-exp-${exp.name}-${variant.label}-arrow`, 'arrow', COLOR.experiment, 'variant')}
              {linkOrText(variant.url, variant.label)}
            </Box>,
            <Text color={variant.share === 'off' ? MUTED : COLOR.experiment}>{variant.share}</Text>,
          ),
        ),
      ]),
    ),
    section(
      'tp-design',
      'Design',
      'palette',
      COLOR.design,
      design.map(link => line(`tp-design-${link.url}`, 'figma', COLOR.design, 'Figma', <Link href={link.url} label={link.label} />)),
    ),
    section(
      'tp-docs',
      'Docs',
      'doc',
      COLOR.docs,
      docs.map(link => line(`tp-doc-${link.url}`, link.kind === 'notion' ? 'notion' : 'claude', link.kind === 'notion' ? '#e6e6e6' : ACCENT, link.kind, <Link href={link.url} label={link.label} />)),
    ),
    section(
      'tp-related',
      'Related tickets',
      'linear',
      COLOR.ticket,
      (ticket?.related ?? []).map(one => line(`tp-rel-${one.id}`, 'linear', COLOR.ticket, 'Linear', linkOrText(one.url, one.title === '' ? one.id : `${one.id} · ${one.title}`))),
    ),
    section('tp-people', 'People', 'slack', COLOR.people, [
      ...(ticket?.people ?? []).map(person =>
        line(`tp-person-${person.name}`, 'slack', COLOR.people, 'Slack', linkOrText(person.url, person.name), <Text dimColor>{person.role}</Text>),
      ),
      ...slackErrors.map((error, i) => line(`tp-people-error-${i}`, 'warning', COLOR.drafts, 'problem', <Text color={COLOR.drafts}>{error}</Text>)),
    ]),

  ]

  // Below the separator: what waits on you across sessions, then the sessions themselves.
  const bottom: RenderNode[] = [
    section(
      'tp-slack',
      'Slack',
      'slackColor',
      COLOR.slack,
      parts.slack.length === 0 && parts.slackError !== null
        ? [line('tp-slack-error', 'warning', COLOR.drafts, 'problem', <Text color={COLOR.drafts}>{oneLine(parts.slackError, 160)}</Text>)]
        : parts.slack.flatMap(convo => [
            line(
              `tp-slack-${convo.key}`,
              'slackColor',
              COLOR.slack,
              'conversation',
              linkOrText(convo.url, convo.name),
              plainButton(`tp-slack-done-${convo.key}`, '✓', convo.onDone),
            ),
            ...(convo.latest === '' ? [] : [line(`tp-slack-${convo.key}-latest`, 'blank', MUTED, 'latest message', message(convo.latest), <Text dimColor>{convo.at}</Text>)]),
          ]),
      parts.slack.length === 0 ? undefined : plainButton('tp-slack-clear-all', 'clear all', parts.onClearSlack),
    ),
    section('tp-gmail', 'Gmail', 'gmail', COLOR.gmail, []),
  ]

  // Code Review: where review stands on each of the session's open PRs, and the threads that wait on you.
  const needYou = parts.reviews.reduce((sum, review) => sum + review.waiting.length + (review.decision === 'changes' ? 1 : 0), 0)
  bottom.push(
    section(
      'tp-review',
      'Code Review',
      'eye',
      COLOR.review,
      parts.reviews.flatMap(review => [
        line(
          `tp-review-${review.key}`,
          'pr',
          REVIEW_COLOR[review.decision],
          'pull request',
          <Link href={review.url} label={review.key} />,
          <Text color={REVIEW_COLOR[review.decision]}>
            {review.decision === 'changes'
              ? `changes requested${review.changesBy.length === 0 ? '' : ` · ${review.changesBy.join(', ')}`}`
              : review.decision === 'approved'
                ? 'approved'
                : 'waiting for review'}
          </Text>,
        ),
        ...review.waiting.slice(0, REVIEW_THREADS_SHOWN).map((thread, i) =>
          line(
            `tp-review-${review.key}-thread-${i}`,
            'blank',
            MUTED,
            'comment waiting on you',
            <Text wrap="truncate-end">
              <Text color={COLOR.drafts}>{`${thread.author} `}</Text>
              <Text dimColor>{thread.text}</Text>
            </Text>,
            thread.url === null ? undefined : <Link href={thread.url} label="reply" />,
          ),
        ),
        ...(review.waiting.length > REVIEW_THREADS_SHOWN
          ? [line(`tp-review-${review.key}-more`, 'blank', MUTED, 'more comments', dim(`+${review.waiting.length - REVIEW_THREADS_SHOWN} more comments`))]
          : []),
        ...(review.requested.length === 0 ? [] : [line(`tp-review-${review.key}-requested`, 'blank', MUTED, 'pending reviewers', dim(`waiting on ${review.requested.join(', ')}`))]),
      ]),
      needYou > 0 ? <Text color={COLOR.experiment}>{`${needYou} need you`}</Text> : undefined,
      parts.reviews.length,
    ),
  )

  // Sessions sit last: collapsible, and paged like the band's list so the pane stays short.
  const below = Math.max(0, parts.sessions.length - parts.sessionsOffset - parts.sessionsShown)
  bottom.push(
    section(
      'tp-sessions',
      'Related Sessions',
      'sessions',
      COLOR.sessions,
      parts.sessions.length === 0
        ? []
        : [
              ...parts.sessions.slice(parts.sessionsOffset, parts.sessionsOffset + parts.sessionsShown).flatMap(sessionRows),
              ...(parts.sessionsOffset > 0 || below > 0
                ? [
                    line(
                      'tp-sessions-scroll',
                      'blank',
                      MUTED,
                      'more sessions',
                      <Box key="tp-sessions-scroll-row" flexDirection="row" gap={2}>
                        {parts.sessionsOffset > 0 && plainButton('tp-sessions-up', `▲ ${parts.sessionsOffset} above`, () => parts.onScrollSessions(-parts.sessionsShown))}
                        {below > 0 && plainButton('tp-sessions-down', `▼ ${below} more`, () => parts.onScrollSessions(parts.sessionsShown))}
                      </Box>,
                    ),
                  ]
                : []),
            ],
      parts.needYou > 0 ? <Text color={COLOR.experiment}>{`${parts.needYou} need you`}</Text> : undefined,
      parts.sessions.length,
    ),
  )

  // A section after a separator brings its own margin; a bare line (the TL;DR) asks for one below it.
  const separator = (key: string, isSpacedBelow = false) => (
    <Box key={key} marginTop={1} marginBottom={isSpacedBelow ? 1 : 0} overflow="hidden">
      {Svg ? <Svg source={separatorSvg(parts.columns * 7)} alt="separator" width={parts.columns * 7} height={9} /> : <Text dimColor>{'─'.repeat(parts.columns)}</Text>}
    </Box>
  )

  // A row with no icon slot, flush with the bars under the headline's text, and an optional value on the right.
  const flush = (key: string, content: RenderNode, right?: RenderNode) => (
    <Box key={key} flexDirection="row" gap={1} alignItems="flex-start">
      <Box key={`${key}-body`} flexDirection="column" flexGrow={1} flexShrink={1} minWidth={0}>
        {content}
      </Box>
      {right !== undefined && (
        <Box key={`${key}-right`} flexShrink={0}>
          {right}
        </Box>
      )}
    </Box>
  )

  // The bars skip the icon slot: they start under the headline's text and run to the right edge.
  const barWidth = Math.max(160, parts.columns * 7 - 40)

  // The rows above the footer: the TL;DR as it wraps, the sections, the separator, any problems.
  const tldrRows = parts.tldr === null ? 1 : Math.ceil((parts.tldr.length + 7) / Math.max(20, parts.columns - 4))
  const bodyRows = rowsDrawn() + 4 + tldrRows + 2 + (ticket?.errors.length ?? 0)

  // Context opens the footer, above Keep warm and the snake.
  const contextSection = (
    section(
      'tp-context',
      'Context',
      'pie',
      COLOR.context,
      view === null
        ? []
        : [
            flush('tp-context-used', <Text bold>{`${view.percent}% used`}</Text>, <Text dimColor>{`${fmtK(view.tokens)} / ${fmtK(view.window)}`}</Text>),
            <Box key="tp-context-bar">
              {Svg ? (
                <Svg source={contextSvg(view, barWidth)} alt={`${view.percent}% of the context used`} width={barWidth} height={6} />
              ) : (
                <Text>
                  <Text color="blue">{'█'.repeat(Math.round(view.percent / 4))}</Text>
                  <Text dimColor>{'░'.repeat(25 - Math.round(view.percent / 4))}</Text>
                </Text>
              )}
            </Box>,
            ...(parts.mode === null
              ? []
              : [
                  flush(
                    'tp-context-mode',
                    <Text wrap="truncate-end">
                      <Text>{modelName(parts.mode.model)}</Text>
                      {parts.mode.effort !== null && <Text dimColor>{` · ${parts.mode.effort}`}</Text>}
                      {parts.mode.fast !== null && <Text color={parts.mode.fast === 'on' ? ACCENT : MUTED}>{` · ⚡ fast ${parts.mode.fast}`}</Text>}
                    </Text>,
                    parts.cache === null ? undefined : <Text color={parts.cache.color}>{parts.cache.text}</Text>,
                  ),
                ]),
          ],
      undefined,
      undefined,
      false,
    )
  )

  const problems = ticket?.errors.filter(error => !error.startsWith('Slack')) ?? []
  const isReading = parts.tldr === null && parts.ticketId !== null && (parts.isLoading || ticket === null)
  const isAnyOpen = foldable.some(key => !parts.isCollapsed(key))
  const foldAll =
    foldable.length === 0 ? undefined : plainButton('tp-fold-all', isAnyOpen ? 'hide all' : 'show all', () => parts.onFoldAll(foldable, isAnyOpen))
  const snakeWidth = Math.max(48, parts.columns * 7 - 190 - (ticket === null ? 0 : 120))

  const head = (
    <>
      {line(
        'tp-status',
        'activity',
        parts.status.color,
        'status',
        <Text wrap="truncate-end">
          <Text bold color={parts.status.color}>
            Status
          </Text>
          {` ${parts.status.text}`}
        </Text>,
        foldAll,
      )}
      {separator('tp-status-separator', true)}
      {parts.tldr !== null &&
        line(
          'tp-tldr',
          'spark',
          COLOR.tldr,
          'TL;DR',
          <Text wrap="wrap">
            <Text bold color={COLOR.tldr}>
              TL;DR
            </Text>
            {` ${parts.tldr}`}
          </Text>,
        )}
      {isReading && line('tp-tldr', 'spark', COLOR.tldr, 'loading', dim(`Reading ${parts.ticketId}…`))}
      {sections}
      {separator('tp-separator')}
      {bottom}
      {problems.map((error, i) => (
        <Box key={`tp-problem-${i}`} marginTop={i === 0 ? 1 : 0}>
          {line(`tp-problem-line-${i}`, 'warning', COLOR.drafts, 'problem', <Text color={COLOR.drafts} wrap="wrap">{error}</Text>)}
        </Box>
      ))}
    </>
  )
  const footer = (
    <>
      {separator('tp-footer-separator')}
      {contextSection}
      <Box key="tp-foot" flexDirection="row" alignItems="center" columnGap={2} marginTop={1}>
        {ticket !== null && plainButton('tp-refresh', parts.isLoading ? 'Refreshing…' : `Updated ${parts.clock(ticket.loadedAt)}`, parts.onRefresh)}
        {ticket === null && parts.isLoading && <Text dimColor>Loading…</Text>}
        <Box key="tp-snake" flexGrow={1} flexShrink={1} minWidth={0}>
          {Svg && (
            <Svg source={snakeSvg(snakeWidth, parts.isWorking)} alt={parts.isWorking ? 'a pixel snake slithers by' : 'a pixel snake rests'} width={snakeWidth} height={24} isInteractive />
          )}
        </Box>
        <Box key="tp-foot-actions" flexDirection="row" columnGap={2} flexShrink={0}>
          <Button key="tp-keep-warm" plain onPress={parts.onKeepWarm}>
            <Text color={parts.warmFor === null ? MUTED : COLOR.prs}>{parts.warmFor === null ? '○' : '●'}</Text>
            {parts.warmFor === null ? ' Keep warm' : ` Warm · ${parts.warmFor}`}
          </Button>
          {plainButton('tp-kiss', 'KISS', parts.onKiss, parts.isKissDimmed)}
        </Box>
      </Box>
    </>
  )

  // A pane too short for a pinned footer draws one long column the engine scrolls.
  // The separator, Context, and the button row.
  const footerRows = 2 + (parts.context === null ? 2 : parts.mode === null ? 5 : 6) + 2
  const roomRows = parts.rows - footerRows
  if (roomRows < STICKY_MIN_ROWS) {
    return (
      <Box flexDirection="column">
        {head}
        {footer}
      </Box>
    )
  }
  // The footer stays pinned: the pane is one screen tall, and the body above it slides inside its own clip.
  const maxOffset = Math.max(0, bodyRows - roomRows + 2)
  parts.onBodyRows(maxOffset)
  const offset = Math.min(parts.offset, maxOffset)
  return (
    <Box flexDirection="column" height={parts.rows}>
      <Box key="tp-body" flexDirection="column" flexGrow={1} flexShrink={1} overflow="hidden">
        <Box key="tp-body-inner" flexDirection="column" flexShrink={0} marginTop={-offset}>
          {head}
        </Box>
      </Box>
      {maxOffset > 0 && (
        <Box key="tp-scroll" flexDirection="row" justifyContent="flex-end" columnGap={2}>
          {offset > 0 && plainButton('tp-scroll-up', '▲', () => parts.onScroll(-SCROLL_STEP_ROWS))}
          {offset < maxOffset && plainButton('tp-scroll-down', '▼', () => parts.onScroll(SCROLL_STEP_ROWS))}
        </Box>
      )}
      <Box key="tp-footer" flexDirection="column" flexShrink={0}>
        {footer}
      </Box>
    </Box>
  )
}
