import { readFile } from "node:fs/promises";

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";

import { setupWarning, verifyDesktop, DesktopError, type DesktopActionResult } from "./agent-desktop.ts";
import { createDesktopState, desktopHealth, desktopSummary, inputModeLine, mergeDesktopState, serializeDesktopState } from "./state.ts";
import { DESKTOP_GUIDELINES, DESKTOP_TOOLS, prepareDesktopInput } from "./desktop-tools.ts";
import { piHost } from "./pi-host.ts";
import {
  DesktopTrail,
  desktopCallLine,
  desktopChip,
  describeActivity,
  presentResult,
  snapshotLabel,
  TrailWidget,
} from "./desktop-ui.ts";
import { renderDesktopResult } from "./desktop-result-renderer.ts";

const CUSTOM_STATE_TYPE = "desktop-ops-state";
const USAGE = "Usage: /desktop status | headed on|off";

export default function (pi: ExtensionAPI) {
  let state = createDesktopState(process.cwd());

  // The chip says which app the agent is in; the trail row shows each step as it runs; tool
  // rows keep the same words in the transcript. See desktop-ui.ts.
  const trail = new DesktopTrail();
  let trailWidget: TrailWidget | undefined;
  const callTexts = new Map<string, string>();
  let lastChip: string | undefined | null = null;

  // Every snapshot is saved by the core, so the newest file is where the model's refs
  // most likely came from. Read it once per snapshot to name what is being clicked.
  let snapshotCache: { file: string; text: string } | undefined;
  const latestSnapshot = async (): Promise<string | undefined> => {
    const file = state.lastSnapshotFile;
    if (!file) return undefined;
    if (snapshotCache?.file !== file) {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text === undefined) return undefined;
      snapshotCache = { file, text };
    }
    return snapshotCache.text;
  };

  const refreshUi = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    // Each setStatus makes the footer re-layout, so only send changes.
    const chip = desktopChip(ctx.ui.theme, state, desktopHealth(state));
    if (chip === lastChip) return;
    lastChip = chip;
    ctx.ui.setStatus("desktop-ops", chip);
  };

  const persistCommandState = (): void => {
    pi.appendEntry(CUSTOM_STATE_TYPE, { desktopState: serializeDesktopState(state) });
  };

  const handleFailure = (ctx: ExtensionContext, error: unknown): never => {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    // The model reads the code and the retry line in the message; nothing here retries.
    if (error instanceof DesktopError && error.code === "APP_NOT_FOUND") state.app = undefined;
    refreshUi(ctx);
    throw error instanceof Error ? error : new Error(message);
  };

  const registerDesktopTool = <TParams extends TSchema, TDetails = unknown, TState = unknown>(
    tool: ToolDefinition<TParams, TDetails, TState>,
  ): void => {
    pi.registerTool({
      renderResult: renderDesktopResult,
      renderCall: (args, theme, context) => {
        const text = callTexts.get(context.toolCallId) ?? describeActivity(tool.name, args as Record<string, unknown>).text;
        const line = desktopCallLine(theme, text);
        // Piped text and typed text stay out of the expanded row too.
        const { text: _text, stdin: _stdin, ...shown } = args as Record<string, unknown>;
        return new Text(context.expanded ? `${line}\n${theme.fg("dim", `${tool.name} ${JSON.stringify(shown)}`)}` : line, 0, 0);
      },
      ...tool,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const input = params as Record<string, unknown>;
        const snapshot = await latestSnapshot();
        const snapshotFileBefore = state.lastSnapshotFile;
        const labelFor = (ref: string) => (snapshot ? snapshotLabel(snapshot, ref) : undefined);
        const activity = describeActivity(tool.name, input, labelFor);
        callTexts.set(toolCallId, activity.text);
        trail.begin(toolCallId, activity);
        trailWidget?.poke();
        const startedAt = Date.now();
        let ok = false;
        try {
          const result = await tool.execute(toolCallId, params, signal, onUpdate, ctx);
          ok = true;
          const details = result.details && typeof result.details === "object" ? (result.details as Record<string, unknown>) : {};
          const text = result.content.find((block) => block.type === "text");
          const presentation = presentResult({
            tool: tool.name,
            params: input,
            text: text?.type === "text" ? text.text : "",
            details,
            durationMs: Date.now() - startedAt,
            snapshotFiles: [snapshotFileBefore, state.lastSnapshotFile].filter((file): file is string => Boolean(file)),
          });
          return { ...result, details: { ...details, presentation } as TDetails };
        } finally {
          trail.end(toolCallId, ok);
          trailWidget?.poke();
          refreshUi(ctx);
        }
      },
    });
  };

  const loadStateFromSession = (ctx: ExtensionContext): void => {
    let restored: unknown;

    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type === "custom" && entry.customType === CUSTOM_STATE_TYPE) {
        restored = entry.data && typeof entry.data === "object" ? (entry.data as { desktopState?: unknown }).desktopState : restored;
      }

      if (entry.type === "message" && entry.message.role === "toolResult") {
        const details = entry.message.details;
        if (details && typeof details === "object" && "desktopState" in details) {
          restored = (details as { desktopState?: unknown }).desktopState;
        }
      }
    }

    state = mergeDesktopState(ctx.cwd, restored);
  };

  pi.on("session_start", async (_event, ctx) => {
    loadStateFromSession(ctx);
    callTexts.clear();
    trail.reset();
    lastChip = null;
    snapshotCache = undefined;
    if (ctx.hasUI) {
      // Mounted once so the row keeps its place among the widgets above the editor; it
      // renders nothing until the agent touches the desktop.
      ctx.ui.setWidget("da-desktop-trail", (tui, theme) => {
        trailWidget?.dispose();
        trailWidget = new TrailWidget(tui, theme, trail, () => state.app);
        return trailWidget;
      });
    }
    // Probe the CLI version and permissions on every start. Persisted compatibility can be
    // stale after either da-desktop or the installed CLI changes, or a permission is revoked.
    try {
      const warning = setupWarning(await verifyDesktop(piHost(pi, ctx), state));
      if (warning && ctx.hasUI) ctx.ui.notify(warning, "warning");
    } catch {
      /* keep session startup usable if the probe itself fails */
    }
    refreshUi(ctx);
  });

  pi.on("session_shutdown", async () => {
    trailWidget?.dispose();
  });

  pi.registerCommand("desktop", {
    description: "Check agent-desktop status, or allow physical input for this session",
    handler: async (args, ctx) => {
      const [subcommand, value] = args.trim().split(/\s+/);

      try {
        if (!subcommand || subcommand === "help") {
          ctx.ui.notify(USAGE, "info");
          return;
        }

        if (subcommand === "status") {
          const probe = await verifyDesktop(piHost(pi, ctx), state).catch(() => undefined);
          refreshUi(ctx);
          persistCommandState();
          ctx.ui.notify(desktopSummary(state, probe), "info");
          return;
        }

        // Physical input moves the real pointer and takes focus. A slash command is typed by
        // the user, never called by the model, which makes this the consent step.
        if (subcommand === "headed") {
          if (value === "on" || value === "off") {
            state.headed = value === "on";
            refreshUi(ctx);
            persistCommandState();
          } else if (value) {
            ctx.ui.notify(USAGE, "warning");
            return;
          }
          ctx.ui.notify(`Input: ${inputModeLine(state)}`, state.headed ? "warning" : "info");
          return;
        }

        ctx.ui.notify(`Unknown /desktop subcommand: ${subcommand}. ${USAGE}`, "warning");
      } catch (error) {
        return handleFailure(ctx, error);
      }
    },
  });

  for (const spec of DESKTOP_TOOLS) {
    registerDesktopTool({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      promptSnippet: spec.promptSnippet,
      promptGuidelines: DESKTOP_GUIDELINES,
      // Plain JSON schema: pi validates and coerces it like typebox; the cast is for the types.
      parameters: spec.parameters as unknown as TSchema,
      prepareArguments: (args) => prepareDesktopInput(spec, args),
      // Every tool drives the one desktop and shares `state`; parallel calls would race on both.
      executionMode: "sequential",
      annotations: spec.readOnly
        ? { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
        : { readOnlyHint: false, openWorldHint: true },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const result = await spec.run(piHost(pi, ctx), state, params as Record<string, unknown>);
          refreshUi(ctx);
          return toolResponse(result);
        } catch (error) {
          return handleFailure(ctx, error);
        }
      },
    });
  }

  function toolResponse(result: DesktopActionResult) {
    const content = [result.summary, result.contentText].filter(Boolean).join("\n\n");

    return {
      content: [{ type: "text" as const, text: content }],
      details: {
        ...result.diagnostics,
        artifacts: result.artifacts,
        desktopState: serializeDesktopState(state),
      },
    };
  }
}
