import { env, tmpDir } from "./env.ts";
import { basename, join } from "./paths.ts";

/** agent-desktop reports each permission as granted, denied, not_required or unknown. */
export type PermissionState = "granted" | "denied" | "not_required" | "unknown" | string;

export interface DesktopPermissions {
  accessibility?: PermissionState;
  screenRecording?: PermissionState;
  automation?: PermissionState;
}

export interface DesktopState {
  artifactDir: string;
  agentDesktopVersion?: string;
  agentDesktopCompatible?: boolean;
  platform?: string;
  permissions?: DesktopPermissions;
  /**
   * Whether tools may pass --headed, which moves the real pointer and takes focus. Only the
   * user turns it on (`/desktop headed on`, or DA_DESKTOP_HEADED=1); no tool can.
   */
  headed: boolean;
  /** The app last observed or acted on: what the status chip names. */
  app?: string;
  /** The newest snapshot's id. Refs embed their own snapshot id, so this is only for display. */
  lastSnapshotId?: string;
  lastSnapshotAt?: number;
  lastSnapshotFile?: string;
  lastScreenshotFile?: string;
  lastAction?: string;
  lastError?: string;
  // Wall-clock of the last call that proved agent-desktop answered.
  lastVerifiedAt?: number;
}

// Result of actively asking the CLI (vs. trusting in-memory state). Returned by
// verifyDesktop and rendered in status output so "ready" is checkable, not just asserted.
export interface DesktopProbe {
  agentDesktopVersion?: string;
  agentDesktopCompatible: boolean;
  requiredAgentDesktopVersion: string;
  /** The session namespace every command of this host session runs in. */
  agentDesktopSession: string;
  platform?: string;
  permissions?: DesktopPermissions;
  supportedSurfaces?: string[];
  stateRoot?: string;
  statusError?: string;
}

export function createDesktopState(cwd: string): DesktopState {
  const slug = `${sanitizeSegment(basename(cwd) || "project")}-${hashString(cwd)}`;
  return {
    artifactDir: join(tmpDir(), "da-desktop", slug),
    headed: resolveHeadedDefault(),
  };
}

export function mergeDesktopState(cwd: string, input: unknown): DesktopState {
  const base = createDesktopState(cwd);
  if (!input || typeof input !== "object") return base;

  const persisted = input as Partial<DesktopState>;
  const text = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
  const time = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
  return {
    ...base,
    agentDesktopVersion: text(persisted.agentDesktopVersion),
    agentDesktopCompatible:
      typeof persisted.agentDesktopCompatible === "boolean" ? persisted.agentDesktopCompatible : undefined,
    platform: text(persisted.platform),
    permissions: clonePermissions(persisted.permissions),
    // The user's choice for this session survives a reload; the env default can also turn it on.
    headed: base.headed || persisted.headed === true,
    app: text(persisted.app),
    lastSnapshotId: text(persisted.lastSnapshotId),
    lastSnapshotAt: time(persisted.lastSnapshotAt),
    lastSnapshotFile: text(persisted.lastSnapshotFile),
    lastScreenshotFile: text(persisted.lastScreenshotFile),
    lastAction: text(persisted.lastAction),
    lastError: text(persisted.lastError),
    lastVerifiedAt: time(persisted.lastVerifiedAt),
  };
}

export function serializeDesktopState(state: DesktopState): Record<string, unknown> {
  return {
    agentDesktopVersion: state.agentDesktopVersion,
    agentDesktopCompatible: state.agentDesktopCompatible,
    platform: state.platform,
    permissions: state.permissions ? { ...state.permissions } : undefined,
    headed: state.headed,
    app: state.app,
    lastSnapshotId: state.lastSnapshotId,
    lastSnapshotAt: state.lastSnapshotAt,
    lastSnapshotFile: state.lastSnapshotFile,
    lastScreenshotFile: state.lastScreenshotFile,
    lastAction: state.lastAction,
    lastError: state.lastError,
    lastVerifiedAt: state.lastVerifiedAt,
  };
}

function clonePermissions(input: unknown): DesktopPermissions | undefined {
  if (!input || typeof input !== "object") return undefined;
  const source = input as Record<string, unknown>;
  const pick = (key: string): string | undefined => (typeof source[key] === "string" ? (source[key] as string) : undefined);
  return { accessibility: pick("accessibility"), screenRecording: pick("screenRecording"), automation: pick("automation") };
}

const TRUTHY = ["1", "true", "on", "yes"];

/** DA_DESKTOP_HEADED=1 starts sessions with physical input allowed. Off by default. */
export function resolveHeadedDefault(): boolean {
  return TRUTHY.includes(env.DA_DESKTOP_HEADED?.trim().toLowerCase() ?? "");
}

