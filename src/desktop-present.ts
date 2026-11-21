// Host-neutral presentation of desktop calls: the words, motions and facts both the pi
// TUI and the Claude Code mod draw. No terminal, theme or Node APIs in here; each host
// paints these with its own renderer (desktop-ui.ts for pi, the mod for Claude Code).

// How da-desktop shows up. Each surface answers one question:
//   status chip   which app is the agent in?           static, short, hidden when idle
//   trail row     what is it doing right now?          above the editor, only during a burst
//   tool rows     what did it do, what changed?        one call line, then only new information

import { commandOf } from "./agent-desktop-args.ts";
import type { DesktopHealth, DesktopState } from "./state.ts";

export type UiColor =
  | "accent"
  | "success"
  | "warning"
  | "error"
  | "dim"
  | "muted"
  | "text"
  | "borderMuted"
  | "mdHeading"
  | "mdLink";

export interface UiTheme {
  fg(color: UiColor, text: string): string;
}

// ---------------------------------------------------------------------------
// Activity: a tool call in a few human words
// ---------------------------------------------------------------------------

// Every frame is one cell wide so the words after it never jitter. A trailing motion
// animates after the words (the caret while typing) instead of before them.
export const MOTIONS = {
  ripple: { frames: ["∙", "∘", "○", "◌"], ms: 120 },
  caret: { frames: ["▏", " "], ms: 420, trail: true },
  key: { frames: ["▪", "▫"], ms: 180 },
  load: { frames: ["◜", "◠", "◝", "◞", "◡", "◟"], ms: 90 },
  scan: { frames: ["⡀", "⠄", "⠂", "⠁", "⠈", "⠐", "⠠", "⢀"], ms: 80 },
  shutter: { frames: ["○", "◎", "◉", "●", "◉", "◎"], ms: 90 },
  clock: { frames: ["◴", "◷", "◶", "◵"], ms: 220 },
  think: { frames: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"], ms: 80 },
  down: { frames: ["⠁", "⠂", "⠄", "⡀"], ms: 100 },
  up: { frames: ["⡀", "⠄", "⠂", "⠁"], ms: 100 },
  left: { frames: ["⇠", "←"], ms: 200 },
  right: { frames: ["⇢", "→"], ms: 200 },
} satisfies Record<string, { frames: readonly string[]; ms: number; trail?: boolean }>;

export type Motion = keyof typeof MOTIONS;

export interface Activity {
  /** Imperative and short, so it reads in a trail and in the transcript: `click "Save"`. */
  text: string;
  motion: Motion;
}

const MAX_QUOTE = 24;

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

function quote(value: unknown): string {
  return typeof value === "string" && value.trim() ? `"${clip(value, MAX_QUOTE)}"` : "";
}

function word(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? clip(value, MAX_QUOTE) : fallback;
}

export function joined(...parts: string[]): string {
  return parts.filter(Boolean).join(" ");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Finds what a ref points at in a saved snapshot (`- button "Save" @s8f3k2p9:e8 [focused]`),
 * so a click reads `click "Save"` instead of `click @s8f3k2p9:e8`.
 */
export function snapshotLabel(snapshot: string, ref: string): string | undefined {
  const id = ref.trim().replace(/^@*/, "@");
  if (!/^@[A-Za-z0-9]+:e\d+$/.test(id)) return undefined;
  const pattern = new RegExp(`\\s${escapeRegExp(id)}(?:\\s|$)`);
  const line = snapshot.split("\n").find((candidate) => pattern.test(candidate));
  const match = line?.match(/^\s*-\s*([\w-]+)(?:\s+"((?:[^"\\]|\\.)*)")?/);
  if (!match) return undefined;
  const label = match[2]?.replace(/\\(.)/g, "$1").trim();
  return label ? `"${clip(label, MAX_QUOTE)}"` : match[1];
}

/** A ref with its snapshot id dropped, for when no snapshot names it: `e8`. */
function shortRef(ref: string): string {
  return ref.trim().replace(/^@?[A-Za-z0-9]+:/, "");
}

/** The agent-desktop command in a passthrough's args, past any global flags. */
function commandName(args: unknown): string {
  return Array.isArray(args) ? (commandOf(args.filter((arg): arg is string => typeof arg === "string")) ?? "") : "";
}

const CLICK_WORDS: Record<string, string> = { double: "double-click", triple: "triple-click", right: "right-click" };

/**
 * Turns a tool call into a few human words and a motion. Typed text, clipboard text and
 * piped input are never echoed: the TUI is visible to anyone nearby.
 * `labelFor` resolves element refs to their names from the latest snapshot.
 */
export function describeActivity(
  tool: string,
  params: Record<string, unknown> = {},
  labelFor: (ref: string) => string | undefined = () => undefined,
): Activity {
  const name = tool.replace(/^desktop_/, "");
  const action = typeof params.action === "string" ? params.action : undefined;
  const element = (ref: unknown): string => (typeof ref === "string" && ref.trim() ? (labelFor(ref) ?? shortRef(ref)) : "");
  const app = word(params.app);

  switch (name) {
    case "status":
      return { text: "check desktop", motion: "think" };
    case "list":
      return { text: joined("list", word(params.what, "apps"), params.what === "apps" ? "" : app), motion: "scan" };
    case "snapshot":
      return { text: joined("snapshot", app, typeof params.root === "string" ? element(params.root) : ""), motion: "scan" };
    case "find": {
      const target = joined(word(params.role), quote(params.name ?? params.text ?? params.value ?? params.description ?? params.nativeId));
      return { text: joined("find", target || "elements"), motion: "scan" };
    }
    case "get":
      return { text: joined("get", word(params.property, "text"), "of", element(params.ref)), motion: "scan" };
    case "is":
      return { text: joined("check", element(params.ref), word(params.property, "visible")), motion: "scan" };
    case "screenshot":
      return { text: joined("screenshot", app || (typeof params.screen === "number" ? `display ${params.screen}` : "")), motion: "shutter" };
    case "click":
      return { text: joined(CLICK_WORDS[String(params.kind)] ?? "click", element(params.ref)), motion: "ripple" };
    case "type":
      return { text: joined(params.mode === "set" ? "set" : "type into", element(params.ref)), motion: "caret" };
    case "select":
      return { text: joined("choose", quote(params.option)), motion: "ripple" };
    case "act":
      return { text: joined(word(action, "act"), element(params.ref)), motion: action === "clear" ? "caret" : "ripple" };
    case "scroll": {
      const direction = params.direction === "up" || params.direction === "left" || params.direction === "right" ? params.direction : "down";
      return { text: `scroll ${direction}`, motion: direction };
    }
    case "press":
      return { text: joined("press", word(params.combo, "a key")), motion: "key" };
    case "wait": {
      if (typeof params.text === "string" && !params.notification) return { text: joined("wait for", quote(params.text)), motion: "clock" };
      if (typeof params.element === "string") return { text: joined("wait for", element(params.element)), motion: "clock" };
      if (typeof params.event === "string") return { text: `wait for ${params.event}`, motion: "clock" };
      if (typeof params.window === "string") return { text: joined("wait for window", quote(params.window)), motion: "clock" };
      if (typeof params.menu === "string") return { text: `wait for menu ${params.menu}`, motion: "clock" };
      if (params.notification) return { text: "wait for notification", motion: "clock" };
      if (typeof params.ms === "number") return { text: params.ms < 1000 ? `wait ${Math.round(params.ms)}ms` : `wait ${Math.round(params.ms / 1000)}s`, motion: "clock" };
      return { text: "wait", motion: "clock" };
    }
    case "app":
      return { text: joined(action === "close" ? "quit" : "launch", app), motion: "load" };
    case "window":
      return { text: joined(word(action, "focus"), "window", app), motion: "load" };
    case "clipboard":
      return { text: action === "set" ? "write clipboard" : action === "clear" ? "clear clipboard" : "read clipboard", motion: "think" };
    case "command": {
      return { text: joined("run", word(commandName(params.args), "command")), motion: "think" };
    }
    default:
      return { text: name.replace(/_/g, " "), motion: "think" };
  }
}

// ---------------------------------------------------------------------------
// Status chip
// ---------------------------------------------------------------------------

export const MAX_APP = 24;

/**
 * The status-row chip. It shares one row with every other extension, so it stays short
 * and never animates. Words carry the state, and with nothing to say the chip is hidden.
 *
 *   da desktop Finder                 the app the agent last read or acted on
 *   da desktop Finder  headed         the user has allowed physical input
 *   da desktop no accessibility       the permission is missing
 *   da desktop update agent-desktop
 */
export function chipText(theme: UiTheme, state: DesktopState, health: DesktopHealth, named = true): string | undefined {
  const name = named ? theme.fg("dim", "da desktop") : "";
  let note = "";

  if (state.agentDesktopCompatible === false) {
    // A missing CLI only matters once the agent has tried to use it.
    if (!state.lastError && !state.agentDesktopVersion) return undefined;
    note = theme.fg("warning", state.agentDesktopVersion ? "update agent-desktop" : "install agent-desktop");
  } else if (health === "blocked") {
    note = theme.fg("warning", "no accessibility");
  } else if (state.app) {
    note = theme.fg("muted", clip(state.app, MAX_APP));
  }

  const flags = [state.headed ? theme.fg("warning", "headed") : ""].filter(Boolean);
  if (!note && flags.length === 0) return undefined;
  return [joined(name, note), ...flags].join("  ");
}

// ---------------------------------------------------------------------------
// Trail row
// ---------------------------------------------------------------------------

export const TRAIL_TIMING = {
  /** Finished trail stays readable this long after the last step. */
  lingerMs: 3_000,
  /** Then it fades to dim before disappearing. */
  drainMs: 1_200,
  maxSteps: 16,
};

export interface TrailView {
  draining: boolean;
  steps: Array<{ text: string; status: "running" | "done" | "failed"; frame?: string; frameAfter?: boolean }>;
}

export interface TrailStep extends Activity {
  id: string;
  startedAt: number;
  endedAt?: number;
  ok?: boolean;
}

export function frameAt(motion: Motion, startedAt: number, now: number): string {
  const { frames, ms } = MOTIONS[motion];
  return frames[Math.floor(Math.max(0, now - startedAt) / ms) % frames.length]!;
}

/**
 * The steps of one desktop burst, drawn as a single row above the editor:
 *
 *    da desktop  snapshot Finder › click "Downloads" › ▏type into "Search"   Finder
 *
 * Finished steps dim, the running one moves, a failure turns red. When the burst ends the
 * row lingers, fades, and renders nothing, so it costs no space at rest.
 */
export class TrailModel {
  protected steps: TrailStep[] = [];
  protected readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  begin(id: string, activity: Activity): void {
    const now = this.now();
    // A new burst starts clean once the previous one has faded out.
    const restingAt = this.restingAt();
    if (restingAt !== undefined && now >= restingAt) this.steps = [];
    this.steps.push({ ...activity, id, startedAt: now });
    if (this.steps.length > TRAIL_TIMING.maxSteps) this.steps.splice(0, this.steps.length - TRAIL_TIMING.maxSteps);
  }

  end(id: string, ok: boolean): void {
    const step = this.steps.find((candidate) => candidate.id === id && candidate.endedAt === undefined);
    if (!step) return;
    step.endedAt = this.now();
    step.ok = ok;
  }

  reset(): void {
    this.steps = [];
  }

  /** When the finished trail disappears, or undefined while a step runs or nothing is shown. */
  protected restingAt(): number | undefined {
    if (this.steps.length === 0 || this.steps.some((step) => step.endedAt === undefined)) return undefined;
    const lastEnd = Math.max(...this.steps.map((step) => step.endedAt!));
    return lastEnd + TRAIL_TIMING.lingerMs + TRAIL_TIMING.drainMs;
  }

  /** Milliseconds until the row next changes, or undefined when it is still. */
  nextDelay(): number | undefined {
    const now = this.now();
    const running = this.steps.filter((step) => step.endedAt === undefined);
    if (running.length) return Math.min(...running.map((step) => MOTIONS[step.motion].ms));
    const restingAt = this.restingAt();
    if (restingAt === undefined || now >= restingAt) return undefined;
    const drainAt = restingAt - TRAIL_TIMING.drainMs;
    return Math.max(1, (now < drainAt ? drainAt : restingAt) - now);
  }

  /**
   * What a host draws now, without colours or widths: each step's words, whether it is
   * running (with the motion frame to show), done or failed, and whether the row is
   * fading. Undefined when the row is at rest and should draw nothing.
   */
  view(): TrailView | undefined {
    const now = this.now();
    if (this.steps.length === 0) return undefined;
    const restingAt = this.restingAt();
    if (restingAt !== undefined && now >= restingAt) return undefined;
    return {
      draining: restingAt !== undefined && now >= restingAt - TRAIL_TIMING.drainMs,
      steps: this.steps.map((step) => {
        if (step.endedAt !== undefined) return { text: step.text, status: step.ok === false ? "failed" : "done" };
        const frame = frameAt(step.motion, step.startedAt, now);
        return { text: step.text, status: "running", frame, frameAfter: "trail" in MOTIONS[step.motion] };
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// Results: only what the call line does not already say
// ---------------------------------------------------------------------------

// The call line says what was done and the host colours the row by success, so a result
// adds what changed or what was learned. The model still receives the full tool output.

export interface Fact {
  text: string;
  tone: UiColor;
}

export type BodyKind = "tree" | "code" | "text";

/** Kept in the tool result's details so the transcript redraws the same after a resume. */
export interface Presentation {
  facts: Fact[];
  /** Files worth opening, never the internal snapshot dumps. */
  files: string[];
  image?: string;
  durationMs: number;
  /** The agent-facing summary paragraph, which the expanded view leaves out. */
  summary: string;
  bodyKind: BodyKind;
}

export interface ResultInput {
  tool: string;
  params: Record<string, unknown>;
  /** Full text content the model receives: summary paragraph, then tool output. */
  text: string;
  details: Record<string, unknown>;
  durationMs: number;
  snapshotFiles: readonly string[];
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

export function seconds(ms: number): string {
  return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

export function firstLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
}

function lines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim());
}

function stringList(value: unknown): string[] {
  if (typeof value === "string" && value) return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

/** How an action landed, in a word. Unverified is the common case and says so plainly. */
export function deliveryFact(delivery: unknown): Fact | undefined {
  if (delivery === "delivered_verified") return { text: "verified", tone: "success" };
  if (delivery === "delivered_unverified") return { text: "sent, unverified", tone: "muted" };
  if (delivery === "not_delivered") return { text: "already so", tone: "muted" };
  if (typeof delivery === "string" && delivery) return { text: delivery.replace(/_/g, " "), tone: "warning" };
  return undefined;
}

const BODY_KINDS: Record<string, BodyKind> = {
  snapshot: "tree",
  find: "tree",
  click: "tree",
  type: "tree",
  select: "tree",
  act: "tree",
  scroll: "tree",
  command: "code",
};

/** Decides what a finished desktop call adds to its transcript row. */
export function presentResult(input: ResultInput): Presentation {
  const name = input.tool.replace(/^desktop_/, "");
  const { params, details } = input;
  const summary = input.text.split("\n\n")[0] ?? "";
  const body = input.text.slice(summary.length).trim();
  const facts: Fact[] = [];
  const value = (text: string) => {
    const line = firstLine(text);
    if (!line) return;
    facts.push({ text: line.length > 60 ? `${line.slice(0, 59)}…` : line, tone: "text" });
    const more = lines(text).length - 1;
    if (more > 0) facts.push({ text: `+${count(more, "line")}`, tone: "dim" });
  };
  const refs = () => {
    if (typeof details.refCount === "number") facts.push({ text: count(details.refCount, "ref"), tone: "muted" });
  };
  let bodyKind: BodyKind = BODY_KINDS[name] ?? "text";

  switch (name) {
    case "snapshot":
      refs();
      if (details.complete === false) facts.push({ text: "incomplete", tone: "warning" });
      break;
    case "find": {
      const total = typeof details.totalMatches === "number" ? details.totalMatches : 0;
      facts.push(total ? { text: `${total} match${total === 1 ? "" : "es"}`, tone: "muted" } : { text: "no match", tone: "warning" });
      break;
    }
    case "click":
    case "type":
    case "select":
    case "act":
    case "scroll":
    case "press":
    case "window": {
      const fact = deliveryFact(details.delivery);
      if (fact) facts.push(fact);
      refs();
      break;
    }
    case "app":
      if (params.action === "close") {
        const fact = deliveryFact(details.delivery);
        if (fact) facts.push(fact);
      } else if (typeof details.pid === "number") {
        facts.push({ text: `pid ${details.pid}`, tone: "muted" });
      }
      break;
    case "get":
      value(body);
      break;
    case "is": {
      const property = typeof params.property === "string" ? params.property : "visible";
      facts.push(details.result === true ? { text: property, tone: "success" } : { text: `not ${property}`, tone: "warning" });
      break;
    }
    case "wait":
      facts.push({ text: `after ${seconds(input.durationMs)}`, tone: "muted" });
      break;
    case "list":
      if (typeof details.count === "number") facts.push({ text: count(details.count, String(details.what ?? "item").replace(/s$/, "")), tone: "muted" });
      break;
    case "clipboard":
      // The clipboard's contents never reach the transcript row, only their size.
      if (details.action === "set") facts.push({ text: "written", tone: "success" });
      else if (details.action === "clear") facts.push({ text: "cleared", tone: "muted" });
      else if (details.found === false) facts.push({ text: "empty", tone: "muted" });
      else if (typeof details.chars === "number") facts.push({ text: count(details.chars, "char"), tone: "muted" });
      break;
    case "status": {
      const probe = details.probe && typeof details.probe === "object" ? (details.probe as Record<string, unknown>) : undefined;
      if (!probe) break;
      const permissions = probe.permissions && typeof probe.permissions === "object" ? (probe.permissions as Record<string, unknown>) : {};
      if (probe.agentDesktopCompatible === false) facts.push({ text: "agent-desktop missing or too old", tone: "error" });
      else if (permissions.accessibility === "denied") facts.push({ text: "accessibility denied", tone: "error" });
      else facts.push({ text: "ready", tone: "success" });
      if (details.headed === true) facts.push({ text: "physical input on", tone: "warning" });
      break;
    }
    case "command": {
      const first = commandName(params.args);
      if (typeof details.refCount === "number") {
        refs();
        bodyKind = "tree";
      } else if (!first.startsWith("clipboard")) {
        const fact = deliveryFact(details.delivery);
        if (fact) facts.push(fact);
      }
      break;
    }
  }

  const hidden = new Set([...input.snapshotFiles, ...stringList(details.snapshotFile)]);
  const files = [
    ...new Set([
      ...stringList(details.screenshotFile),
      ...stringList(details.clipboardFile),
      ...stringList(details.artifacts),
      ...stringList(details.fullOutputFile),
    ]),
  ].filter((file) => !hidden.has(file));
  const image = files.find((file) => /\.(png|jpe?g)$/i.test(file));

  return { facts, files, image, durationMs: input.durationMs, summary, bodyKind };
}

/** `2026-10-02T03-12-45-123Z-after-click.txt` → `after-click.txt`. */
export function artifactName(path: string): string {
  const base = path.split("/").at(-1) ?? path;
  return base.replace(/^\d{4}-\d{2}-\d{2}T[\d-]+Z-/, "");
}

const FAILURE_WORDS: Record<string, { reason: string; hint?: string }> = {
  STALE_REF: { reason: "stale ref", hint: "the UI changed; take a new snapshot" },
  SNAPSHOT_NOT_FOUND: { reason: "stale ref", hint: "its snapshot is gone; take a new one" },
  AMBIGUOUS_TARGET: { reason: "ambiguous target", hint: "narrow it with a window id or a fresh ref" },
  PERM_DENIED: { reason: "permission missing", hint: "agent-desktop permissions --guide" },
  POLICY_DENIED: { reason: "needs physical input", hint: "/desktop headed on allows it" },
  APP_NOT_FOUND: { reason: "app not running", hint: "launch it first" },
  WINDOW_NOT_FOUND: { reason: "window not found", hint: "list windows again" },
  ELEMENT_NOT_FOUND: { reason: "element not found" },
  ACTION_NOT_SUPPORTED: { reason: "action not supported here" },
  TIMEOUT: { reason: "timed out" },
  APP_UNRESPONSIVE: { reason: "app not responding" },
};

/**
 * Failures for a human: a short reason in red and the next step. The agent-facing
 * message (code, details, retry guidance) stays in the expanded view.
 */
export function explainFailure(text: string): { reason: string; hint?: string } {
  const first = firstLine(text);
  if (/requires agent-desktop|agent-desktop CLI not found/i.test(text)) {
    return { reason: "agent-desktop missing or too old", hint: "npm i -g agent-desktop@latest" };
  }
  if (/^Physical input \(headed\) is off/.test(first)) return { reason: "physical input is off", hint: "/desktop headed on allows it" };
  const code = first.match(/^agent-desktop \S+ failed: ([A-Z_]+):/)?.[1];
  const known = code ? FAILURE_WORDS[code] : undefined;
  // An input that may have landed is the one thing a watcher must know before a retry.
  const landed = /^Retry: (unsafe|unknown)/m.test(text) ? "may have landed; look before retrying" : undefined;
  if (known) return { reason: known.reason, hint: landed ?? known.hint };
  const reason = first.replace(/^agent-desktop \S+ failed:\s*/, "");
  return { reason: reason.length > 100 ? `${reason.slice(0, 99)}…` : reason || "failed", ...(landed ? { hint: landed } : {}) };
}
