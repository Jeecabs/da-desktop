// Pure parsing and formatting of agent-desktop CLI output. No I/O or framework deps so it
// stays unit-testable as a Light Guard Test, mirroring agent-desktop-args.ts.
//
// Every command prints one JSON envelope: `{version, ok, command, data}` on success,
// `{version, ok: false, command, error}` on failure (exit code 1, or 2 for a parse error).

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export type Retry = "safe" | "unsafe" | "unknown";

export interface Disposition {
  /** not_delivered, delivery_uncertain, delivered_unverified, delivered_verified or unknown. */
  delivery: string;
  retry: Retry;
}

export interface DesktopErrorPayload {
  code: string;
  message: string;
  suggestion?: string;
  platformDetail?: string;
  disposition: Disposition;
  recovery?: { strategy?: string; retryable?: boolean; requiresFreshSnapshot?: boolean; retryAfterMs?: number };
  details?: Record<string, unknown>;
}

export type Envelope =
  | { ok: true; command: string; version?: string; data: unknown }
  | { ok: false; command: string; version?: string; error: DesktopErrorPayload };

/** Missing or unreadable disposition is `unknown`: never assume a retry is safe. */
export function readDisposition(value: unknown): Disposition {
  const source = isPlainObject(value) ? value : {};
  const retry = source.retry === "safe" || source.retry === "unsafe" ? source.retry : "unknown";
  return { delivery: typeof source.delivery === "string" ? source.delivery : "unknown", retry };
}

function findJsonStart(output: string): number {
  for (let i = 0; i < output.length; i++) {
    if (output[i] === "{") return i;
  }
  return -1;
}

/** The envelope in a command's stdout, or undefined when it printed something else. */
export function parseEnvelope(stdout: string): Envelope | undefined {
  const start = findJsonStart(stdout);
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return undefined;
  }
  if (!isPlainObject(parsed) || typeof parsed.ok !== "boolean") return undefined;
  const command = typeof parsed.command === "string" ? parsed.command : "command";
  const version = typeof parsed.version === "string" ? parsed.version : undefined;
  if (parsed.ok) return { ok: true, command, version, data: parsed.data };

  const error = isPlainObject(parsed.error) ? parsed.error : {};
  const recovery = isPlainObject(error.recovery) ? error.recovery : undefined;
  return {
    ok: false,
    command,
    version,
    error: {
      code: typeof error.code === "string" ? error.code : "INTERNAL",
      message: typeof error.message === "string" ? error.message : "agent-desktop command failed",
      suggestion: typeof error.suggestion === "string" ? error.suggestion : undefined,
      platformDetail: typeof error.platform_detail === "string" ? error.platform_detail : undefined,
      disposition: readDisposition(error.disposition),
      recovery: recovery && {
        strategy: typeof recovery.strategy === "string" ? recovery.strategy : undefined,
        retryable: typeof recovery.retryable === "boolean" ? recovery.retryable : undefined,
        requiresFreshSnapshot:
          typeof recovery.requires_fresh_snapshot === "boolean" ? recovery.requires_fresh_snapshot : undefined,
        retryAfterMs: typeof recovery.retry_after_ms === "number" ? recovery.retry_after_ms : undefined,
      },
      details: isPlainObject(error.details) ? error.details : undefined,
    },
  };
}

const RETRY_GUIDANCE: Record<Retry, string> = {
  safe: "safe. Nothing reached the app, so fixing the cause and repeating the call cannot double an effect.",
  unsafe:
    "unsafe. The input may have reached the app. Observe first (desktop_snapshot, desktop_get or desktop_is) and decide from what you see; do not repeat the call blindly.",
  unknown:
    "unknown. Nothing proves whether the input landed. Observe first (desktop_snapshot, desktop_get or desktop_is) before acting again.",
};

