import {
  buildActArgs,
  buildAppArgs,
  buildClickArgs,
  buildClipboardArgs,
  buildFindArgs,
  buildGetArgs,
  buildInvocationArgs,
  buildIsArgs,
  buildListArgs,
  buildPressArgs,
  buildScreenshotArgs,
  buildScrollArgs,
  buildSelectArgs,
  buildSnapshotArgs,
  buildTypeArgs,
  buildWaitArgs,
  buildWindowArgs,
  commandOf,
  desktopSessionName,
  normalizeCommandArgs,
  normalizeRef,
  type ActAction,
  type AppArgsOptions,
  type ClickKind,
  type FindArgsOptions,
  type InvocationFlags,
  type ListKind,
  type ScrollDirection,
  type SnapshotArgsOptions,
  type TypeArgsOptions,
  type WaitArgsOptions,
  type WindowArgsOptions,
} from "./agent-desktop-args.ts";
import {
  autoRetryDelayMs,
  deliveryWords,
  DesktopError,
  formatApps,
  formatDisplays,
  formatFind,
  formatSnapshot,
  formatSurfaces,
  formatValue,
  formatWindows,
  isPlainObject,
  parseEnvelope,
  readAction,
  readIsResult,
  readPermissions,
  type ActionInfo,
  type SnapshotInfo,
} from "./agent-desktop-output.ts";
import {
  extractAgentDesktopVersion,
  MIN_AGENT_DESKTOP_VERSION,
  supportsAgentDesktopVersion,
} from "./agent-desktop-version.ts";
import type { DesktopHost, ExecResult } from "./host.ts";
import { join } from "./paths.ts";
import { resolveAgentDesktopBin, sanitizeArtifactLabel, type DesktopProbe, type DesktopState } from "./state.ts";
import { formatToolText } from "./tool-output.ts";

export { DesktopError } from "./agent-desktop-output.ts";

export interface DesktopActionResult {
  summary: string;
  contentText?: string;
  artifacts?: string[];
  diagnostics?: Record<string, unknown>;
}

const INSTALL_HINT = "Install it with `npm i -g agent-desktop@latest`.";
const PRIVATE_NOTE = "It can hold private screen content: keep it out of anything shared.";

/** What every ref action and snapshot may ask for on top of its own arguments. */
export interface ActionOptions {
  /** Use physical input for this call. Refused unless the user has allowed it. */
  headed?: boolean;
  /** `role:text` selector to wait for after the action; the result then carries a fresh snapshot. */
  waitFor?: string;
  waitForGone?: string;
  waitTimeoutMs?: number;
  timeoutMs?: number;
}

/**
 * Physical input moves the real pointer and takes focus from the person at the machine.
 * agent-desktop's own guidance is never to switch it on to get past an error, so a tool
 * cannot: the user allows it for the session, and only then does headed=true add --headed.
 */
export function resolveHeaded(state: DesktopState, requested: unknown): boolean {
  if (requested !== true) return false;
  if (state.headed) return true;
  throw new Error(
    "Physical input (headed) is off for this session. It moves the real pointer and takes focus, so only the user can allow it: /desktop headed on, or DA_DESKTOP_HEADED=1. Use an accessibility action instead, or ask the user; do not work around this.",
  );
}

