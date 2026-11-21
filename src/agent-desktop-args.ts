// Pure argument builders for the agent-desktop CLI. No I/O or framework deps, so they stay
// unit-testable as Light Guard Tests. Flags were checked against agent-desktop 1.3.1
// (`agent-desktop <command> --help`); see docs/agent-desktop-v1.3.1.md.

import { sha256Hex } from "./sha256.ts";

/**
 * The session namespace for one host session. agent-desktop confines every snapshot lookup
 * to the selected namespace, so refs one session captured are SNAPSHOT_NOT_FOUND in another.
 */
export function desktopSessionName(sessionId: string, prefix = "pi"): string {
  return `${prefix}-${sha256Hex(sessionId).slice(0, 16)}`;
}

export interface InvocationFlags {
  /** Allow physical input and focus changes for this command. The caller checks consent. */
  headed?: boolean;
  /** `role:text` selector to poll for after a snapshot or ref action. */
  waitFor?: string;
  waitForGone?: string;
  waitTimeoutMs?: number;
}

/** Global flags first, then the command: every call runs in this host session's namespace. */
export function buildInvocationArgs(
  args: string[],
  sessionId: string,
  prefix = "pi",
  flags: InvocationFlags = {},
): string[] {
  if (flags.waitFor && flags.waitForGone) {
    throw new Error("Pass waitFor or waitForGone, not both.");
  }
  const globals = ["--session", desktopSessionName(sessionId, prefix)];
  if (flags.headed) globals.push("--headed");
  if (flags.waitFor) globals.push("--wait-for", flags.waitFor);
  if (flags.waitForGone) globals.push("--wait-for-gone", flags.waitForGone);
  if (flags.waitTimeoutMs != null && (flags.waitFor || flags.waitForGone)) {
    globals.push("--wait-timeout", String(flags.waitTimeoutMs));
  }
  return [...globals, ...args];
}

const QUALIFIED_REF = /^@[A-Za-z0-9]+:e\d+$/;

/**
 * Refs are scoped to their snapshot: `@<snapshot_id>:eN`. A bare `@e8` is refused here
 * with the fix, rather than qualified with the newest snapshot: that guess could land a
 * click on whatever element now holds that number.
 */
export function normalizeRef(ref: unknown): string {
  const trimmed = typeof ref === "string" ? ref.trim() : "";
  const candidate = trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
  if (QUALIFIED_REF.test(candidate)) return candidate;
  throw new Error(
    `Invalid ref ${JSON.stringify(ref)}: desktop refs are snapshot-qualified, like @s8f3k2p9:e8. Copy the ref exactly as desktop_snapshot or desktop_find printed it; a bare @eN is not accepted.`,
  );
}

export const SURFACES = [
  "window", "focused", "menu", "menubar", "sheet", "popover", "alert", "desktop", "taskbar", "system-tray",
  "quick-settings", "notification-center", "toolbar", "dock", "spotlight", "menu-bar-extras",
  "system-tray-overflow", "start-menu", "action-center",
] as const;

function pushTarget(args: string[], opts: { app?: string; windowId?: string }): void {
  if (opts.app) args.push("--app", opts.app);
  if (opts.windowId) args.push("--window-id", opts.windowId);
}

