// The Team show: the session's models drawn as a terminal-style agent tree that plays one loop of the
// advisor flow (plan check, a repeated error, the check before done) on SVG animations alone.

export type TeamShow = {
  main: string
  effort: string | null
  advisor: string | null
  wakes: number | null
  subagent: string | null
  agents: readonly string[]
}

const LOOP_S = 14
const VIEW_W = 760
const VIEW_H = 590
const FONT = `font-family="ui-monospace,SFMono-Regular,Menlo,monospace"`

const C = {
  bg: '#0d1117',
  line: '#30363d',
  text: '#e6edf3',
  muted: '#8b949e',
  advisor: '#a78bfa',
  main: '#f0883e',
  checker: '#58a6ff',
  swarm: '#3fb950',
  fail: '#f85149',
}

const esc = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

const short = (model: string) => model.replace(/^claude-/, '').replace(/-(\d+)-(\d+)$/, ' $1.$2')

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Hidden until `at` seconds into the loop, then shown for the rest of it.
const appear = (at: number, fade = 0.3) =>
  `<animate attributeName="opacity" values="0;0;1;1" keyTimes="0;${(at / LOOP_S).toFixed(3)};${((at + fade) / LOOP_S).toFixed(3)};1" dur="${LOOP_S}s" repeatCount="indefinite"/>`

// Lit from `at` for `hold` seconds, dim otherwise.
const flash = (at: number, hold: number) => {
  const k = (s: number) => Math.min(1, Math.max(0, s / LOOP_S)).toFixed(3)
  return `<animate attributeName="opacity" values="0;0;1;1;0;0" keyTimes="0;${k(at)};${k(at + 0.25)};${k(at + hold)};${k(at + hold + 0.4)};1" dur="${LOOP_S}s" repeatCount="indefinite"/>`
}

const text = (x: number, y: number, body: string, color = C.text, size = 12, extra = '') =>
  `<text x="${x}" y="${y}" fill="${color}" font-size="${size}" ${FONT} ${extra}>${body}</text>`