// What to do next, for the codes where the CLI's own suggestion names shell commands the
// model cannot run here.
const CODE_HINTS: Record<string, string> = {
  STALE_REF: "The UI changed since that snapshot. Take a new desktop_snapshot (or desktop_find) and use its ref.",
  SNAPSHOT_NOT_FOUND: "That ref's snapshot is gone or belongs to another session. Take a new desktop_snapshot and use its ref.",
  AMBIGUOUS_TARGET: "Several elements, windows or app instances match. Narrow with windowId (desktop_list windows), root or desktop_find, then use a fresh ref.",
  PERM_DENIED: "A system permission is missing. Ask the user to run `agent-desktop permissions --guide` and grant it to the app that runs this agent.",
  POLICY_DENIED: "This needs physical input, which is off. Use an accessibility action instead, or ask the user to allow it with /desktop headed on, then pass headed=true. Never work around it.",
  APP_NOT_FOUND: "No such app is running. Check the name with desktop_list apps, or start it with desktop_app launch.",
  WINDOW_NOT_FOUND: "Refresh window ids with desktop_list windows.",
  INVALID_ARGS: "Fix the input; repeating the same arguments fails the same way.",
  ACTION_NOT_SUPPORTED: "This element does not offer that action. Pick an element whose snapshot line lists it, or another tool.",
};

/** Query statistics and checks are for the CLI's authors; the model needs the cause. */
function compactDetails(details: Record<string, unknown> | undefined): string {
  if (!details) return "";
  const { query_stats: _stats, observed_bounds_hash: _hash, ...rest } = details;
  if (Object.keys(rest).length === 0) return "";
  const text = JSON.stringify(rest);
  return text.length > 600 ? `${text.slice(0, 599)}…` : text;
}

/** A failed command, with the code and disposition a caller branches on. */
export class DesktopError extends Error {
  readonly code: string;
  readonly command: string;
  readonly disposition: Disposition;
  readonly details?: Record<string, unknown>;

  constructor(command: string, error: DesktopErrorPayload) {
    super(formatDesktopError(command, error));
    this.name = "DesktopError";
    this.code = error.code;
    this.command = command;
    this.disposition = error.disposition;
    this.details = error.details;
  }
}

/**
 * The failure the model reads. The first line carries the stable code; the retry line
 * always says whether repeating the call is safe, since a repeated click can submit twice.
 */
export function formatDesktopError(command: string, error: DesktopErrorPayload): string {
  // The CLI's own suggestion often says "then retry", which is wrong advice once the input
  // may have landed; there the retry line below is the whole instruction.
  const hint = CODE_HINTS[error.code] ?? (error.disposition.retry === "safe" ? error.suggestion : undefined);
  const details = compactDetails(error.details);
  return [
    `agent-desktop ${command} failed: ${error.code}: ${error.message}`,
    ...(hint ? [`Next: ${hint}`] : []),
    `Retry: ${RETRY_GUIDANCE[error.disposition.retry]}`,
    ...(error.platformDetail ? [`Platform: ${error.platformDetail}`] : []),
    ...(details ? [`Details: ${details}`] : []),
  ].join("\n");
}

/**
 * One automatic retry, only where the CLI declares it: retry is `safe`, the adapter has not
 * marked the failure non-retryable, and the plan is to wait and run the original again
 * (TIMEOUT and APP_UNRESPONSIVE). A `wait` that ran out its own timeout is not repeated,
 * nor is a ref whose process exited. Returns the pause in ms, or undefined for no retry.
 */
export function autoRetryDelayMs(envelope: Envelope): number | undefined {
  if (envelope.ok) return undefined;
  const { error } = envelope;
  if (error.disposition.retry !== "safe") return undefined;
  if (error.code !== "TIMEOUT" && error.code !== "APP_UNRESPONSIVE") return undefined;
  if (error.recovery?.strategy !== "inspect_state_then_retry_original" || error.recovery.retryable !== true) return undefined;
  if (error.details?.retryable === false || error.details?.process_state === "exited") return undefined;
  if (envelope.command === "wait" || error.details?.kind === "wait_timeout") return undefined;
  return Math.min(Math.max(error.recovery.retryAfterMs ?? 250, 0), 2000);
}