function flagsOf(state: DesktopState, options: ActionOptions = {}): InvocationFlags {
  return {
    headed: resolveHeaded(state, options.headed),
    waitFor: options.waitFor,
    waitForGone: options.waitForGone,
    waitTimeoutMs: options.waitTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Running the CLI
// ---------------------------------------------------------------------------

interface RunOptions {
  timeout: number;
  stdin?: string;
  flags?: InvocationFlags;
}

function formatExecFailure(args: string[], result: ExecResult): string {
  const details = [`Command failed: agent-desktop ${args.join(" ")}`, `Exit code: ${result.code}`];
  if (result.killed) details.push("Process was killed (timed out, cancelled, or could not start).");
  if (result.stdout.trim()) details.push(`stdout:\n${result.stdout.trim().slice(0, 2000)}`);
  if (result.stderr.trim()) details.push(`stderr:\n${result.stderr.trim().slice(0, 2000)}`);
  return details.join("\n");
}

/**
 * Runs one agent-desktop command in this host session's namespace and returns `data`.
 * A failure is read from the JSON envelope, never the exit code alone, and is retried once
 * only when the CLI's own disposition says the retry is safe (see autoRetryDelayMs).
 */
async function runAgentDesktop(host: DesktopHost, state: DesktopState, args: string[], options: RunOptions): Promise<unknown> {
  const fullArgs = buildInvocationArgs(args, host.sessionId, host.sessionPrefix, options.flags);
  const exec = () => host.exec(resolveAgentDesktopBin(), fullArgs, { timeout: options.timeout, stdin: options.stdin });

  let result = await exec();
  let envelope = parseEnvelope(result.stdout);
  const delay = envelope ? autoRetryDelayMs(envelope) : undefined;
  if (delay !== undefined) {
    // The core has no timers of its own (the Claude Code mod runs without Node), so the CLI sleeps.
    if (delay > 0) await host.exec(resolveAgentDesktopBin(), ["wait", String(delay)], { timeout: delay + 10_000 });
    result = await exec();
    envelope = parseEnvelope(result.stdout);
  }

  if (!envelope) throw new Error(formatExecFailure(fullArgs, result));
  if (!envelope.ok) {
    // A screenshot is refused for Screen Recording; every other refusal is Accessibility.
    if (envelope.error.code === "PERM_DENIED") {
      const key = envelope.command === "screenshot" ? "screenRecording" : "accessibility";
      state.permissions = { ...state.permissions, [key]: "denied" };
    }
    throw new DesktopError(envelope.command, envelope.error);
  }
  state.lastVerifiedAt = Date.now();
  return envelope.data;
}

interface VersionProbe {
  installed?: string;
  compatible: boolean;
  required: string;
}

async function probeAgentDesktopVersion(host: DesktopHost, state: DesktopState): Promise<VersionProbe> {
  let installed: string | undefined;
  try {
    const result = await host.exec(resolveAgentDesktopBin(), ["--version"], { timeout: 5_000 });
    if (result.code === 0) installed = extractAgentDesktopVersion([result.stdout, result.stderr].filter(Boolean).join("\n"));
  } catch {
    // Status must remain usable when the executable is missing or cannot spawn.
  }
  const compatible = installed !== undefined && supportsAgentDesktopVersion(installed);
  state.agentDesktopVersion = installed;
  state.agentDesktopCompatible = compatible;
  return { installed, compatible, required: MIN_AGENT_DESKTOP_VERSION };
}

async function ensureReady(host: DesktopHost, state: DesktopState): Promise<void> {
  await host.ensurePrivateDir(state.artifactDir);
  const probe = await probeAgentDesktopVersion(host, state);
  if (!probe.installed) {
    throw new Error(`agent-desktop CLI not found or returned an unreadable version. ${INSTALL_HINT}`);
  }
  if (!probe.compatible) {
    throw new Error(`da-desktop requires agent-desktop >=${probe.required}; found ${probe.installed}. Upgrade with \`npm i -g agent-desktop@latest\`.`);
  }
}

/**
 * Asks the CLI for its version and `status`, which needs no permission, so a session start
 * can say what is missing before the first tool call fails on it.
 */
export async function verifyDesktop(host: DesktopHost, state: DesktopState): Promise<DesktopProbe> {
  const version = await probeAgentDesktopVersion(host, state);
  const probe: DesktopProbe = {
    agentDesktopVersion: version.installed,
    agentDesktopCompatible: version.compatible,
    requiredAgentDesktopVersion: version.required,
    agentDesktopSession: desktopSessionName(host.sessionId, host.sessionPrefix),
  };
  if (!version.compatible) return probe;

  try {
    const data = await runAgentDesktop(host, state, ["status"], { timeout: 15_000 });
    if (isPlainObject(data)) {
      probe.platform = typeof data.platform === "string" ? data.platform : undefined;
      probe.permissions = readPermissions(data);
      probe.stateRoot = typeof data.state_root === "string" ? data.state_root : undefined;
      probe.supportedSurfaces = Array.isArray(data.supported_surfaces)
        ? data.supported_surfaces.filter((surface): surface is string => typeof surface === "string")
        : undefined;
      state.platform = probe.platform ?? state.platform;
      state.permissions = probe.permissions ?? state.permissions;
    }
  } catch (error) {
    probe.statusError = error instanceof Error ? error.message : String(error);
  }
  return probe;
}

/** What a session start should tell the user, or undefined when everything is in place. */
export function setupWarning(probe: DesktopProbe): string | undefined {
  if (!probe.agentDesktopCompatible) {
    return `da-desktop requires agent-desktop >=${probe.requiredAgentDesktopVersion}; found ${probe.agentDesktopVersion ?? "not found"}. Run: npm i -g agent-desktop@latest`;
  }
  if (probe.permissions?.accessibility === "denied") {
    // Only macOS has the guided grant; elsewhere the plain command explains what is missing.
    const fix = probe.platform === "macos" ? "agent-desktop permissions --guide" : "agent-desktop permissions";
    return `da-desktop: Accessibility is denied, so apps cannot be read. Run: ${fix}`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

function artifactPath(state: DesktopState, label: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return join(state.artifactDir, `${timestamp}-${sanitizeArtifactLabel(label)}.${extension}`);
}

async function truncateForTool(host: DesktopHost, content: string, fullOutputFile?: string): Promise<string> {
  return (await formatToolText(host, content, { label: "desktop-output", mode: "head", fullOutputFile })).text;
}

/**
 * Saves a snapshot's text next to the session's other artifacts, readable only by the
 * user. The newest file names what a ref points at, so a click reads `click "Save"`.
 */
async function recordSnapshot(host: DesktopHost, state: DesktopState, snapshot: SnapshotInfo, label: string): Promise<string> {
  const file = artifactPath(state, label, "txt");
  await host.writePrivateFile(file, snapshot.text);
  state.lastSnapshotFile = file;
  state.lastSnapshotAt = Date.now();
  state.lastSnapshotId = snapshot.snapshotId ?? state.lastSnapshotId;
  state.app = snapshot.app ?? state.app;
  return file;
}

// ---------------------------------------------------------------------------
// Observe
// ---------------------------------------------------------------------------

export async function snapshotDesktop(
  host: DesktopHost,
  state: DesktopState,
  options: SnapshotArgsOptions & { label?: string; waitFor?: string; waitForGone?: string; waitTimeoutMs?: number },
): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const args = buildSnapshotArgs(options);
  const waiting = options.waitFor || options.waitForGone ? (options.waitTimeoutMs ?? 30_000) : 0;
  const data = await runAgentDesktop(host, state, args, {
    timeout: (options.timeoutMs ?? 3_000) + waiting + 30_000,
    flags: { waitFor: options.waitFor, waitForGone: options.waitForGone, waitTimeoutMs: options.waitTimeoutMs },
  });
  const snapshot = formatSnapshot(data);
  if (!snapshot) throw new Error(`agent-desktop snapshot returned no tree: ${JSON.stringify(data).slice(0, 200)}`);

  const file = await recordSnapshot(host, state, snapshot, options.label ?? "snapshot");
  state.lastAction = "snapshot";
  state.lastError = undefined;
  const incomplete = snapshot.complete === false ? " The read was incomplete: absence of an element proves nothing." : "";
  return {
    summary: `Snapshot of ${snapshot.app ?? "the focused app"}: ${snapshot.refCount ?? 0} ref${snapshot.refCount === 1 ? "" : "s"} (snapshot ${snapshot.snapshotId ?? "?"}).${incomplete}`,
    contentText: await truncateForTool(host, snapshot.text, file),
    diagnostics: {
      snapshotFile: file,
      snapshotId: snapshot.snapshotId,
      refCount: snapshot.refCount,
      complete: snapshot.complete,
      app: snapshot.app,
    },
  };
}

export async function findDesktopElements(host: DesktopHost, state: DesktopState, options: FindArgsOptions): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildFindArgs(options), { timeout: (options.timeoutMs ?? 5_000) + 30_000 });
  const found = formatFind(data);
  if (options.app) state.app = options.app;
  state.lastSnapshotId = found.snapshotId ?? state.lastSnapshotId;
  state.lastAction = "find";
  state.lastError = undefined;

  const more = found.truncated ? ` Showing ${found.shown}; raise limit or narrow the query for the rest.` : "";
  const summary =
    options.pick === "count"
      ? `${found.total} matching element${found.total === 1 ? "" : "s"}.`
      : found.total === 0
        ? "No element matched."
        : `Found ${found.total} element${found.total === 1 ? "" : "s"}.${more}`;
  return {
    summary,
    contentText: options.pick === "count" ? undefined : await truncateForTool(host, found.text),
    diagnostics: { totalMatches: found.total, shownMatches: found.shown, snapshotId: found.snapshotId },
  };
}

export async function getDesktopProperty(host: DesktopHost, state: DesktopState, ref: string, property = "text"): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildGetArgs(ref, property), { timeout: 30_000 });
  const value = isPlainObject(data) ? data.value : data;
  state.lastAction = `get ${property}`;
  state.lastError = undefined;
  return {
    summary: `${property} of ${normalizeRef(ref)}:`,
    contentText: await truncateForTool(host, formatValue(value)),
    diagnostics: { property, value },
  };
}