const box = (x: number, y: number, w: number, h: number, color: string, isDashed = false) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="6" fill="${C.bg}" stroke="${color}" stroke-width="1.2"${isDashed ? ' stroke-dasharray="4 4"' : ''}/>`

const wire = (d: string) => `<path d="${d}" fill="none" stroke="${C.line}" stroke-width="1.2"/>`

export function teamShowSvg(show: TeamShow): string {
  const main = short(show.main || 'model')
  const sub = short(show.subagent ?? show.main ?? 'model')
  const advisor = show.advisor === null ? null : short(show.advisor)
  const swarm = (show.agents.length > 0 ? show.agents.map(agent => clip(agent, 13)) : ['grep', 'files', 'docs', 'specs', 'tags', 'summary']).slice(0, 6)
  const parts: string[] = []

  // The command line types itself out, then its cursor blinks.
  const command = `$ claude --model ${esc(main)}${advisor === null ? '' : ` --advisor ${esc(advisor)}`}`
  parts.push(
    `<clipPath id="ts-type"><rect x="16" y="8" height="24" width="0"><animate attributeName="width" values="0;${command.length * 7.3};${command.length * 7.3}" keyTimes="0;0.1;1" dur="${LOOP_S}s" repeatCount="indefinite"/></rect></clipPath>`,
    `<g clip-path="url(#ts-type)">${text(16, 26, command, C.muted, 12)}</g>`,
    `<rect x="${18 + command.length * 7.3}" y="15" width="7" height="14" fill="${C.text}"><animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite" calcMode="discrete"/></rect>`,
  )

  // The advisor: wakes at three moments and never writes code.
  const checkpoints: [string, string, number][] = [
    ['before a plan locks', 'what did the plan miss?', 1.6],
    ['an error repeats', 'root cause or rabbit hole?', 6.2],
    ['before calling done', 'did the diff break anything?', 10.8],
  ]
  if (advisor === null) {
    parts.push(box(16, 46, 220, 330, C.muted, true), text(32, 72, '○ no advisor', C.muted, 13), text(32, 94, '/advisor fable', C.muted, 11))
  } else {
    parts.push(
      box(16, 46, 220, 330, C.advisor),
      text(32, 72, `● ${esc(advisor)} · advising`, C.advisor, 13, 'font-weight="600"'),
      text(32, 92, `/advisor ${esc(advisor)}`, C.muted, 11),
      text(32, 108, 'reads the session', C.muted, 10),
      text(32, 121, 'writes no code', C.muted, 10),
    )
    checkpoints.forEach(([title, question, at], i) => {
      const y = 148 + i * 70
      parts.push(
        `<rect x="30" y="${y}" width="192" height="26" rx="4" fill="none" stroke="${C.line}"/>`,
        `<rect x="30" y="${y}" width="192" height="26" rx="4" fill="${C.advisor}">${flash(at, 2.4)}</rect>`,
        text(40, y + 17, `✓ ${title}`, C.text, 11),
        text(32, y + 44, question, C.muted, 10),
      )
    })
    parts.push(
      text(32, 364, show.wakes === null ? 'wakes up' : `wakes ${show.wakes}`, C.muted, 10),
      ...checkpoints.map(([, , at], i) => `<g opacity="0">${text(196, 364, `${i + 1} / 3`, C.advisor, 10)}${flash(at, i === 2 ? 2.8 : 4.4)}</g>`),
    )
    // Consult: the advisor and the main session trade notes over a moving dashed line.
    parts.push(
      `<path d="M236 82 H300" fill="none" stroke="${C.advisor}" stroke-width="1.2" stroke-dasharray="3 4"><animate attributeName="stroke-dashoffset" values="14;0" dur="0.8s" repeatCount="indefinite"/></path>`,
      text(246, 74, 'consult', C.advisor, 9),
    )
  }

  // The main session builds.
  parts.push(
    box(300, 46, 444, 84, C.main),
    text(316, 72, `● ${esc(main)}${show.effort ? ` · ${esc(show.effort)}` : ''} · main session`, C.main, 13, 'font-weight="600"'),
    text(316, 94, 'drives the build · writes diffs · runs tests', C.muted, 11),
    `<rect x="316" y="106" width="160" height="6" rx="3" fill="${C.line}"/>`,
    `<rect x="316" y="106" width="0" height="6" rx="3" fill="${C.main}"><animate attributeName="width" values="20;160;90;160;20" dur="${LOOP_S}s" repeatCount="indefinite"/></rect>`,
    wire('M522 130 V160'),
    box(402, 160, 240, 44, C.text),
    text(418, 180, '● Task · dispatch subagents', C.text, 12),
    text(418, 196, 'brief · files · what done means', C.muted, 10),
    wire('M522 204 V222 H405 V240 M522 222 H633 V240'),
  )

  // The checker tries to break the change; the swarm does the bulk reading.
  parts.push(
    box(300, 240, 210, 124, C.checker),
    text(316, 264, `○ ${esc(sub)} · checker`, C.checker, 12, 'font-weight="600"'),
    text(316, 286, 'tries to break it', C.text, 11),
    text(316, 302, 'changes nothing', C.muted, 10),
    `<g opacity="0">${text(316, 348, '✗ 2 failed', C.fail, 11)}${flash(5.4, 2.6)}</g>`,
    `<g opacity="0">${text(316, 348, '✓ tests passed', C.swarm, 11)}${appear(9.6)}</g>`,
    box(522, 240, 222, 124, C.swarm),
    text(538, 264, `○ ${esc(sub)} · swarm ×${swarm.length}`, C.swarm, 12, 'font-weight="600"'),
    ...swarm.map((item, i) => `<g opacity="0">${text(538 + (i % 2) * 104, 290 + Math.floor(i / 2) * 20, `✓ ${esc(item)}`, C.text, 11)}${appear(3 + i * 0.35)}</g>`),
    text(538, 352, 'bulk work', C.muted, 10),
    wire('M405 364 V384 H633 V364 M522 384 V396'),
    box(402, 396, 240, 30, C.muted),
    text(420, 416, '● back to main · verify · ship', C.muted, 11),
  )

  // A packet runs the build path: main, Task, checker, ship, and back up.
  parts.push(
    `<circle r="3.5" fill="${C.main}"><animateMotion path="M522 130 V160 M522 204 V222 H405 V240 M405 364 V384 H522 V396" dur="${(LOOP_S / 2).toFixed(1)}s" repeatCount="indefinite"/></circle>`,
  )

  const motto = [
    [`${advisor ?? 'nobody'} thinks.`, advisor === null ? C.muted : C.advisor],
    [`${main} builds.`, C.main],
    [`${sub} checks.`, C.checker],
    [`${sub} swarms.`, C.swarm],
  ] as const
  let mx = VIEW_W / 2 - motto.reduce((sum, [word]) => sum + (word.length + 1) * 7.3, 0) / 2
  for (const [word, color] of motto) {
    parts.push(text(mx, 456, esc(word), color, 12, 'opacity="0.75"'))
    mx += (word.length + 1) * 7.3
  }

  // The log of one loop, a line at a time.
  const log: [string, string, string, string, string, number][] = [
    [sub, C.checker, 'npm test', '2 failed', C.fail, 5.4],
    ['advisor', C.advisor, 'root cause: stale session cache', 'reviewed', C.muted, 6.6],
    ['update', C.main, 'src/auth/cache.ts', '+9 −3', C.swarm, 8.2],
    [sub, C.checker, 'npm test', 'all passed', C.swarm, 9.6],
    ['advisor', C.advisor, 'before done: diff verified clean', 'reviewed', C.muted, 11.2],
  ]
  log.forEach(([who, whoColor, what, result, resultColor, at], i) => {
    const y = 488 + i * 20
    parts.push(
      `<g opacity="0"><circle cx="22" cy="${y - 4}" r="3.5" fill="${whoColor}"/>${text(32, y, esc(clip(who, 12)), whoColor, 11)}${text(140, y, esc(what), C.text, 11)}${text(744, y, esc(result), resultColor, 11, 'text-anchor="end"')}${appear(at)}</g>`,
    )
  })

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW_W} ${VIEW_H}" width="${VIEW_W}" height="${VIEW_H}"><rect width="${VIEW_W}" height="${VIEW_H}" rx="8" fill="${C.bg}"/>${parts.join('')}</svg>`
}

export const TEAM_SHOW_RATIO = VIEW_H / VIEW_W

// The terminal has no SVG: the same tree, still.
export function teamShowLines(show: TeamShow): string[] {
  const main = short(show.main || 'model')
  const sub = short(show.subagent ?? show.main ?? 'model')
  const advisor = show.advisor === null ? 'off' : short(show.advisor)
  return [
    `$ claude --model ${main}${show.advisor === null ? '' : ` --advisor ${advisor}`}`,
    '',
    `● ${advisor} · advisor${show.wakes === null ? '' : ` · wakes ${show.wakes}`}`,
    '┆  consult: before a plan locks · an error repeats · before done',
    `● ${main}${show.effort ? ` · ${show.effort}` : ''} · main session`,
    '└─ Task · dispatch subagents',
    `   ├─ ${sub} · checker`,
    `   └─ ${sub} · swarm ×${Math.max(1, show.agents.length)}`,
    '      └─ back to main · verify · ship',
  ]
}
