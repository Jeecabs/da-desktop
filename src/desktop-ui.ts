import { pathToFileURL } from "node:url";

import { hyperlink, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";

import type { DesktopHealth, DesktopState } from "./state.ts";
import {
  artifactName,
  chipText,
  frameAt,
  MOTIONS,
  seconds,
  TrailModel,
  TRAIL_TIMING,
  type BodyKind,
  type Presentation,
  type UiColor,
  type UiTheme,
} from "./desktop-present.ts";

export * from "./desktop-present.ts";

// How da-desktop shows up in the pi TUI. Each surface answers one question:
//   status chip   which app is the agent in?           static, short, hidden when idle
//   trail row     what is it doing right now?          above the editor, only during a burst
//   tool rows     what did it do, what changed?        one call line, then only new information
// The trail matters most under codemode, where desktop calls inside a script get no rows.

/** The status-row chip for pi. See chipText. */
export function desktopChip(theme: UiTheme, state: DesktopState, health: DesktopHealth): string | undefined {
  return chipText(theme, state, health);
}

/** The trail model painted as one pi TUI row (see TrailModel for what it holds). */
export class DesktopTrail extends TrailModel {
  lines(theme: UiTheme, width: number, app?: string): string[] {
    const now = this.now();
    if (this.steps.length === 0) return [];
    const restingAt = this.restingAt();
    if (restingAt !== undefined && now >= restingAt) return [];
    const draining = restingAt !== undefined && now >= restingAt - TRAIL_TIMING.drainMs;
    const paint = (color: UiColor, text: string) => theme.fg(draining ? "dim" : color, text);

    const rendered = this.steps.map((step) => {
      if (step.endedAt === undefined) {
        const frame = frameAt(step.motion, step.startedAt, now);
        return "trail" in MOTIONS[step.motion]
          ? paint("accent", `${step.text}${frame}`)
          : paint("accent", `${frame} ${step.text}`);
      }
      if (step.ok === false) return paint("error", `✗ ${step.text}`);
      return paint("muted", step.text);
    });

    const prefix = ` ${paint("muted", "da desktop")}  `;
    const separator = paint("borderMuted", " › ");
    const more = paint("dim", "…");
    const budget = width - visibleWidth(prefix);

    // Newest steps win; older ones fall off the left behind an ellipsis.
    let shown: string[] = [];
    for (let index = rendered.length - 1; index >= 0; index--) {
      const candidate = [rendered[index]!, ...shown];
      const dropped = index > 0;
      const cost = visibleWidth(candidate.join(separator)) + (dropped ? visibleWidth(more + separator) : 0);
      if (cost > budget && shown.length > 0) break;
      shown = candidate;
    }
    const steps = (shown.length < rendered.length ? [more, ...shown] : shown).join(separator);

    // The app goes last and only whole.
    const room = budget - visibleWidth(steps) - 3;
    const place = app && app.length <= room ? `   ${paint("dim", app)}` : "";
    return [truncateToWidth(prefix + steps + place, width, "…")];
  }
}

// ---------------------------------------------------------------------------
// Transcript rows
// ---------------------------------------------------------------------------

/** One plain line per desktop tool call: `desktop click "Save changes"`. */
export function desktopCallLine(theme: { fg(color: "toolTitle" | "accent", text: string): string; bold(text: string): string }, text: string): string {
  return `${theme.fg("toolTitle", theme.bold("desktop"))} ${theme.fg("accent", text)}`;
}

/**
 * Mounts a DesktopTrail above the editor. It wakes only for the next visible change
 * (a motion frame, the fade, the disappearance) and sleeps while the row is still.
 */
export class TrailWidget implements Component {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly tui: Pick<TUI, "requestRender">;
  private readonly theme: UiTheme;
  private readonly trail: DesktopTrail;
  private readonly app: () => string | undefined;

  constructor(tui: Pick<TUI, "requestRender">, theme: UiTheme, trail: DesktopTrail, app: () => string | undefined) {
    this.tui = tui;
    this.theme = theme;
    this.trail = trail;
    this.app = app;
  }

  render(width: number): string[] {
    return this.trail.lines(this.theme, width, this.app());
  }

  invalidate(): void {}

  poke(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.tui.requestRender();
    const delay = this.trail.nextDelay();
    if (delay === undefined) return;
    this.timer = setTimeout(() => this.poke(), delay);
    this.timer.unref?.();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/** The collapsed result: facts, then duration when slow, then files to open. */
export function resultLine(theme: UiTheme, presentation: Presentation, options: { link?: boolean } = {}): string {
  const link = options.link !== false;
  const parts = presentation.facts.map((fact) => theme.fg(fact.tone, fact.text));
  const timed = presentation.facts.some((fact) => fact.text.startsWith("after "));
  if (presentation.durationMs >= 1000 && !timed) parts.push(theme.fg("dim", seconds(presentation.durationMs)));
  for (const file of presentation.files) {
    const label = artifactName(file);
    parts.push(theme.fg("dim", link ? hyperlink(label, pathToFileURL(file).href) : label));
  }
  return parts.join("  ");
}

const INTERACTIVE_ROLES = new Set([
  "button", "textfield", "textarea", "searchfield", "combobox", "checkbox", "radiobutton", "switch", "slider", "stepper",
  "menuitem", "menubutton", "popupbutton", "tab", "link", "treeitem", "cell", "listitem", "disclosuretriangle",
]);

/** `- button "Save" @s8f3k2p9:e8 [focused] {Click,SetFocus}`: role, name, ref, the rest. */
function treeLine(theme: UiTheme, line: string): string {
  const match = line.match(/^(\s*-\s*)([\w-]+)(\s+"(?:[^"\\]|\\.)*")?(\s+@[A-Za-z0-9]+:e\d+)?(.*)$/);
  if (!match) return theme.fg("muted", line);
  const [, lead, role, name = "", ref = "", rest = ""] = match;
  const roleColor: UiColor = INTERACTIVE_ROLES.has(role!) ? "accent" : role === "window" || role === "heading" ? "mdHeading" : "dim";
  const nameColor: UiColor = role === "statictext" ? "muted" : "text";
  return theme.fg("dim", lead!) + theme.fg(roleColor, role!) + theme.fg(nameColor, name) + theme.fg("mdLink", ref) + theme.fg("dim", rest);
}

/** Colours a tool's raw output for the expanded view; code is drawn by pi. */
export function formatBody(theme: UiTheme, kind: BodyKind, body: string): string {
  const paint: Record<BodyKind, (line: string) => string> = {
    tree: (line) => treeLine(theme, line),
    code: (line) => line,
    text: (line) => theme.fg("muted", line),
  };
  return body.split("\n").map(paint[kind]).join("\n");
}