export async function isDesktopState(host: DesktopHost, state: DesktopState, ref: string, property = "visible"): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildIsArgs(ref, property), { timeout: 30_000 });
  const { result, applicable } = readIsResult(data);
  state.lastAction = `is ${property}`;
  state.lastError = undefined;
  const note = applicable ? "" : ` (${property} does not apply to this element)`;
  return {
    summary: `${normalizeRef(ref)} ${property}: ${result}${note}`,
    diagnostics: { property, result, applicable },
  };
}

export async function screenshotDesktop(
  host: DesktopHost,
  state: DesktopState,
  options: { app?: string; windowId?: string; screen?: number; label?: string },
): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const file = artifactPath(state, options.label ?? "screenshot", "png");
  const data = await runAgentDesktop(host, state, buildScreenshotArgs({ ...options, file }), { timeout: 60_000 });
  const saved = isPlainObject(data) && typeof data.path === "string" ? data.path : file;
  const size = isPlainObject(data) && typeof data.width === "number" && typeof data.height === "number" ? ` (${data.width}x${data.height})` : "";
  if (options.app) state.app = options.app;
  state.lastScreenshotFile = saved;
  state.lastAction = "screenshot";
  state.lastError = undefined;
  return {
    summary: `Saved screenshot${size} to ${saved}. ${PRIVATE_NOTE}`,
    artifacts: [saved],
    diagnostics: { screenshotFile: saved },
  };
}

