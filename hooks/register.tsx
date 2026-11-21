import type { EngineInterface, Register } from 'claude-code'

import { setupWarning, verifyDesktop, DesktopError } from '../src/agent-desktop.ts'
import { drivesAgentDesktop } from '../src/agent-desktop-args.ts'
import {
  artifactName,
  chipText,
  describeActivity,
  explainFailure,
  presentResult,
  snapshotLabel,
  TrailModel,
  type Fact,
  type Presentation,
} from '../src/desktop-present.ts'
import { DESKTOP_GUIDELINES, DESKTOP_TOOLS, prepareDesktopInput } from '../src/desktop-tools.ts'
import { env } from '../src/env.ts'
import type { DesktopHost } from '../src/host.ts'
import { desktopHealth, desktopSummary, inputModeLine, mergeDesktopState, serializeDesktopState, type DesktopState } from '../src/state.ts'

// da-desktop as a Claude Code mod. The desktop core in ../src is shared with the pi
// extension; this file is the Claude Code host: its tools, /desktop, and the same three
// surfaces pi has, each answering one question:
//   status line   which app is the agent in?      static, hidden when idle
//   band          what is it doing right now?     above the prompt, only during a burst
//   tool rows     what did it do, what changed?   call line, then only new facts

type $ = EngineInterface

const PLUGIN = 'da-desktop'
const PREFIX = `mcp__${PLUGIN}__`
const USAGE = 'Usage: /desktop status | headed on|off'

const GUIDELINES = `# da-desktop

The mcp__da-desktop__desktop_* tools see and operate the user's desktop apps through agent-desktop, which reads the OS accessibility tree. Every call runs in this session's own snapshot namespace.

${[...DESKTOP_GUIDELINES, 'Never drive agent-desktop through Bash; it runs outside this session, so its refs do not work here and its output is not kept private. Version, status, permissions, skills and --help are fine.']
  .map(line => `- ${line}`)
  .join('\n')}`

// ---------------------------------------------------------------------------
// The host the core runs on: $.process and $.fs in place of pi.exec and node:fs
// ---------------------------------------------------------------------------

