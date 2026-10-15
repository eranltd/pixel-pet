# How to Build a Claude Code Mod: A Complete Example (With a Pixel Pet)

*A working Claude Code mod in four files: a live band above the prompt, a slash command, and state that survives reloads. Plus the open-source mod I built on top of it.*

![A Claude Code session with a custom mod drawing a pixel dog, a sessions board and plan progress above the prompt](https://raw.githubusercontent.com/eranltd/pixel-pet/main/docs/images/app-demo.png)

*A mock of a running Claude Code session with the pixel-pet mod. Every name and message is made up.*

---

If you searched for a Claude Code mod example and found mostly fragments, this is the full thing. By the end you will have a mod that draws an animated pixel cat above your prompt and adds a `/pet` command. It works in the terminal and in the desktop app.

I'll also show what the same pattern grows into: **Bit**, a pixel puppy that runs a status board for every Claude Code session on my machine. It is open source at [github.com/eranltd/pixel-pet](https://github.com/eranltd/pixel-pet).

## What is a Claude Code mod?

A Claude Code mod is a plugin with a **hooks module**: a TypeScript file that Claude Code loads into its own interface. It can draw UI above the prompt, open side panes, add slash commands, and react to what the session does: tool calls, prompts, turns starting and ending.

Three things make it different from a script you run next to your editor:

- **It runs inside Claude Code.** The module lives in a sandbox with no DOM and no Node. Everything outside it goes through one object, `$`: `$.ui`, `$.state`, `$.clock`, `$.fs`, `$.process`.
- **It draws with the engine's own elements.** `Box`, `Text`, `Button`, and per surface `Raster` for the terminal or `Svg` for the desktop app.
- **It is typed and validated.** The engine writes the full API types into your mod folder, and `claude plugin validate` checks your module before it ever loads.

## The anatomy of a mod: four files

```
my-pet/
├── .claude-plugin/plugin.json   the manifest
├── hooks/hooks.json             names the hooks module
├── hooks/register.tsx           the module: hooks, drawing, commands
└── types/index.d.ts             the state contract
```

### 1. The manifest

`.claude-plugin/plugin.json`:

```json
{
  "name": "my-pet",
  "version": "0.1.0",
  "description": "A pixel cat above the prompt",
  "types": "./types/index.d.ts"
}
```

### 2. The hooks entry

`hooks/hooks.json`:

```json
{ "modules": ["./register.tsx"] }
```

### 3. The state contract

Values a drawing reads belong in `$.state`, not in module variables. A reload runs your module again and resets its variables, but `$.state` is held by the host and survives. Every value is declared under the mod's name.

`types/index.d.ts`:

```ts
declare module 'claude-code' {
  interface PluginState {
    'my-pet': {
      frame: number
      isHidden: boolean
    }
  }
}
```

Keep this file a plain declaration. An `export {}` at the end makes the validator miss the contract.

### 4. The hooks module

`hooks/register.tsx` is the whole mod: a 12×8 pixel cat that flicks its tail, drawn as a `Raster` in the terminal and an animated `Svg` in the desktop app, plus a `/pet` command that hides it.

```tsx
import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

// One letter per pixel; '.' is transparent. Two frames: the tail flicks.
const FRAMES = [
  ['..k.....k...', '.kkkkkkkkk..', '.kwkkkkkwk..', '.kkkkpkkkk..', '..kkkkkkkk.k', '..kkkkkkkkk.', '..k.k..k.k..', '............'],
  ['..k.....k...', '.kkkkkkkkk..', '.kwkkkkkwk..', '.kkkkpkkkk..', '..kkkkkkkk..', '..kkkkkkkkkk', '..k.k..k.k..', '............'],
]
const WIDTH = 12
const HEIGHT = 8
const PALETTE: Record<string, number> = { k: 0x3b3b3b, w: 0x9be36d, p: 0xff9eb5 }
const TERMINAL_DEFAULT = 0x01000000
const TICK_MS = 500
const PIXEL_PX = 4

const frameAtom = atom({ plugin: 'my-pet', key: 'frame' } as const, 0)
const hiddenAtom = atom({ plugin: 'my-pet', key: 'isHidden' } as const, false)

function toBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i] ?? 0
    const b = bytes[i + 1] ?? 0
    const c = bytes[i + 2] ?? 0
    const n = (a << 16) | (b << 8) | c
    out += alphabet[(n >> 18) & 63]! + alphabet[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? alphabet[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? alphabet[n & 63]! : '='
  }
  return out
}

// Terminal: one Raster, each cell a half-block glyph so one text row holds two pixel rows.
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

// Desktop: one SVG, a rect per pixel; SMIL flips the frames so no redraw is needed.
function animatedSvg(): string {
  const dur = `${(FRAMES.length * TICK_MS) / 1000}s`
  const groups = FRAMES.map((rows, tick) => {
    const rects = rows.flatMap((row, y) =>
      row.split('').flatMap((ch, x) => {
        const color = PALETTE[ch]
        return color === undefined ? [] : [`<rect x="${x}" y="${y}" width="1" height="1" fill="#${color.toString(16).padStart(6, '0')}"/>`]
      }),
    )
    const start = tick / FRAMES.length
    const end = (tick + 1) / FRAMES.length
    const [values, keyTimes] = tick === 0 ? ['visible;hidden', `0;${end}`] : ['hidden;visible;hidden', `0;${start};${end}`]
    return `<g visibility="${tick === 0 ? 'visible' : 'hidden'}"><animate attributeName="visibility" values="${values}" keyTimes="${keyTimes}" dur="${dur}" repeatCount="indefinite" calcMode="discrete"/>${rects.join('')}</g>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH * PIXEL_PX}" height="${HEIGHT * PIXEL_PX}" shape-rendering="crispEdges">${groups.join('')}</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'pet', description: 'Show or hide the pixel cat' })
    // The terminal Raster redraws on each tick; the desktop SVG animates itself.
    $.clock.every(TICK_MS, async () => {
      await update($, frameAtom, frame => (frame + 1) % FRAMES.length)
    })
    return started
  })

  on('command.run', { command: 'pet' }, async $ => {
    const isHidden = await update($, hiddenAtom, hidden => !hidden)
    return { text: isHidden ? 'The cat went for a nap.' : 'The cat is back.' }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, hiddenAtom))) {
      return next(e)
    }
    let pet
    if (e.surface === 'terminal') {
      const { Raster } = $.ui.resolve(e)
      const frame = await read($, frameAtom)
      pet = <Raster key="pet" columns={WIDTH} rows={HEIGHT / 2} cells={toRasterCells(FRAMES[frame] ?? FRAMES[0]!)} />
    } else if (e.surface === 'desktop') {
      const { Svg } = $.ui.resolve(e)
      pet = <Svg source={animatedSvg()} alt="a pixel cat" width={WIDTH * PIXEL_PX} height={HEIGHT * PIXEL_PX} isInteractive />
    } else {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" alignItems="center" columnGap={2}>
        {pet}
        <Text color={e.props.isWorking ? 'cyan' : 'gray'}>{e.props.isWorking ? 'working…' : 'ready'}</Text>
      </Box>
    )
  })
}
```

## How the Claude Code hooks API works

**Every hook has one shape.** `on(event, matcher?, hook)` adds a hook, and the hook receives `($, e, next)`. `$` is the engine, `e` is the event's frozen input, and `next(e)` runs the plugins beneath and then Claude Code itself. Return without calling `next` and your hook answers for itself.

**Drawing is a render hook.** `ui.render` on `{ component: 'AbovePrompt' }` draws the band above the prompt. Return a tree to show it, or `next(e)` to show nothing. `e.props.bodyColumns` gives you the width, so a band can switch layouts on narrow windows.

**Commands are two calls.** Register the name with `$.command.register` in `session.start`, then answer it with a `command.run` hook that returns `{ text }`.

**State redraws for you.** `read($, atom)` inside a render hook subscribes the drawing. `update($, atom, fn)` from a timer or another hook redraws it.

**Animation without redraws.** On the desktop, the SVG uses SMIL animations to flip frames by itself. That matters more than it sounds: every redraw replaces the buttons under the pointer, so a tail that redraws the band steals your clicks.

## Run, validate and test your mod

Run it from its folder for one session:

```bash
claude --plugin-dir ./my-pet
```

For sessions the desktop app starts, name the folder in the `env` block of `~/.claude/settings.json` as `CLAUDE_CODE_PLUGIN_DIRS`. A terminal session reloads the mod on every save. In the desktop app, type `/reload-plugins` at the prompt after an edit.

Check it before you load it:

```bash
claude plugin validate ./my-pet
```

Test it. A test mounts a component and asserts on the tree it draws:

```tsx
import { expect, mock, test } from 'claude-code/testing'