export async function listDesktop(host: DesktopHost, state: DesktopState, what: ListKind, app?: string): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildListArgs(what, app), { timeout: 30_000 });
  const formatted =
    what === "apps" ? formatApps(data) : what === "windows" ? formatWindows(data) : what === "displays" ? formatDisplays(data) : formatSurfaces(data);
  state.lastAction = `list ${what}`;
  state.lastError = undefined;
  const noun = `${what === "apps" ? "foreground " : ""}${formatted.count === 1 ? what.slice(0, -1) : what}`;
  return {
    summary: `${formatted.count} ${noun}${app ? ` for ${app}` : ""}.`,
    contentText: await truncateForTool(host, formatted.text),
    diagnostics: { count: formatted.count, what },
  };
}

// ---------------------------------------------------------------------------
// Act
// ---------------------------------------------------------------------------

/**
 * Turns an action's envelope into a result. The summary always says how the input was
 * delivered: a success that was not verified is a reason to look again, not a fact.
 */
async function actionResult(
  host: DesktopHost,
  state: DesktopState,
  verb: string,
  data: unknown,
  label: string,
): Promise<DesktopActionResult> {
  const action: ActionInfo = readAction(data);
  let contentText: string | undefined;
  let snapshotFile: string | undefined;
  if (action.snapshot) {
    snapshotFile = await recordSnapshot(host, state, action.snapshot, label);
    contentText = await truncateForTool(host, action.snapshot.text, snapshotFile);
  }
  state.lastError = undefined;
  const delivery = action.disposition ? ` (${deliveryWords(action.disposition)})` : "";
  const verify =
    action.disposition?.delivery === "delivered_unverified" && !action.snapshot ? " Observe again to confirm the effect." : "";
  const waited = action.snapshot?.matchedSelector ? ` Waited for ${action.snapshot.matchedSelector}.` : "";
  return {
    summary: `${verb}${delivery}.${waited}${verify}`,
    contentText,
    diagnostics: {
      delivery: action.disposition?.delivery,
      retry: action.disposition?.retry,
      mechanism: action.mechanism,
      ...(action.snapshot
        ? { snapshotFile, snapshotId: action.snapshot.snapshotId, refCount: action.snapshot.refCount, app: action.snapshot.app }
        : {}),
    },
  };
}