async function makeHost($: $): Promise<DesktopHost> {
  const [cwd, sessionId] = await Promise.all([$.session.cwd(), $.session.id()])
  return {
    async exec(command, args, { timeout, stdin }) {
      try {
        const ran = await $.process.run([command, ...args], {
          timeoutMs: Math.min(Math.max(timeout, 1000), 600_000),
          ...(stdin === undefined ? {} : { stdin }),
        })
        return { stdout: ran.stdout, stderr: ran.stderr, code: ran.exitCode }
      } catch (error) {
        // $.process.run rejects on a timeout or a command that cannot start; pi.exec
        // reports both as a failed run, which is what the core expects.
        return { stdout: '', stderr: error instanceof Error ? error.message : String(error), code: 1, killed: true }
      }
    },
    writeFile: (path, text) => $.fs.write(path, text),
    async writePrivateFile(path, text) {
      // umask before the file exists, so it is never readable by anyone else, even briefly.
      const ran = await $.process.run(
        ['/bin/sh', '-c', 'umask 077 && mkdir -p "$(dirname "$1")" && cat > "$1" && chmod 600 "$1"', 'sh', path],
        { stdin: text },
      )
      if (ran.exitCode !== 0) throw new Error(`Could not write ${path}: ${ran.stderr.trim()}`)
    },
    async ensurePrivateDir(path) {
      await $.process.run(['/bin/sh', '-c', 'umask 077 && mkdir -p "$1" && chmod 700 "$1"', 'sh', path])
    },
    cwd,
    homeDir: env.HOME ?? '',
    sessionId,
    sessionPrefix: 'cc',
  }
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

type Input = Record<string, any>

interface StoredRow {
  activity: string
  presentation?: Presentation
  failure?: { reason: string; hint?: string }
  /** When it was written: $.store outlives sessions, so rows past ROW_TTL_MS are pruned. */
  at?: number
}

const ROW_TTL_MS = 30 * 24 * 60 * 60 * 1000

const BASH_DENY = `${PLUGIN}: agent-desktop from Bash runs outside this session's namespace and its output is not kept private. Use the ${PREFIX}desktop_* tools (desktop_snapshot, desktop_click, desktop_command, ...) instead. Version, status, permissions, skills and --help still run from Bash.`

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

// Module state. A hot reload starts it over; the desktop state itself is reloaded from
// $.store, so only the in-flight trail and the snapshot cache are lost.
let state: DesktopState | undefined
let storeKey = ''
const trail = new TrailModel()
let trailTimer: { cancel(): void } | undefined
let lastChip: string | undefined | null = null

// Every snapshot is saved to a file, so the newest one names what a ref points at.
let snapshotCache: { file: string; text: string } | undefined

async function latestSnapshot($: $): Promise<string | undefined> {
  const file = state?.lastSnapshotFile
  if (!file) return undefined
  if (snapshotCache?.file !== file) {
    const text = await $.fs.read(file).catch(() => undefined)
    if (text === undefined) return undefined
    snapshotCache = { file, text }
  }
  return snapshotCache.text
}

async function ready($: $): Promise<DesktopState> {
  if (state) return state
  // Each name is spelled out: the engine lists the variables a mod reads.
  const read: Record<string, string | undefined> = {
    TMPDIR: await $.env.get('TMPDIR'),
    HOME: await $.env.get('HOME'),
    DA_DESKTOP_HEADED: await $.env.get('DA_DESKTOP_HEADED'),
    DA_DESKTOP_BIN: await $.env.get('DA_DESKTOP_BIN'),
  }
  for (const [key, value] of Object.entries(read)) if (value !== undefined) env[key] = value
  const [cwd, id] = await Promise.all([$.session.cwd(), $.session.id()])
  storeKey = `state:${id}`
  state = mergeDesktopState(cwd, await $.store.get(storeKey))
  return state
}

async function persist($: $): Promise<void> {
  if (state) await $.store.set(storeKey, serializeDesktopState(state))
}

/**
 * Off the start path, as pi does on start: probe the CLI version and permissions, so state
 * restored from the store is checked rather than assumed, then prune old tool rows.
 */
async function startupChecks($: $): Promise<void> {
  const current = await ready($)
  const probe = await verifyDesktop(await makeHost($), current).catch(() => undefined)
  const warning = probe ? setupWarning(probe) : undefined
  if (warning) $.ui.toast(warning)
  refreshChip($)
  await persist($)
  const now = Date.now()
  for (const key of await $.store.keys()) {
    if (!key.startsWith('row:')) continue
    const row = (await $.store.get(key)) as StoredRow | undefined
    if (!row?.at || now - row.at > ROW_TTL_MS) await $.store.delete(key)
  }
}

/** The status line says which app the agent is in, in plain words; hidden with nothing to say. */
function refreshChip($: $): void {
  if (!state) return
  // Claude Code already labels the line with the plugin's name, so the chip skips its own.
  // The line is plain text: where pi colours the physical-input flag, mark it.
  const plain = { fg: (_color: unknown, text: string) => (text === 'headed' ? `⏺ ${text}` : text) }
  const chip = chipText(plain, state, desktopHealth(state), false) || undefined
  if (chip === lastChip) return
  lastChip = chip
  $.ui.status(chip)
}

/** The band redraws only for the next visible change: a motion frame, the fade, the end. */
function pokeTrail($: $): void {
  $.ui.invalidate('ui.render')
  trailTimer?.cancel()
  const delay = trail.nextDelay()
  if (delay !== undefined) trailTimer = $.clock.after(delay, () => pokeTrail($))
}

function handleFailure(error: unknown): void {
  if (!state) return
  state.lastError = error instanceof Error ? error.message : String(error)
  if (error instanceof DesktopError && error.code === 'APP_NOT_FOUND') state.app = undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await ready($)
    for (const tool of DESKTOP_TOOLS) {
      await $.tool.register({ name: tool.name, description: tool.description, inputSchema: tool.parameters })
    }
    await $.command.register({ name: 'desktop', description: 'da-desktop: status | headed on|off' })
    refreshChip($)
    $.clock.after(0, () => void startupChecks($).catch(() => {}))
    return started
  })

  // A /clear goes on under a new session id with no session.start, so forget this
  // conversation's desktop state and let the next call load the new session's own.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      state = undefined
      snapshotCache = undefined
      lastChip = null
      $.ui.status(undefined)
    }
    return next(e)
  })

  for (const tool of DESKTOP_TOOLS) {
    on('tool.call', { tool: `${PREFIX}${tool.name}` }, async ($, e) => {
      const current = await ready($)
      const host = await makeHost($)
      const { tool: _tool, tool_use_id: id, consent: _consent, agentId: _agentId, ...raw } = e as unknown as Input
      const input = prepareDesktopInput(tool, raw)

      const snapshot = await latestSnapshot($)
      const snapshotFileBefore = current.lastSnapshotFile
      const activity = describeActivity(tool.name, input, ref => (snapshot ? snapshotLabel(snapshot, ref) : undefined))
      trail.begin(id, activity)
      pokeTrail($)
      const startedAt = Date.now()

      try {
        const result = await tool.run(host, current, input)
        const text = [result.summary, result.contentText].filter(Boolean).join('\n\n')
        const presentation = presentResult({
          tool: tool.name,
          params: input,
          text,
          details: { ...result.diagnostics, artifacts: result.artifacts },
          durationMs: Date.now() - startedAt,
          snapshotFiles: [snapshotFileBefore, current.lastSnapshotFile].filter((file): file is string => Boolean(file)),
        })
        // A plugin tool's result is text the model reads; the row's facts live in the store,
        // keyed by the call, so a resumed transcript draws the same row.
        await $.store.set(`row:${id}`, { activity: activity.text, presentation, at: Date.now() })
        trail.end(id, true)
        return { result: text }
      } catch (error) {
        handleFailure(error)
        const message = error instanceof Error ? error.message : String(error)
        await $.store.set(`row:${id}`, { activity: activity.text, failure: explainFailure(message), at: Date.now() })
        trail.end(id, false)
        return { deny: message }
      } finally {
        pokeTrail($)
        refreshChip($)
        await persist($)
      }
    }).catch(($, _e, next) => ({ deny: `${PLUGIN}: ${next.error.message ?? next.error.kind}` }))
  }

  on('command.run', { command: 'desktop' }, async ($, e) => {
    const current = await ready($)
    const host = await makeHost($)
    const [subcommand, value] = e.args.trim().split(/\s+/)
    try {
      if (subcommand === 'status') {
        const probe = await verifyDesktop(host, current).catch(() => undefined)
        return { text: desktopSummary(current, probe) }
      }
      // Physical input moves the real pointer and takes focus. A slash command is typed by
      // the user, never called by the model, which makes this the consent step.
      if (subcommand === 'headed') {
        if (value === 'on' || value === 'off') current.headed = value === 'on'
        else if (value) return { text: USAGE }
        return { text: `Input: ${inputModeLine(current)}` }
      }
      return { text: USAGE }
    } catch (error) {
      handleFailure(error)
      return { text: error instanceof Error ? error.message : String(error) }
    } finally {
      refreshChip($)
      await persist($)
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if (!e.tools.some(name => name.startsWith(PREFIX))) return composed
    return { ...composed, sections: [...composed.sections, { id: `${PLUGIN}:guidelines`, text: GUIDELINES, scope: 'session' as const }] }
  })

  // Raw agent-desktop from Bash runs outside this session's namespace, prints private
  // screen content into the transcript untruncated, and can pass --headed without the
  // user's say-so. Version, status and other informational commands still run.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => (drivesAgentDesktop(e.command) ? { deny: BASH_DENY } : next(e)))
    // A guard that fails refuses, rather than letting an unchecked command through.
    .catch(($, e, next) => (next.called ? next(e) : { deny: `${PLUGIN}: the Bash guard failed, so the command was refused.` }))

  // The band: what the agent is doing on the desktop right now, only during a burst.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const view = trail.view()
    if (!view) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const app = state?.app
    const steps = view.steps.slice(-6)
    return (
      <Box flexDirection="row">
        <Text dimColor> da desktop  </Text>
        {steps.length < view.steps.length ? <Text dimColor>… › </Text> : null}
        {steps.map((step, index) => (
          <Text
            key={`step-${index}`}
            color={view.draining ? undefined : step.status === 'failed' ? 'error' : step.status === 'running' ? 'claude' : undefined}
            dimColor={view.draining || step.status === 'done'}
          >
            {step.status === 'failed' ? `✗ ${step.text}` : step.status === 'running' ? (step.frameAfter ? `${step.text}${step.frame}` : `${step.frame} ${step.text}`) : step.text}
            {index < steps.length - 1 ? ' › ' : ''}
          </Text>
        ))}
        {app ? <Text dimColor>{`   ${app}`}</Text> : null}
      </Box>
    )
  })

  // Tool rows answer "what did it do, what changed": the call in a few words on the
  // ToolUse row, then only new facts on the ToolResult row. The raw output (snapshots,
  // clipboard text) goes to the model, never the transcript.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const tool = String(e.props.tool)
    if (!tool.startsWith(PREFIX)) return next(e)
    const { Text } = $.ui.resolve(e)
    const row = (await $.store.get(`row:${e.requestId}`)) as StoredRow | undefined
    const callText = row?.activity ?? describeActivity(tool.slice(PREFIX.length), e.props.input as Input).text
    return (
      <Text>
        <Text bold>desktop</Text> {callText}
      </Text>
    )
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const tool = String(e.props.tool)
    if (!tool.startsWith(PREFIX)) return next(e)
    const { Box, Text, Link } = $.ui.resolve(e)
    const row = (await $.store.get(`row:${e.requestId}`)) as StoredRow | undefined
    if (!row) return next(e)
    if (row.failure) {
      return (
        <Text>
          <Text color="error">  {row.failure.reason}</Text>
          {row.failure.hint ? <Text dimColor>  {row.failure.hint}</Text> : null}
        </Text>
      )
    }
    const presentation = row.presentation
    if (!presentation || presentation.facts.length + presentation.files.length === 0) return <Box />
    const tone = (fact: Fact) => (fact.tone === 'success' || fact.tone === 'error' || fact.tone === 'warning' ? fact.tone : undefined)
    const line = (
      <Text>
        {'  '}
        {presentation.facts.map((fact, index) => (
          <Text key={`fact-${index}`} color={tone(fact)} dimColor={fact.tone === 'dim' || fact.tone === 'muted'}>
            {index > 0 ? '  ' : ''}
            {fact.text}
          </Text>
        ))}
        {presentation.files.map((file, index) => (
          <Text key={`file-${index}`} dimColor>
            {presentation.facts.length + index > 0 ? '  ' : ''}
            <Link href={encodeURI(`file://${file}`)} label={artifactName(file)} />
          </Text>
        ))}
      </Text>
    )
    // Only the terminal draws pictures, and only from a PNG file.
    const image = presentation.image
    if (!image?.endsWith('.png') || e.surface !== 'terminal') return line
    const { Image } = $.ui.resolve(e)
    // ponytail: a fixed box like pi's thumbnail; read the PNG's size if captures look stretched.
    return (
      <Box flexDirection="column">
        {line}
        <Image source={{ file: image, format: 'png' }} columns={36} rows={12} alt={artifactName(image)} />
      </Box>
    )
  })
}