test('the cat draws above the prompt', async ($, on) => {
  mock.clock(on, { now: 1_800_000_000_000 })
  mock.store(on)
  const props = { hasSurvey: false, isWorking: false, maxRows: 20, bodyColumns: 120, scroll: { bodyRows: 20, offset: 0 }, view: {} } as never
  const ui = await $.ui.mount({ plugin: 'my-pet', surface: 'terminal', component: 'AbovePrompt', props })
  expect(await ui.find({ key: 'pet' })).toBeDefined()
  await ui.unmount()
})
```

```bash
claude plugin test ./my-pet
```

After the first load, the engine writes the API types into `.claude-plugin/types/`, with a `tsconfig.json` your mod can extend. From then on `tsc -p ./my-pet` type-checks it.

## A real Claude Code mod example: Bit, the pixel puppy

The cat above is the skeleton. Here is what I grew it into.

![Bit the pixel puppy in three moods: ready, working and passed](https://raw.githubusercontent.com/eranltd/pixel-pet/main/docs/images/sprite-poses.png)

Bit sits in the top-left corner of the band. He works while Claude works, hops when a task finishes, droops when a check fails, and sits up with `needs you` when a tool call waits on my permission. Around him the band shows:

- **Sessions**: every Claude Code session on my machine, the ones blocked on me first. Each session writes a small JSON snapshot every few seconds and reads the others back.
- **The plan**: phase dots, a progress bar, and the task list, filled by a hook that watches Claude write its task list.
- **Slack**: messages waiting for a reply, each with a tick to dismiss.
- **The context line**: cache age, context used, rate-limit budget, and a button to summarize and start fresh.
- **Actions**: one favorite button, with a pane behind it for the rest.

![The pixel-pet band up close: sessions board, plan progress bar and Slack inbox](https://raw.githubusercontent.com/eranltd/pixel-pet/main/docs/images/band-demo.png)

None of it is a separate app. It is one hooks module of a few thousand lines, built by describing what I wanted, in sentences, while using the tool. "Move the dog to the corner." "Make him smaller." "Why is there a gap next to Slack?" Each was a one-minute round trip.

## Lessons from building a Claude Code plugin

- **There is no font size.** `Text` takes color, dim, bold, italic, underline and strikethrough. Smaller means dim and compact.
- **Keep action tables as data.** The engine refuses a table of closures that receive `$`. Switch on an id in one named function instead.
- **Links must be `https:`.** The band refuses anything else.
- **The desktop prompt does not pass mod commands through.** Give every command a button too.
- **Design for narrow windows.** Read `bodyColumns` and trim rows, or the band grows tall enough to scroll.
- **Ship a demo mode.** Screenshots of a real session leak names. Bit's demo button fills the band with made-up data.

## Install the pixel-pet mod

At the prompt of a terminal Claude Code session:

```
/plugin install pixel-pet --marketplace eranltd/pixel-pet
```

Answer `y` to add the marketplace and choose the user scope. A mod installed from a terminal at the user scope loads in the desktop app too.

The repository is its own marketplace: one file, `.claude-plugin/marketplace.json`, lists the mod. To share yours, add that file and push the folder to GitHub.

## FAQ

**What is the difference between a Claude Code plugin and a mod?**
A mod is a plugin whose behavior lives in a hooks module, so it can change Claude Code's own interface: bands, panes, commands, and reactions to tool calls.

**Can a Claude Code mod draw custom UI?**
Yes. A `ui.render` hook returns a tree of the engine's elements. The band above the prompt and side panes are the common places.

**Does a mod work in the Claude Code desktop app?**
Yes. Draw for `e.surface === 'desktop'` with `Svg` and the standard elements, and for `terminal` with `Raster`. Install from a terminal at the user scope.

**How do I debug a Claude Code mod?**
Run `claude plugin validate` first. While a folder hot-reloads, the transcript shows one dim line when a hook fails or a tree does not validate, and `claude --debug` logs every refusal.

**How do I share a Claude Code mod?**
Add `.claude-plugin/marketplace.json` to the mod's folder, push it to GitHub, and share `/plugin install <name> --marketplace <owner>/<repo>`.

---

*The full source, the guide and the demo images are at [github.com/eranltd/pixel-pet](https://github.com/eranltd/pixel-pet). Start with the cat. Give it a tail that flicks.*