function actionTimeout(options: ActionOptions, base = 5_000): number {
  const waiting = options.waitFor || options.waitForGone ? (options.waitTimeoutMs ?? 30_000) : 0;
  return (options.timeoutMs ?? base) + waiting + 30_000;
}

export async function clickDesktopElement(
  host: DesktopHost,
  state: DesktopState,
  ref: string,
  kind: ClickKind = "click",
  options: ActionOptions = {},
): Promise<DesktopActionResult> {
  const flags = flagsOf(state, options);
  await ensureReady(host, state);
  const args = buildClickArgs(ref, kind, options.timeoutMs);
  const data = await runAgentDesktop(host, state, args, { timeout: actionTimeout(options), flags });
  state.lastAction = args[0]!;
  return actionResult(host, state, `Sent ${args[0]} to ${normalizeRef(ref)}`, data, `after-${args[0]}`);
}

export async function typeIntoDesktopElement(
  host: DesktopHost,
  state: DesktopState,
  input: TypeArgsOptions,
  options: ActionOptions = {},
): Promise<DesktopActionResult> {
  const flags = flagsOf(state, options);
  await ensureReady(host, state);
  const { args, stdin } = buildTypeArgs({ ...input, timeoutMs: options.timeoutMs });
  // Typing keystroke by keystroke takes as long as the text does.
  const typing = input.intervalMs ? input.intervalMs * [...input.text].length : 30 * input.text.length;
  const data = await runAgentDesktop(host, state, args, { timeout: actionTimeout(options) + typing, stdin, flags });
  state.lastAction = args[0]!;
  const verb = input.mode === "set" ? "Set the value of" : "Typed into";
  return actionResult(host, state, `${verb} ${normalizeRef(input.ref)}`, data, `after-${args[0]}`);
}

export async function selectDesktopOption(
  host: DesktopHost,
  state: DesktopState,
  ref: string,
  option: string,
  options: ActionOptions = {},
): Promise<DesktopActionResult> {
  const flags = flagsOf(state, options);
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildSelectArgs(ref, option, options.timeoutMs), { timeout: actionTimeout(options), flags });
  state.lastAction = "select";
  return actionResult(host, state, `Selected ${JSON.stringify(option)} on ${normalizeRef(ref)}`, data, "after-select");
}

export async function actOnDesktopElement(
  host: DesktopHost,
  state: DesktopState,
  ref: string,
  action: ActAction,
  options: ActionOptions = {},
): Promise<DesktopActionResult> {
  const flags = flagsOf(state, options);
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildActArgs(ref, action, options.timeoutMs), { timeout: actionTimeout(options), flags });
  state.lastAction = action;
  return actionResult(host, state, `Sent ${action} to ${normalizeRef(ref)}`, data, `after-${action}`);
}

