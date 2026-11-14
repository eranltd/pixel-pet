// The Agents drawing: what the session really does, behind the scenes. A header with the model and the task,
// a row for each thing that happened (advisor wake-ups, the last check, subagents), then the newest tool calls.
// Nothing that did not happen gets a row, and it moves only while a turn runs.

// actor: the subagent that made the call, or null for the main session. input and output are kept for the Step pane.
export type TeamStep = { id: string; tool: string; detail: string; isError: boolean; actor: string | null; at: number; input: string; output: string }

export type TeamShow = {
  advisor: string | null
  wakes: number | null
  isWorking: boolean
  task: string | null
  progress: { done: number; total: number } | null
  check: { command: string; isOk: boolean } | null
  running: number
  agentsDone: number
  // Newest first.
  steps: readonly TeamStep[]
}

const ROW = 22
const PAD = 12
const FONT = `font-family="ui-monospace,SFMono-Regular,Menlo,monospace"`
const CHAR = 7.3

const C = {
  bg: '#0d1117',
  line: '#30363d',
  text: '#e6edf3',
  muted: '#8b949e',
  advisor: '#a78bfa',
  main: '#f0883e',
  read: '#58a6ff',
  write: '#3fb950',
  mcp: '#f778ba',
  fail: '#f85149',
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const short = (model: string) => model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text)

const text = (x: number, y: number, body: string, color = C.text, size = 12, extra = '') =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" ${FONT} ${extra}>${body}</text>`

const pulse = (dur = 1.1) => `<animate attributeName="opacity" values="1;0.3;1" dur="${dur}s" repeatCount="indefinite"/>`

function toolColor(step: TeamStep): string {
  if (step.isError) return C.fail
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(step.tool)) return C.write
  if (/^(Read|Grep|Glob|WebFetch|WebSearch|ToolSearch)$/.test(step.tool)) return C.read
  if (/^(Agent|Task|Skill)$/.test(step.tool)) return C.advisor
  if (step.tool === 'Bash') return C.main
  return C.mcp
}

const maxChars = (width: number) => Math.floor((width - PAD * 2) / CHAR)

// One line: a dot, a bold label in its color, then the detail in what room is left.
function row(width: number, y: number, color: string, label: string, detail: string, detailColor = C.text, actor: string | null = null) {
  const room = maxChars(width) - label.length - 4 - (actor === null ? 0 : actor.length + 2)
  const tag = actor === null ? '' : text(width - PAD - 10, y, esc(actor), C.muted, 11, 'text-anchor="end"')
  return `<g>${tag}<circle cx="${PAD + 4}" cy="${y - 4}" r="3.5" fill="${color}"/>${text(PAD + 14, y, esc(label), color, 12, 'font-weight="700"')}${room > 2 && detail !== '' ? text(PAD + 14 + (label.length + 1) * CHAR, y, esc(clip(detail, room)), detailColor, 12) : ''}</g>`
}

// Drawn at the pane's own width, so the text keeps its size and a wider pane shows more of each line.
export function teamShowSvg(show: TeamShow, width: number): { svg: string; height: number } {
  const MAX_CHARS = maxChars(width)
  const parts: string[] = []
  let y = PAD + 12

  // The header: the task in hand and the plan's progress, when there is a plan.
  const progress = show.progress === null ? '' : `${show.progress.done}/${show.progress.total}`
  if (show.task !== null || progress !== '') {
    parts.push(
      text(PAD, y, esc(clip(show.task ?? 'plan', MAX_CHARS - progress.length - 2)), C.main, 13, 'font-weight="700"'),
      progress === '' ? '' : text(width - PAD, y, progress, C.muted, 11, 'text-anchor="end"'),
    )
  } else {
    y -= 12
  }
  if (show.progress !== null && show.progress.total > 0) {
    const barWidth = width - PAD * 2
    y += 9
    parts.push(
      `<rect x="${PAD}" y="${y}" width="${barWidth}" height="3" rx="1.5" fill="${C.line}"/>`,
      `<rect x="${PAD}" y="${y}" width="${Math.max(4, Math.round((barWidth * show.progress.done) / show.progress.total))}" height="3" rx="1.5" fill="${C.main}">${show.isWorking ? pulse() : ''}</rect>`,
    )
  }
  y += 8

  // Only what happened: the advisor's wake-ups, the last check, the subagents.
  const facts: string[] = []
  if (show.advisor !== null && (show.wakes ?? 0) > 0) {
    facts.push(row(width, y + ROW, C.advisor, short(show.advisor), `woke ${show.wakes}×`, C.muted))
    y += ROW
  }
  if (show.check !== null) {
    facts.push(row(width, y + ROW, show.check.isOk ? C.write : C.fail, show.check.isOk ? '✓ check' : '✗ check', show.check.command))
    y += ROW
  }
  if (show.running + show.agentsDone > 0) {
    const label = show.running > 0 ? `${show.running} agent${show.running === 1 ? '' : 's'} at work` : 'agents'
    facts.push(`<g>${row(width, y + ROW, C.advisor, label, show.agentsDone > 0 ? `${show.agentsDone} done` : '', C.muted)}${show.running > 0 ? pulse(0.9) : ''}</g>`)
    y += ROW
  }
  parts.push(...facts)

  // The feed's rows are drawn one by one (feedRowSvg) so each can be pressed; with none, the header says why.
  if (show.steps.length > 0) {
    y += 6
    parts.push(`<line x1="${PAD}" y1="${y}" x2="${width - PAD}" y2="${y}" stroke="${C.line}"/>`)
  } else {
    y += ROW
    parts.push(text(PAD, y, show.isWorking ? '● working' : '○ waiting for a prompt', C.muted, 12))
    y += PAD
  }

  const height = y
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${C.bg}"/>${parts.join('')}</svg>`,
    height,
  }
}

export const FEED_ROW_HEIGHT = ROW

// One feed row, newest first: older rows fade, the last one keeps the box's bottom padding.
export function feedRowSvg(step: TeamStep, index: number, width: number, isLast: boolean): { svg: string; height: number } {
  const height = ROW + (isLast ? 8 : 0)
  const fade = index === 0 ? '' : ` opacity="${Math.max(0.35, 1 - index * 0.15).toFixed(2)}"`
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="${C.bg}"/><g${fade}>${row(width, 16, toolColor(step), step.tool, step.detail, index === 0 ? C.text : C.muted, step.actor)}</g></svg>`,
    height,
  }
}