/** The agent-desktop executable: DA_DESKTOP_BIN, else `agent-desktop` on PATH. */
export function resolveAgentDesktopBin(): string {
  return env.DA_DESKTOP_BIN?.trim() || "agent-desktop";
}

export type DesktopHealth = "ok" | "blocked" | "unknown";

/**
 * Honest readiness: blocked when the CLI is missing or too old, or Accessibility is
 * denied; unknown until something has been checked; ok otherwise.
 */
export function desktopHealth(state: DesktopState): DesktopHealth {
  if (state.agentDesktopCompatible === false) return "blocked";
  if (state.permissions?.accessibility === "denied") return "blocked";
  if (state.agentDesktopCompatible === undefined || state.lastVerifiedAt === undefined) return "unknown";
  return "ok";
}

export function healthGlyph(health: DesktopHealth): string {
  if (health === "ok") return "●";
  if (health === "unknown") return "◐";
  return "○";
}

export function healthWord(health: DesktopHealth): string {
  if (health === "ok") return "ready";
  if (health === "unknown") return "unchecked";
  return "blocked";
}

function permissionLine(permissions?: DesktopPermissions): string {
  if (!permissions) return "-";
  return [
    `accessibility ${permissions.accessibility ?? "unknown"}`,
    `screen recording ${permissions.screenRecording ?? "unknown"}`,
    `automation ${permissions.automation ?? "unknown"}`,
  ].join(" · ");
}

export function inputModeLine(state: DesktopState): string {
  return state.headed
    ? "headed allowed (tools may move the real pointer and take focus)"
    : "headless (accessibility actions only; the user allows physical input with /desktop headed on)";
}

export function desktopSummary(state: DesktopState, probe?: DesktopProbe): string {
  const health = desktopHealth(state);
  const cliStatus =
    state.agentDesktopCompatible === false
      ? `requires >=${probe?.requiredAgentDesktopVersion ?? "a newer release"}`
      : state.agentDesktopCompatible
        ? "ok"
        : "unchecked";
  const verified = state.lastVerifiedAt ? `  verified ${formatRelativeTime(state.lastVerifiedAt)}` : "";
  const snapshot = state.lastSnapshotId
    ? `${state.lastSnapshotId}  ${formatRelativeTime(state.lastSnapshotAt)}`
    : "-";
  const lines = [
    `${healthGlyph(health)} ${healthWord(health)}  ${state.platform ?? "desktop"}${verified}`,
    `  cli       agent-desktop ${state.agentDesktopVersion ?? "not found"}  ${cliStatus}`,
    `  access    ${permissionLine(state.permissions)}`,
    `  input     ${inputModeLine(state)}`,
    `  app       ${state.app ?? "-"}`,
    `  action    ${state.lastAction ?? "-"}`,
    `  snapshot  ${snapshot}`,
    `  artifacts ${state.artifactDir}`,
  ];

  // Probe details come from asking the CLI just now: the checkable truth behind the line above.
  if (probe) {
    lines.push(`  session   ${probe.agentDesktopSession}`);
    if (probe.supportedSurfaces?.length) lines.push(`  surfaces  ${probe.supportedSurfaces.join(", ")}`);
    if (probe.stateRoot) lines.push(`  state     ${probe.stateRoot}`);
    if (probe.statusError) lines.push(`  status    ${truncateErrorLine(probe.statusError, 120)}`);
  }

  if (state.lastError) lines.push(`  error     ${truncateErrorLine(state.lastError, 200)}`);
  return lines.join("\n");
}

function truncateErrorLine(error: string, maxLen = 60): string {
  const first = error.split("\n")[0] ?? error;
  return first.length > maxLen ? first.slice(0, maxLen - 1) + "…" : first;
}

export function sanitizeArtifactLabel(label: string): string {
  const trimmed = label.trim().toLowerCase();
  const sanitized = trimmed.replace(/[^a-z0-9._-]+/g, "-").replace(/-+/g, "-");
  return sanitized.replace(/^-|-$/g, "") || "artifact";
}

function sanitizeSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "project";
}

function hashString(input: string): string {
  let hash = 5381;
  for (const char of input) {
    hash = (hash * 33) ^ char.charCodeAt(0);
  }
  return (hash >>> 0).toString(16);
}

export function formatRelativeTime(timestamp?: number): string {
  if (!timestamp) return "-";

  const deltaMs = Date.now() - timestamp;
  if (deltaMs < 1_000) return "just now";

  const seconds = Math.floor(deltaMs / 1_000);
  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