function positiveInt(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer (got ${value}).`);
  return value;
}

export interface SnapshotArgsOptions {
  app?: string;
  windowId?: string;
  interactiveOnly?: boolean;
  compact?: boolean;
  /** Shallow overview with children_count on truncated containers; drill in with root. */
  skeleton?: boolean;
  /** Start from this ref instead of the window root. */
  root?: string;
  surface?: string;
  maxDepth?: number;
  includeBounds?: boolean;
  timeoutMs?: number;
}

export function buildSnapshotArgs(opts: SnapshotArgsOptions): string[] {
  const args = ["snapshot"];
  pushTarget(args, opts);
  if (opts.interactiveOnly) args.push("-i");
  if (opts.compact) args.push("--compact");
  if (opts.skeleton) args.push("--skeleton");
  if (opts.root) args.push("--root", normalizeRef(opts.root));
  if (opts.surface) args.push("--surface", opts.surface);
  if (opts.maxDepth != null) args.push("--max-depth", String(positiveInt(opts.maxDepth, "maxDepth")));
  if (opts.includeBounds) args.push("--include-bounds");
  if (opts.timeoutMs != null) args.push("--timeout-ms", String(positiveInt(opts.timeoutMs, "timeoutMs")));
  return args;
}

export interface FindArgsOptions {
  app?: string;
  windowId?: string;
  role?: string;
  name?: string;
  text?: string;
  value?: string;
  description?: string;
  nativeId?: string;
  exact?: boolean;
  root?: string;
  surface?: string;
  /** State tokens, optionally `token=false`, e.g. `enabled` or `offscreen=false`. */
  states?: string[];
  pick?: "first" | "last" | "count";
  nth?: number;
  limit?: number;
  timeoutMs?: number;
}

export function buildFindArgs(opts: FindArgsOptions): string[] {
  const criteria = [opts.role, opts.name, opts.text, opts.value, opts.description, opts.nativeId, ...(opts.states ?? [])];
  if (!criteria.some(Boolean)) {
    throw new Error("desktop_find needs at least one of role, name, text, value, description, nativeId or states.");
  }
  if (opts.nth != null && opts.pick) throw new Error("desktop_find takes nth or pick, not both.");
  const args = ["find"];
  pushTarget(args, opts);
  if (opts.role) args.push("--role", opts.role);
  if (opts.name) args.push("--name", opts.name);
  if (opts.text) args.push("--text", opts.text);
  if (opts.value) args.push("--value", opts.value);
  if (opts.description) args.push("--description", opts.description);
  if (opts.nativeId) args.push("--native-id", opts.nativeId);
  if (opts.exact) args.push("--exact");
  if (opts.root) args.push("--root", normalizeRef(opts.root));
  if (opts.surface) args.push("--surface", opts.surface);
  for (const state of opts.states ?? []) if (state) args.push("--state", state);
  if (opts.pick) args.push(`--${opts.pick}`);
  if (opts.nth != null) args.push("--nth", String(positiveInt(opts.nth, "nth")));
  if (opts.limit != null) args.push("--limit", String(positiveInt(opts.limit, "limit")));
  if (opts.timeoutMs != null) args.push("--timeout-ms", String(positiveInt(opts.timeoutMs, "timeoutMs")));
  return args;
}

export const GET_PROPERTIES = ["text", "value", "title", "bounds", "role", "states"] as const;
export const IS_PROPERTIES = ["visible", "enabled", "checked", "focused", "expanded", "selected"] as const;

export function buildGetArgs(ref: string, property = "text"): string[] {
  if (!(GET_PROPERTIES as readonly string[]).includes(property)) {
    throw new Error(`desktop_get property must be one of ${GET_PROPERTIES.join(", ")} (got ${property}).`);
  }
  return ["get", normalizeRef(ref), "--property", property];
}

export function buildIsArgs(ref: string, property = "visible"): string[] {
  if (!(IS_PROPERTIES as readonly string[]).includes(property)) {
    throw new Error(`desktop_is property must be one of ${IS_PROPERTIES.join(", ")} (got ${property}).`);
  }
  return ["is", normalizeRef(ref), "--property", property];
}

export function buildScreenshotArgs(opts: { file: string; app?: string; windowId?: string; screen?: number }): string[] {
  if (opts.screen != null && (opts.app || opts.windowId)) {
    throw new Error("desktop_screenshot takes screen or app/windowId, not both.");
  }
  const args = ["screenshot"];
  pushTarget(args, opts);
  if (opts.screen != null) args.push("--screen", String(positiveInt(opts.screen, "screen")));
  args.push(opts.file);
  return args;
}

export const CLICK_KINDS = { click: "click", double: "double-click", triple: "triple-click", right: "right-click" } as const;
export type ClickKind = keyof typeof CLICK_KINDS;

function pushTimeout(args: string[], timeoutMs?: number): string[] {
  if (timeoutMs != null) args.push("--timeout-ms", String(positiveInt(timeoutMs, "timeoutMs")));
  return args;
}

export function buildClickArgs(ref: string, kind: ClickKind = "click", timeoutMs?: number): string[] {
  const command = CLICK_KINDS[kind];
  if (!command) throw new Error(`desktop_click kind must be one of ${Object.keys(CLICK_KINDS).join(", ")} (got ${kind}).`);
  return pushTimeout([command, normalizeRef(ref)], timeoutMs);
}

const encoder = new TextEncoder();
/** agent-desktop's --stdin limits: `type` reads 10,000 bytes, `set-value` and clipboard 128 KiB. */
export const TYPE_STDIN_BYTES = 10_000;
export const VALUE_STDIN_BYTES = 128 * 1024;

function assertStdinSize(text: string, limit: number, hint: string): void {
  const bytes = encoder.encode(text).length;
  if (bytes > limit) throw new Error(`Text is ${bytes} bytes; agent-desktop reads at most ${limit} here. ${hint}`);
}

export interface StdinCommand {
  args: string[];
  /** Piped to the command, never placed in argv, where other processes could read it. */
  stdin: string;
}

export interface TypeArgsOptions {
  ref: string;
  text: string;
  /** type inserts at the caret like a person; set replaces the whole value through accessibility. */
  mode?: "type" | "set";
  /** One keystroke every N ms (1-2000) instead of inserting at once. type mode only. */
  intervalMs?: number;
  timeoutMs?: number;
}

export function buildTypeArgs(opts: TypeArgsOptions): StdinCommand {
  if (typeof opts.text !== "string") throw new Error("desktop_type requires text.");
  const ref = normalizeRef(opts.ref);
  if (opts.mode === "set") {
    if (opts.intervalMs != null) throw new Error("intervalMs only applies to mode type.");
    assertStdinSize(opts.text, VALUE_STDIN_BYTES, "Split the text across calls.");
    return { args: pushTimeout(["set-value", ref, "--stdin"], opts.timeoutMs), stdin: opts.text };
  }
  assertStdinSize(opts.text, TYPE_STDIN_BYTES, "Use mode set for long text, or split it across calls.");
  const args = ["type", ref, "--stdin"];
  if (opts.intervalMs != null) {
    if (!Number.isInteger(opts.intervalMs) || opts.intervalMs < 1 || opts.intervalMs > 2000) {
      throw new Error(`intervalMs must be between 1 and 2000 (got ${opts.intervalMs}).`);
    }
    args.push("--interval-ms", String(opts.intervalMs));
  }
  return { args: pushTimeout(args, opts.timeoutMs), stdin: opts.text };
}

export function buildSelectArgs(ref: string, option: string, timeoutMs?: number): string[] {
  if (typeof option !== "string" || !option) throw new Error("desktop_select requires option.");
  return pushTimeout(["select", normalizeRef(ref), option], timeoutMs);
}

/** Ref actions that take nothing but the ref. hover moves the pointer, so it needs headed. */
export const ACT_ACTIONS = ["focus", "clear", "toggle", "check", "uncheck", "expand", "collapse", "scroll-to", "hover"] as const;
export type ActAction = (typeof ACT_ACTIONS)[number];

export function buildActArgs(ref: string, action: ActAction, timeoutMs?: number): string[] {
  if (!ACT_ACTIONS.includes(action)) {
    throw new Error(`desktop_act action must be one of ${ACT_ACTIONS.join(", ")} (got ${String(action)}).`);
  }
  return pushTimeout([action, normalizeRef(ref)], timeoutMs);
}

export type ScrollDirection = "up" | "down" | "left" | "right";

export function buildScrollArgs(ref: string, direction: ScrollDirection, amount?: number, timeoutMs?: number): string[] {
  if (!["up", "down", "left", "right"].includes(direction)) {
    throw new Error(`desktop_scroll direction must be up, down, left or right (got ${String(direction)}).`);
  }
  const args = ["scroll", normalizeRef(ref), "--direction", direction];
  if (amount != null) {
    if (!Number.isInteger(amount) || amount < 1) throw new Error(`amount must be a positive integer (got ${amount}).`);
    args.push("--amount", String(amount));
  }
  return pushTimeout(args, timeoutMs);
}

export function buildPressArgs(opts: { combo: string; app?: string; windowId?: string }): string[] {
  const combo = typeof opts.combo === "string" ? opts.combo.trim() : "";
  if (!combo) throw new Error("desktop_press requires combo, e.g. return, escape or cmd+s.");
  // A combo that starts with a dash would parse as a flag.
  if (combo.startsWith("-")) throw new Error(`Invalid key combo ${JSON.stringify(combo)}.`);
  const args = ["press", combo];
  pushTarget(args, opts);
  return args;
}

export const WAIT_EVENTS = [
  "window-opened", "window-closed", "app-launched", "app-terminated", "focus-changed", "surface-appeared", "surface-dismissed",
] as const;
export const WAIT_PREDICATES = ["exists", "enabled", "visible", "actionable", "value"] as const;

export interface WaitArgsOptions {
  ms?: number;
  /** Ref to wait on, with predicate (default exists). */
  element?: string;
  predicate?: string;
  /** Expected value for predicate value. */
  value?: string;
  /** Action for predicate actionable: click (default), type, set-value or clear. */
  action?: string;
  /** Window title to wait for; with event, narrows the event to that title. */
  window?: string;
  text?: string;
  /** Expected match count for a text wait. */
  count?: number;
  menu?: "open" | "closed";
  notification?: boolean;
  event?: string;
  windowId?: string;
  app?: string;
  timeoutMs?: number;
}

export function buildWaitArgs(opts: WaitArgsOptions): string[] {
  const modes = [
    opts.ms != null ? "ms" : "",
    opts.element ? "element" : "",
    opts.event ? "event" : "",
    opts.menu ? "menu" : "",
    opts.notification ? "notification" : "",
    // window and text select a mode on their own, and narrow an event or notification wait otherwise.
    opts.window && !opts.event ? "window" : "",
    opts.text && !opts.notification ? "text" : "",
  ].filter(Boolean);
  if (modes.length !== 1) {
    throw new Error(
      `desktop_wait needs exactly one of ms, element, window, text, menu, notification or event (got ${modes.length ? modes.join(", ") : "none"}).`,
    );
  }
  const args = ["wait"];
  const mode = modes[0];

  if (mode === "ms") {
    if (!Number.isFinite(opts.ms) || opts.ms! < 0) throw new Error(`ms must be a non-negative number (got ${opts.ms}).`);
    return [...args, String(Math.round(opts.ms!))];
  }
  if (mode === "element") {
    args.push("--element", normalizeRef(opts.element));
    if (opts.predicate) {
      if (!(WAIT_PREDICATES as readonly string[]).includes(opts.predicate)) {
        throw new Error(`predicate must be one of ${WAIT_PREDICATES.join(", ")} (got ${opts.predicate}).`);
      }
      args.push("--predicate", opts.predicate);
    }
    if (opts.predicate === "value") {
      if (opts.value == null) throw new Error("predicate value needs the expected value.");
      args.push("--value", opts.value);
    }
    if (opts.action && opts.predicate === "actionable") args.push("--action", opts.action);
  }
  if (mode === "window") args.push("--window", opts.window!);
  if (mode === "text") {
    args.push("--text", opts.text!);
    if (opts.count != null) args.push("--count", String(positiveInt(opts.count, "count")));
  }
  if (mode === "menu") args.push(opts.menu === "closed" ? "--menu-closed" : "--menu");
  if (mode === "notification") {
    args.push("--notification");
    if (opts.text) args.push("--text", opts.text);
  }
  if (mode === "event") {
    if (!(WAIT_EVENTS as readonly string[]).includes(opts.event!)) {
      throw new Error(`event must be one of ${WAIT_EVENTS.join(", ")} (got ${opts.event}).`);
    }
    args.push("--event", opts.event!);
    if (opts.window) args.push("--window", opts.window);
    if (opts.windowId) args.push("--window-id", opts.windowId);
  }
  if (opts.app) args.push("--app", opts.app);
  if (opts.timeoutMs != null) args.push("--timeout", String(positiveInt(opts.timeoutMs, "timeoutMs")));
  return args;
}

export type AppAction = "launch" | "close";

export interface AppArgsOptions {
  action: AppAction;
  app: string;
  /** Command-line arguments for the launched app, order preserved. */
  args?: string[];
  /** Bring the app forward and wait for a window (launch). */
  activate?: boolean;
  /** Start a fresh instance instead of attaching to a running one (launch). */
  newInstance?: boolean;
  /** Terminate instead of quitting gracefully (close). Unsaved work is lost. */
  force?: boolean;
  timeoutMs?: number;
}

export function buildAppArgs(opts: AppArgsOptions): string[] {
  const app = typeof opts.app === "string" ? opts.app.trim() : "";
  if (!app) throw new Error("desktop_app requires app.");
  if (app.startsWith("-")) throw new Error(`Invalid app name ${JSON.stringify(app)}.`);
  if (opts.action === "launch") {
    const args = ["launch", app];
    // --arg=<value> keeps a value that starts with a dash from parsing as a flag.
    for (const arg of opts.args ?? []) args.push(`--arg=${arg}`);
    if (opts.activate) args.push("--activate");
    if (opts.newInstance) args.push("--no-attach");
    if (opts.timeoutMs != null) args.push("--timeout", String(positiveInt(opts.timeoutMs, "timeoutMs")));
    return args;
  }
  if (opts.action === "close") return opts.force ? ["close-app", app, "--force"] : ["close-app", app];
  throw new Error(`desktop_app action must be launch or close (got ${String(opts.action)}).`);
}

export const WINDOW_ACTIONS = ["focus", "resize", "move", "minimize", "maximize", "restore"] as const;
export type WindowAction = (typeof WINDOW_ACTIONS)[number];

export interface WindowArgsOptions {
  action: WindowAction;
  app?: string;
  windowId?: string;
  /** Window title, partial match (focus only). */
  title?: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
}

export function buildWindowArgs(opts: WindowArgsOptions): string[] {
  if (!WINDOW_ACTIONS.includes(opts.action)) {
    throw new Error(`desktop_window action must be one of ${WINDOW_ACTIONS.join(", ")} (got ${String(opts.action)}).`);
  }
  if (!opts.app && !opts.windowId && !(opts.action === "focus" && opts.title)) {
    throw new Error("desktop_window needs app or windowId (from desktop_list windows).");
  }
  if (opts.action === "focus") {
    const args = ["focus-window"];
    pushTarget(args, opts);
    if (opts.title) args.push("--title", opts.title);
    return args;
  }
  if (opts.action === "resize") {
    if (!Number.isFinite(opts.width) || !Number.isFinite(opts.height) || opts.width! <= 0 || opts.height! <= 0) {
      throw new Error("resize needs a positive width and height.");
    }
    const args = ["resize-window"];
    pushTarget(args, opts);
    return [...args, "--width", String(Math.round(opts.width!)), "--height", String(Math.round(opts.height!))];
  }
  if (opts.action === "move") {
    if (!Number.isFinite(opts.x) || !Number.isFinite(opts.y)) throw new Error("move needs x and y.");
    const args = ["move-window"];
    pushTarget(args, opts);
    // The = form is how agent-desktop takes a negative coordinate.
    return [...args, `--x=${Math.round(opts.x!)}`, `--y=${Math.round(opts.y!)}`];
  }
  const args: string[] = [opts.action];
  pushTarget(args, opts);
  return args;
}

export const LIST_KINDS = ["apps", "windows", "displays", "surfaces"] as const;
export type ListKind = (typeof LIST_KINDS)[number];

export function buildListArgs(what: ListKind, app?: string): string[] {
  if (!LIST_KINDS.includes(what)) throw new Error(`desktop_list what must be one of ${LIST_KINDS.join(", ")} (got ${String(what)}).`);
  if (what === "displays") return ["list-displays"];
  if (what === "surfaces" && !app) throw new Error("desktop_list surfaces needs app.");
  return app ? [`list-${what}`, "--app", app] : [`list-${what}`];
}

export const CLIPBOARD_FORMATS = ["text", "auto", "image", "file-urls"] as const;

export type ClipboardCommand = { args: string[]; stdin?: string };

export function buildClipboardArgs(opts: {
  action: "get" | "set" | "clear";
  text?: string;
  format?: string;
  /** Where image content is written (get with format image or auto). */
  out?: string;
}): ClipboardCommand {
  if (opts.action === "clear") return { args: ["clipboard-clear"] };
  if (opts.action === "set") {
    if (typeof opts.text !== "string") throw new Error("desktop_clipboard set requires text.");
    assertStdinSize(opts.text, VALUE_STDIN_BYTES, "Split the text across calls.");
    return { args: ["clipboard-set", "--stdin"], stdin: opts.text };
  }
  if (opts.action !== "get") throw new Error(`desktop_clipboard action must be get, set or clear (got ${String(opts.action)}).`);
  const args = ["clipboard-get"];
  if (opts.format) {
    if (!(CLIPBOARD_FORMATS as readonly string[]).includes(opts.format)) {
      throw new Error(`format must be one of ${CLIPBOARD_FORMATS.join(", ")} (got ${opts.format}).`);
    }
    args.push("--format", opts.format);
    if (opts.out && (opts.format === "image" || opts.format === "auto")) args.push("--out", opts.out);
  }
  return { args };
}

// Global flags that take a value, so a passthrough scan can step over them.
const GLOBAL_VALUE_FLAGS = new Set(["--session", "--agent-id", "--trace", "--screenshot", "-w", "--wait-for", "--wait-for-gone", "--wait-timeout"]);

/** The first argument that is a command, not a global flag or its value. */
export function commandOf(args: readonly string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!arg.startsWith("-")) return arg;
    if (GLOBAL_VALUE_FLAGS.has(arg)) index++;
  }
  return undefined;
}

/**
 * desktop_command's arguments, checked. The session namespace and the headed policy belong
 * to da-desktop, so their flags are refused; `mcp` would serve stdio until the timeout.
 */
export function normalizeCommandArgs(args: unknown): string[] {
  if (!Array.isArray(args) || args.length === 0) {
    throw new Error("desktop_command requires at least one agent-desktop argument.");
  }
  const safeArgs = args.map((arg) => {
    if (typeof arg !== "string") throw new Error("desktop_command args must be strings.");
    if (!arg) throw new Error("desktop_command args cannot contain empty strings.");
    return arg;
  });
  if (safeArgs.some((arg) => arg === "--session" || arg.startsWith("--session="))) {
    throw new Error("desktop_command always runs in this session's namespace; omit --session.");
  }
  if (safeArgs.includes("--headed")) {
    throw new Error("Pass headed=true instead of --headed; it only works once the user has allowed physical input.");
  }
  const command = commandOf(safeArgs);
  if (command === "mcp") throw new Error("desktop_command cannot run `mcp`: it is a long-lived stdio server, not a command.");
  if (command === "session" && safeArgs.includes("end")) {
    throw new Error("desktop_command cannot end the session namespace these tools run in.");
  }
  return safeArgs;
}

// Commands that only report on the CLI itself. Everything else reads or drives the desktop.
const INFORMATIONAL_COMMANDS = new Set(["version", "status", "permissions", "skills", "help"]);

const BASH_INVOCATION =
  /(?:^|[;&|(]|\n)\s*(?:\w+=\S*\s+)*(?:(?:npx|bunx|pnpm\s+(?:dlx|exec)|yarn\s+dlx)\s+(?:(?:-y|--yes)\s+)?)?(?:[\w./~-]*\/)?agent-desktop(?:@[\w.-]+)?(?=\s|$)([^\n;&|]*)/g;

/**
 * True when a shell command would read or drive the desktop with agent-desktop directly.
 * That runs outside this session's namespace, so its refs are useless to the desktop_*
 * tools, its output is not truncated or kept private, and `--headed` there skips the
 * user's physical-input choice. Version, status, permissions, skills and --help still run.
 * Matched only where agent-desktop runs as a command (line start, or after ; & | ( ), so a
 * commit message or PR body that merely mentions it passes.
 * ponytail: spelling match, best effort; a script file or `xargs` that runs it gets past.
 */
export function drivesAgentDesktop(command: string): boolean {
  for (const match of command.matchAll(BASH_INVOCATION)) {
    const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (tokens.some((token) => token === "--help" || token === "-h" || token === "--version" || token === "-V")) continue;
    const name = commandOf(tokens);
    if (name === undefined || INFORMATIONAL_COMMANDS.has(name)) continue;
    return true;
  }
  return false;
}