// ---------------------------------------------------------------------------
// Accessibility trees as text
// ---------------------------------------------------------------------------

const MAX_NAME = 80;

function inline(text: string, max = MAX_NAME): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
  return clipped.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

function boundsText(bounds: unknown): string {
  if (!isPlainObject(bounds)) return "";
  const n = (key: string) => (typeof bounds[key] === "number" ? Math.round(bounds[key] as number) : "?");
  return `@${n("x")},${n("y")} ${n("width")}x${n("height")}`;
}

/**
 * One element as a line: `button "Save" @s8f3k2p9:e8 [focused] {Click,SetFocus}`.
 * Actions are listed unless the element only clicks, which a ref already implies.
 */
export function formatNode(node: Record<string, unknown>): string {
  const parts = [typeof node.role === "string" && node.role ? node.role : "element"];
  const name = typeof node.name === "string" ? node.name : "";
  if (name.trim()) parts.push(`"${inline(name)}"`);
  if (typeof node.ref_id === "string") parts.push(node.ref_id);
  const states = strings(node.states);
  if (states.length) parts.push(`[${states.join(", ")}]`);
  const actions = strings(node.available_actions);
  if (actions.length && !(actions.length === 1 && actions[0] === "Click")) parts.push(`{${actions.join(",")}}`);
  const value = typeof node.value === "string" ? node.value : typeof node.value === "number" ? String(node.value) : "";
  if (value.trim() && value !== name) parts.push(`value="${inline(value)}"`);
  // Generated ids (`_NS:61`) are no use to desktop_find; real ones name an unnamed element.
  if (!name.trim() && isPlainObject(node.native_id) && typeof node.native_id.value === "string" && !node.native_id.value.startsWith("_NS:")) {
    parts.push(`id=${inline(node.native_id.value, 40)}`);
  }
  const bounds = boundsText(node.bounds);
  if (bounds) parts.push(bounds);
  if (typeof node.children_count === "number" && node.children_count > 0) {
    parts.push(`(+${node.children_count} ${node.children_count === 1 ? "child" : "children"})`);
  }
  return parts.join(" ");
}

/** The JSON tree as an indented list, a fraction of the JSON's size. */
export function formatTree(tree: unknown): string {
  const lines: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (!isPlainObject(node)) return;
    lines.push(`${"  ".repeat(depth)}- ${formatNode(node)}`);
    if (Array.isArray(node.children)) for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree, 0);
  return lines.join("\n");
}

export interface SnapshotInfo {
  app?: string;
  snapshotId?: string;
  refCount?: number;
  complete?: boolean;
  matchedSelector?: string;
  /** Header line, then the tree. */
  text: string;
}