export async function scrollDesktopElement(
  host: DesktopHost,
  state: DesktopState,
  ref: string,
  direction: ScrollDirection,
  amount?: number,
  options: ActionOptions = {},
): Promise<DesktopActionResult> {
  const flags = flagsOf(state, options);
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildScrollArgs(ref, direction, amount, options.timeoutMs), { timeout: actionTimeout(options), flags });
  state.lastAction = `scroll ${direction}`;
  return actionResult(host, state, `Scrolled ${normalizeRef(ref)} ${direction}`, data, "after-scroll");
}

export async function pressDesktopKey(
  host: DesktopHost,
  state: DesktopState,
  input: { combo: string; app?: string; windowId?: string; headed?: boolean },
): Promise<DesktopActionResult> {
  // Without a target the keys go to whatever window the user is typing in right now.
  if (!input.app && !input.windowId) {
    throw new Error("desktop_press needs app or windowId, so the keys go to that app and not to whatever the user has focused.");
  }
  const flags = flagsOf(state, { headed: input.headed });
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildPressArgs(input), { timeout: 30_000, flags });
  if (input.app) state.app = input.app;
  state.lastAction = `press ${input.combo}`;
  return actionResult(host, state, `Pressed ${input.combo}`, data, "after-press");
}

export async function waitOnDesktop(host: DesktopHost, state: DesktopState, input: WaitArgsOptions): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const args = buildWaitArgs(input);
  const budget = input.ms != null ? input.ms : (input.timeoutMs ?? 30_000);
  const data = await runAgentDesktop(host, state, args, { timeout: budget + 15_000 });
  state.lastAction = "wait";
  state.lastError = undefined;
  const payload = isPlainObject(data) ? data : {};
  const waited = typeof payload.waited_ms === "number" ? payload.waited_ms : typeof payload.elapsed_ms === "number" ? payload.elapsed_ms : undefined;
  const { waited_ms: _waited, elapsed_ms: _elapsed, ...rest } = payload;
  return {
    summary: `Wait finished${waited !== undefined ? ` after ${waited}ms` : ""}.`,
    contentText: Object.keys(rest).length ? await truncateForTool(host, JSON.stringify(rest, null, 2)) : undefined,
    diagnostics: { waitedMs: waited },
  };
}

// ---------------------------------------------------------------------------
// Apps, windows, clipboard
// ---------------------------------------------------------------------------

function windowLine(window: unknown): string {
  if (!isPlainObject(window)) return "";
  const id = typeof window.id === "string" ? window.id : "";
  const title = typeof window.title === "string" && window.title ? ` "${window.title}"` : "";
  return id ? `window ${id}${title}` : "";
}

export async function appDesktop(host: DesktopHost, state: DesktopState, input: AppArgsOptions & { headed?: boolean }): Promise<DesktopActionResult> {
  const flags = flagsOf(state, { headed: input.headed });
  await ensureReady(host, state);
  const args = buildAppArgs(input);
  const data = await runAgentDesktop(host, state, args, { timeout: (input.timeoutMs ?? 30_000) + 15_000, flags });
  state.lastError = undefined;
  if (input.action === "launch") {
    const payload = isPlainObject(data) ? data : {};
    state.app = typeof payload.app === "string" ? payload.app : input.app;
    state.lastAction = `launch ${input.app}`;
    const window = windowLine(payload.window);
    return {
      summary: `${state.app} is running${typeof payload.pid === "number" ? ` (pid ${payload.pid})` : ""}${window ? `, ${window}` : ""}.`,
      diagnostics: { app: state.app, pid: payload.pid, windowId: isPlainObject(payload.window) ? payload.window.id : undefined },
    };
  }
  state.lastAction = `close ${input.app}`;
  if (state.app === input.app) state.app = undefined;
  return actionResult(host, state, `${input.force ? "Terminated" : "Quit"} ${input.app}`, data, "after-close");
}

export async function windowDesktop(host: DesktopHost, state: DesktopState, input: WindowArgsOptions & { headed?: boolean }): Promise<DesktopActionResult> {
  const flags = flagsOf(state, { headed: input.headed });
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, buildWindowArgs(input), { timeout: 30_000, flags });
  if (input.app) state.app = input.app;
  state.lastAction = `${input.action} window`;
  const target = input.windowId ?? input.app ?? input.title ?? "window";
  const verb = { focus: "Focused", resize: "Resized", move: "Moved", minimize: "Minimized", maximize: "Maximized", restore: "Restored" }[input.action];
  return actionResult(host, state, `${verb} ${target}`, data, `after-${input.action}-window`);
}