/** Reads a `snapshot` payload, or the snapshot a ref action returns with waitFor. */
export function formatSnapshot(data: unknown): SnapshotInfo | undefined {
  if (!isPlainObject(data) || !isPlainObject(data.tree)) return undefined;
  const app = typeof data.app === "string" ? data.app : undefined;
  const snapshotId = typeof data.snapshot_id === "string" ? data.snapshot_id : undefined;
  const refCount = typeof data.ref_count === "number" ? data.ref_count : undefined;
  const complete = typeof data.complete === "boolean" ? data.complete : undefined;
  const matchedSelector = typeof data.matched_selector === "string" ? data.matched_selector : undefined;
  const tree = formatTree(data.tree);
  const header = [
    app ?? "desktop",
    snapshotId ? `snapshot ${snapshotId}` : "",
    refCount !== undefined ? `${refCount} ref${refCount === 1 ? "" : "s"}` : "",
    complete === false ? "INCOMPLETE (the read hit its deadline; raise timeoutMs or narrow with root)" : "",
    /\(\+\d+ child/.test(tree) ? "(+N children) marks a truncated container: pass its ref as root to drill in" : "",
  ].filter(Boolean);
  return { app, snapshotId, refCount, complete, matchedSelector, text: `${header.join(" · ")}\n${tree}` };
}

export interface FindInfo {
  snapshotId?: string;
  /** Matches returned in this payload. */
  shown: number;
  /** Matches in the tree, when the CLI reports it. */
  total: number;
  truncated: boolean;
  text: string;
}

/** Reads `find`: `{matches, total_matches, truncated}`, `{match}` for a pick, or `{count}`. */
export function formatFind(data: unknown): FindInfo {
  if (!isPlainObject(data)) return { shown: 0, total: 0, truncated: false, text: "(no matches)" };
  const snapshotId = typeof data.snapshot_id === "string" ? data.snapshot_id : undefined;
  if (typeof data.count === "number" && !("matches" in data) && !("match" in data)) {
    return { snapshotId, shown: 0, total: data.count, truncated: false, text: String(data.count) };
  }
  const matches = (Array.isArray(data.matches) ? data.matches : data.match ? [data.match] : []).filter(isPlainObject);
  const total = typeof data.total_matches === "number" ? data.total_matches : matches.length;
  const lines = matches.map((match) => {
    const path = strings(match.path);
    return `- ${formatNode(match)}${path.length ? `  in ${path.join(" > ")}` : ""}`;
  });
  return {
    snapshotId,
    shown: matches.length,
    total,
    truncated: data.truncated === true,
    text: lines.length ? lines.join("\n") : "(no matches)",
  };
}

const DELIVERY_WORDS: Record<string, string> = {
  delivered_verified: "delivered and verified",
  delivered_unverified: "delivered, effect not verified",
  not_delivered: "already satisfied, nothing sent",
  delivery_uncertain: "delivery uncertain",
  unknown: "delivery unknown",
};

export function deliveryWords(disposition: Disposition): string {
  return DELIVERY_WORDS[disposition.delivery] ?? disposition.delivery.replace(/_/g, " ");
}

export interface ActionInfo {
  disposition?: Disposition;
  /** How it was delivered: `AXPress via semantic_api`. */
  mechanism?: string;
  /** The snapshot a waitFor returned, when there was one. */
  snapshot?: SnapshotInfo;
}

/** Reads a ref action's payload, flat or nested under `after_action` when a wait ran. */
export function readAction(data: unknown): ActionInfo {
  if (!isPlainObject(data)) return {};
  const action = isPlainObject(data.after_action) ? data.after_action : data;
  const steps = Array.isArray(action.steps) ? action.steps.filter(isPlainObject) : [];
  const step = steps.find((candidate) => candidate.outcome === "succeeded") ?? steps[0];
  const mechanism = step
    ? [typeof step.label === "string" ? step.label : "", typeof step.mechanism === "string" ? `via ${step.mechanism}` : ""].filter(Boolean).join(" ")
    : undefined;
  return {
    disposition: isPlainObject(action.disposition) ? readDisposition(action.disposition) : undefined,
    mechanism: mechanism || undefined,
    snapshot: formatSnapshot(data),
  };
}

function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

export function listOf(data: unknown, key: string): Array<Record<string, unknown>> {
  const list = Array.isArray(data) ? data : isPlainObject(data) && Array.isArray(data[key]) ? data[key] : [];
  return list.filter(isPlainObject);
}

/**
 * Foreground apps in full. Background agents and helper processes, which a task rarely
 * targets, follow as one line of unique names. A platform that does not say which is
 * which lists everything in full.
 */
export function formatApps(data: unknown): { count: number; text: string } {
  const apps = listOf(data, "apps");
  if (!apps.length) return { count: 0, text: "(no matching apps)" };
  const line = (app: Record<string, unknown>) =>
    [field(app, "name") || "?", field(app, "bundle_id"), `pid ${field(app, "pid") || "?"}`].filter(Boolean).join("  ");
  const classified = apps.some((app) => app.presentation === "foreground");
  const foreground = classified ? apps.filter((app) => app.presentation === "foreground") : apps;
  const others = classified ? apps.filter((app) => app.presentation !== "foreground") : [];
  const lines = foreground.map(line);
  if (others.length) {
    const names = [...new Set(others.map((app) => field(app, "name") || "?"))];
    lines.push(`background and helper processes (${others.length}): ${names.join(", ")}`);
  }
  return { count: foreground.length, text: lines.join("\n") };
}

export function formatWindows(data: unknown): { count: number; text: string } {
  const windows = listOf(data, "windows");
  if (!windows.length) return { count: 0, text: "(no windows)" };
  const lines = windows.map((window) => {
    const flags = [
      window.is_focused ? "focused" : "",
      window.minimized ? "minimized" : "",
      window.visible === false ? "hidden" : "",
      window.accessible === false ? "not accessible" : "",
    ].filter(Boolean);
    const title = field(window, "title");
    return [
      field(window, "id") || "?",
      field(window, "app_name") || "?",
      title ? `"${inline(title)}"` : "",
      boundsText(window.bounds),
      flags.length ? `[${flags.join(", ")}]` : "",
    ].filter(Boolean).join("  ");
  });
  return { count: windows.length, text: lines.join("\n") };
}

export function formatDisplays(data: unknown): { count: number; text: string } {
  const displays = listOf(data, "displays");
  if (!displays.length) return { count: 0, text: "(no displays)" };
  const lines = displays.map((display, index) =>
    [`${index}`, `id ${field(display, "id") || "?"}`, boundsText(display.bounds), `scale ${field(display, "scale") || "?"}`, display.is_primary ? "[primary]" : ""]
      .filter(Boolean)
      .join("  "),
  );
  return { count: displays.length, text: lines.join("\n") };
}

export function formatSurfaces(data: unknown): { count: number; text: string } {
  const surfaces = listOf(data, "surfaces");
  if (!surfaces.length) return { count: 0, text: "(no open surfaces beyond the window)" };
  const lines = surfaces.map((surface) => {
    const kind = field(surface, "kind") || field(surface, "surface") || field(surface, "type") || "surface";
    const title = field(surface, "title") || field(surface, "name");
    return [kind, title ? `"${inline(title)}"` : "", field(surface, "window_id")].filter(Boolean).join("  ");
  });
  return { count: surfaces.length, text: lines.join("\n") };
}

/** `get` returns `{property, ref, value}`; bounds and states come back structured. */
export function formatValue(value: unknown): string {
  if (value === undefined || value === null) return "(no value)";
  if (typeof value === "string") return value || "(empty)";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) return value.join(", ") || "(none)";
  return JSON.stringify(value, null, 2);
}

/** `is` returns `{applicable, property, ref, result}`. */
export function readIsResult(data: unknown): { result: boolean; applicable: boolean } {
  if (isPlainObject(data) && typeof data.result === "boolean") {
    return { result: data.result, applicable: data.applicable !== false };
  }
  throw new Error(`desktop_is expected a boolean result, got: ${JSON.stringify(data)}`);
}

/** Permission states from `status` or `permissions`: each is `{state, ...}`. */
export function readPermissions(data: unknown): { accessibility?: string; screenRecording?: string; automation?: string } | undefined {
  const source = isPlainObject(data) && isPlainObject(data.permissions) ? data.permissions : data;
  if (!isPlainObject(source)) return undefined;
  const state = (key: string): string | undefined => {
    const entry = source[key];
    return isPlainObject(entry) && typeof entry.state === "string" ? entry.state : undefined;
  };
  const permissions = { accessibility: state("accessibility"), screenRecording: state("screen_recording"), automation: state("automation") };
  return Object.values(permissions).some(Boolean) ? permissions : undefined;
}