export async function clipboardDesktop(
  host: DesktopHost,
  state: DesktopState,
  input: { action: "get" | "set" | "clear"; text?: string; format?: string },
): Promise<DesktopActionResult> {
  await ensureReady(host, state);
  const wantsImage = input.action === "get" && (input.format === "image" || input.format === "auto");
  const { args, stdin } = buildClipboardArgs({ ...input, out: wantsImage ? artifactPath(state, "clipboard", "png") : undefined });
  const data = await runAgentDesktop(host, state, args, { timeout: 30_000, stdin });
  state.lastAction = `clipboard ${input.action}`;
  state.lastError = undefined;
  if (input.action === "set") return { summary: `Wrote ${[...(input.text ?? "")].length} characters to the clipboard.`, diagnostics: { action: "set" } };
  if (input.action === "clear") return { summary: "Cleared the clipboard.", diagnostics: { action: "clear" } };

  const payload = isPlainObject(data) ? data : {};
  const type = typeof payload.type === "string" ? payload.type : "text";
  if (payload.found === false) return { summary: `The clipboard holds no ${type}.`, diagnostics: { action: "get", type, found: false } };
  const caution = "Clipboard contents can be private: use them for the task and do not repeat them elsewhere.";
  if (typeof payload.path === "string") {
    return {
      summary: `Clipboard image saved to ${payload.path}. ${caution}`,
      artifacts: [payload.path],
      diagnostics: { action: "get", type, clipboardFile: payload.path },
    };
  }
  const text = typeof payload.text === "string" ? payload.text : Array.isArray(payload.file_urls) ? payload.file_urls.join("\n") : JSON.stringify(payload, null, 2);
  return {
    summary: `Clipboard ${type} (${[...text].length} characters). ${caution}`,
    contentText: await truncateForTool(host, text),
    diagnostics: { action: "get", type, chars: [...text].length },
  };
}

// ---------------------------------------------------------------------------
// Passthrough
// ---------------------------------------------------------------------------

function clampTimeout(timeoutMs: number | undefined): number {
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs)) return 60_000;
  return Math.min(Math.max(Math.round(timeoutMs), 1_000), 300_000);
}

/** Any agent-desktop command the typed tools do not cover, still in this session's namespace. */
export async function runDesktopCommand(
  host: DesktopHost,
  state: DesktopState,
  input: { args: string[]; stdin?: string; headed?: boolean; timeoutMs?: number; label?: string },
): Promise<DesktopActionResult> {
  const args = normalizeCommandArgs(input.args);
  const flags = flagsOf(state, { headed: input.headed });
  await ensureReady(host, state);
  const data = await runAgentDesktop(host, state, args, { timeout: clampTimeout(input.timeoutMs), stdin: input.stdin, flags });
  const command = commandOf(args) ?? args[0]!;
  state.lastAction = command;
  state.lastError = undefined;

  // Snapshot-shaped output reads far better as a tree, and its refs then resolve to names.
  const snapshot = formatSnapshot(data);
  if (snapshot) {
    const file = await recordSnapshot(host, state, snapshot, input.label ?? command);
    return {
      summary: `agent-desktop ${command} completed.`,
      contentText: await truncateForTool(host, snapshot.text, file),
      diagnostics: { command, snapshotFile: file, snapshotId: snapshot.snapshotId, refCount: snapshot.refCount },
    };
  }
  const text = data === undefined || data === null ? "" : JSON.stringify(data, null, 2);
  const disposition = readAction(data).disposition;
  return {
    summary: `agent-desktop ${command} completed${disposition ? ` (${deliveryWords(disposition)})` : ""}.`,
    contentText: text ? await truncateForTool(host, text) : undefined,
    diagnostics: { command, delivery: disposition?.delivery, retry: disposition?.retry },
  };
}
