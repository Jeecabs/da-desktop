import {
  actOnDesktopElement,
  appDesktop,
  clickDesktopElement,
  clipboardDesktop,
  findDesktopElements,
  getDesktopProperty,
  isDesktopState,
  listDesktop,
  pressDesktopKey,
  runDesktopCommand,
  screenshotDesktop,
  scrollDesktopElement,
  selectDesktopOption,
  snapshotDesktop,
  typeIntoDesktopElement,
  verifyDesktop,
  waitOnDesktop,
  windowDesktop,
  type ActionOptions,
  type DesktopActionResult,
} from "./agent-desktop.ts";
import {
  ACT_ACTIONS,
  CLIPBOARD_FORMATS,
  GET_PROPERTIES,
  IS_PROPERTIES,
  LIST_KINDS,
  SURFACES,
  WAIT_EVENTS,
  WAIT_PREDICATES,
  WINDOW_ACTIONS,
} from "./agent-desktop-args.ts";
import { prepareCompatArguments } from "./extension-utils.ts";
import type { DesktopHost } from "./host.ts";
import { desktopSummary, type DesktopState } from "./state.ts";

// The desktop tools, once, for both hosts: pi registers them in index.ts, the Claude Code
// mod in hooks/register.tsx. Plain JSON schema, so neither typebox nor Node is needed here.

type Input = Record<string, any>;

export interface DesktopToolSpec {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  parameters: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  /** Only observes the desktop, so hosts may skip approval for it. */
  readOnly?: true;
  compat?: Parameters<typeof prepareCompatArguments>[1];
  /** Input fixes beyond compat, applied after it. */
  prepare?(args: Input): Input;
  run(host: DesktopHost, state: DesktopState, input: Input): Promise<DesktopActionResult>;
}

/** Compat aliases and string coercion, then the tool's own fixes: the same in both hosts. */
export function prepareDesktopInput(spec: DesktopToolSpec, args: unknown): Input {
  const prepared = spec.compat ? prepareCompatArguments<Input>(args, spec.compat) : (args as Input);
  // Hosts do not all enforce the schema; a missing field would reach agent-desktop as undefined.
  const missing = (spec.parameters.required ?? []).filter((key) => prepared?.[key] === undefined || prepared[key] === null);
  if (missing.length) throw new Error(`${spec.name} requires ${missing.join(", ")}.`);
  return spec.prepare ? spec.prepare(prepared) : prepared;
}

export const DESKTOP_GUIDELINES = [
  "The loop is observe, act on a ref, observe again. desktop_snapshot reads an app's accessibility tree; every element you can act on has a ref like @s8f3k2p9:e8.",
  "Refs belong to their snapshot. Copy them exactly, snapshot id included; a bare @e8 is refused. STALE_REF, SNAPSHOT_NOT_FOUND or AMBIGUOUS_TARGET means the UI changed: take a new snapshot or desktop_find and use its refs.",
  "Dense apps: map first with desktop_snapshot skeleton=true, then drill into one region with root=<ref>. Prefer desktop_find when the target has a known role, name or text.",
  "Several windows give AMBIGUOUS_TARGET: get ids from desktop_list what=windows and pass windowId.",
  "Every failure ends with a Retry line. Repeat a failed action only when it says safe. On unsafe or unknown the input may have landed: observe before acting again, because a repeated click can submit twice and a repeated toggle undoes itself.",
  "A success marked \"effect not verified\" is not proof. Check the result with desktop_snapshot, desktop_get or desktop_is, or pass waitFor to get a fresh snapshot once the expected element appears.",
  "Actions are headless: they use the accessibility API without moving the pointer or taking focus. POLICY_DENIED means the action needs physical input, which only the user can allow (/desktop headed on). Never try to get around it.",
  "This is the user's own desktop, signed in as them: never perform actions the user did not ask for. Snapshots, screenshots and clipboard contents can hold private data; use what the task needs and do not copy it elsewhere.",
  "Use desktop_wait for an element, text, window or event rather than plain milliseconds.",
  "A menu item can be clicked without opening its menu: desktop_snapshot surface=menubar lists every item with a ref.",
  "Error text may name agent-desktop CLI flags. They map to tool parameters: --surface is surface, --root is root, --timeout-ms is timeoutMs, --window-id is windowId. --headed is headed=true, which still needs the user's permission.",
];

const REF = { type: "string", description: "Snapshot-qualified element ref, exactly as printed: @<snapshot_id>:eN" };
const APP = { type: "string", description: "Application name, e.g. Finder (see desktop_list what=apps)" };
const WINDOW_ID = { type: "string", description: "Window id from desktop_list what=windows, for an app with several windows" };
const TIMEOUT_MS = { type: "number", description: "Maximum wait for the element to resolve and become actionable, in milliseconds (default 5000)" };
const HEADED = {
  type: "boolean",
  description: "Use physical input (moves the real pointer, takes focus). Refused unless the user has allowed it with /desktop headed on.",
};
const WAIT_FOR = {
  type: "string",
  description: "After the action, poll until an element matching this role:text selector (e.g. button:Save) appears, and return a fresh snapshot",
};
const WAIT_FOR_GONE = {
  type: "string",
  description: "After the action, poll until no element matches this role:text selector, and return a fresh snapshot",
};
const WAIT_TIMEOUT_MS = { type: "number", description: "Maximum time for waitFor / waitForGone in milliseconds (default 30000)" };
const SURFACE = { type: "string", enum: [...SURFACES], description: "Surface to read instead of the window: menu, menubar, sheet, popover, alert, ..." };

/** The follow-up options every ref action shares. */
const ACTION_PROPERTIES = { timeoutMs: TIMEOUT_MS, waitFor: WAIT_FOR, waitForGone: WAIT_FOR_GONE, waitTimeoutMs: WAIT_TIMEOUT_MS, headed: HEADED };
const ACTION_COMPAT = {
  aliases: { element: "ref", timeout: "timeoutMs" },
  booleanFields: ["headed"],
  numberFields: ["timeoutMs", "waitTimeoutMs"],
} as const;

function actionOptions(input: Input): ActionOptions {
  return {
    headed: input.headed,
    waitFor: input.waitFor,
    waitForGone: input.waitForGone,
    waitTimeoutMs: input.waitTimeoutMs,
    timeoutMs: input.timeoutMs,
  };
}

/** Lists sent as one comma-separated string become arrays. */
function splitList(value: unknown): unknown {
  return typeof value === "string" ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : value;
}

export const DESKTOP_TOOLS: DesktopToolSpec[] = [
  {
    name: "desktop_status",
    readOnly: true,
    label: "Desktop Status",
    description:
      "Probe agent-desktop: version compatibility, platform, Accessibility and Screen Recording permission, this session's namespace, and whether physical input is allowed. It asks the CLI, so trust it over assumptions.",
    promptSnippet: "Check that desktop control is installed and permitted before a multi-step desktop task",
    parameters: { type: "object", properties: {} },
    async run(host, state) {
      const probe = await verifyDesktop(host, state).catch(() => undefined);
      return { summary: desktopSummary(state, probe), diagnostics: { probe, headed: state.headed } };
    },
  },
  {
    name: "desktop_list",
    readOnly: true,
    label: "Desktop List",
    description:
      "List running apps, visible windows (with the ids windowId takes), displays, or the surfaces an app presents now (menus, sheets, popovers, alerts).",
    promptSnippet: "Find an app's exact name, a window id, or which menus and sheets are open",
    parameters: {
      type: "object",
      properties: {
        what: { type: "string", enum: [...LIST_KINDS] },
        app: { type: "string", description: "Filter to this application. Required for surfaces." },
      },
      required: ["what"],
    },
    compat: { aliases: { kind: "what", name: "app" } },
    run: (host, state, input) => listDesktop(host, state, input.what, input.app),
  },
  {
    name: "desktop_snapshot",
    readOnly: true,
    label: "Desktop Snapshot",
    description:
      "Read an app's accessibility tree, defaulting to interactive elements in a compact tree. Each actionable element carries a ref. On dense apps use skeleton=true for a shallow map, then root=<ref> to drill into one region. Without app it reads whatever is focused.",
    promptSnippet: "Inspect a desktop app and collect fresh element refs before acting",
    parameters: {
      type: "object",
      properties: {
        app: APP,
        windowId: WINDOW_ID,
        interactiveOnly: { type: "boolean", description: "Include interactive elements only", default: true },
        compact: { type: "boolean", description: "Collapse single-child unnamed nodes", default: true },
        skeleton: { type: "boolean", description: "Shallow overview; truncated containers show (+N children)" },
        root: { type: "string", description: "Start from this ref instead of the window root" },
        surface: SURFACE,
        maxDepth: { type: "number", description: "Maximum tree depth (default 10)" },
        includeBounds: { type: "boolean", description: "Include each element's screen bounds" },
        timeoutMs: { type: "number", description: "Read deadline in milliseconds (default 3000; raise for slow Electron apps)" },
        waitFor: { type: "string", description: "Poll until an element matching this role:text selector appears, then snapshot" },
        waitForGone: { type: "string", description: "Poll until no element matches this role:text selector, then snapshot" },
        waitTimeoutMs: WAIT_TIMEOUT_MS,
        label: { type: "string", description: "Optional artifact label" },
      },
    },
    compat: {
      aliases: { application: "app", window: "windowId", interactive: "interactiveOnly", depth: "maxDepth", bounds: "includeBounds", timeout: "timeoutMs" },
      booleanFields: ["interactiveOnly", "compact", "skeleton", "includeBounds"],
      numberFields: ["maxDepth", "timeoutMs", "waitTimeoutMs"],
    },
    run: (host, state, input) =>
      snapshotDesktop(host, state, {
        app: input.app,
        windowId: input.windowId,
        interactiveOnly: input.interactiveOnly ?? true,
        compact: input.compact ?? true,
        skeleton: input.skeleton,
        root: input.root,
        surface: input.surface,
        maxDepth: input.maxDepth,
        includeBounds: input.includeBounds,
        timeoutMs: input.timeoutMs,
        waitFor: input.waitFor,
        waitForGone: input.waitForGone,
        waitTimeoutMs: input.waitTimeoutMs,
        label: input.label,
      }),
  },
  {
    name: "desktop_find",
    readOnly: true,
    label: "Desktop Find",
    description:
      "Search an app for elements by role, name, text, value, description, native id or state, and get their refs without reading the whole tree. It only looks; act on a returned ref with the other tools.",
    promptSnippet: "Find an element by role, name or text and get its ref in one call",
    parameters: {
      type: "object",
      properties: {
        app: APP,
        windowId: WINDOW_ID,
        role: { type: "string", description: "Accessibility role: button, textfield, checkbox, menuitem, ..." },
        name: { type: "string", description: "Accessible name or label" },
        text: { type: "string", description: "Text in the name, value, title or description" },
        value: { type: "string", description: "Current value" },
        description: { type: "string", description: "Accessible description" },
        nativeId: { type: "string", description: "Native automation id (AXIdentifier), shown as id= in snapshots" },
        exact: { type: "boolean", description: "Require exact, case-insensitive matches" },
        states: { type: "array", items: { type: "string" }, description: "State tokens, e.g. enabled or offscreen=false" },
        root: { type: "string", description: "Search only inside this ref's subtree" },
        surface: SURFACE,
        pick: { type: "string", enum: ["first", "last", "count"], description: "Return only the first or last match, or just the count" },
        nth: { type: "number", description: "Return only the Nth match, 0-indexed" },
        limit: { type: "number", description: "Return at most N matches (default 50, 0 for all)" },
        timeoutMs: { type: "number", description: "Search deadline in milliseconds (default 5000)" },
      },
    },
    compat: {
      aliases: { application: "app", window: "windowId", label: "name", id: "nativeId", state: "states", index: "nth", timeout: "timeoutMs" },
      booleanFields: ["exact"],
      numberFields: ["nth", "limit", "timeoutMs"],
    },
    prepare: (args) => ({ ...args, states: splitList(args.states) }),
    run: (host, state, input) =>
      findDesktopElements(host, state, {
        app: input.app,
        windowId: input.windowId,
        role: input.role,
        name: input.name,
        text: input.text,
        value: input.value,
        description: input.description,
        nativeId: input.nativeId,
        exact: input.exact,
        states: input.states,
        root: input.root,
        surface: input.surface,
        pick: input.pick,
        nth: input.nth,
        limit: input.limit,
        timeoutMs: input.timeoutMs,
      }),
  },
  {
    name: "desktop_get",
    readOnly: true,
    label: "Desktop Get",
    description: "Read one property of an element by ref: text (what a person reads), value, title, bounds, role or states.",
    promptSnippet: "Read an element's text, value, bounds or states to verify an action",
    parameters: {
      type: "object",
      properties: { ref: REF, property: { type: "string", enum: [...GET_PROPERTIES], default: "text" } },
      required: ["ref"],
    },
    compat: { aliases: { element: "ref", what: "property" } },
    run: (host, state, input) => getDesktopProperty(host, state, input.ref, input.property ?? "text"),
  },
  {
    name: "desktop_is",
    readOnly: true,
    label: "Desktop Is",
    description:
      "Boolean check of an element's state: visible, enabled, checked, focused, expanded or selected. Returns structured details.result; use it instead of parsing snapshot text.",
    promptSnippet: "Assert that an element is visible, enabled, checked, focused, expanded or selected",
    parameters: {
      type: "object",
      properties: { ref: REF, property: { type: "string", enum: [...IS_PROPERTIES], default: "visible" } },
      required: ["ref"],
    },
    compat: { aliases: { element: "ref", check: "property", state: "property" } },
    run: (host, state, input) => isDesktopState(host, state, input.ref, input.property ?? "visible"),
  },
  {
    name: "desktop_screenshot",
    readOnly: true,
    label: "Desktop Screenshot",
    description:
      "Save a PNG of an app window, or of a whole display with screen. Use it when the accessibility tree is not enough, or as visual evidence. The file can show private screen content; it is saved readable only by the user.",
    promptSnippet: "Capture a window or display as an image for visual verification",
    parameters: {
      type: "object",
      properties: {
        app: APP,
        windowId: WINDOW_ID,
        screen: { type: "number", description: "Capture this display by index instead (0 is primary; see desktop_list what=displays)" },
        label: { type: "string", description: "Short label naming what is being captured" },
      },
    },
    compat: { aliases: { application: "app", window: "windowId", display: "screen" }, numberFields: ["screen"] },
    run: (host, state, input) =>
      screenshotDesktop(host, state, { app: input.app, windowId: input.windowId, screen: input.screen, label: input.label }),
  },
  {
    name: "desktop_click",
    label: "Desktop Click",
    description:
      "Click an element by ref through the accessibility API, without moving the pointer. kind right opens a context menu; double and triple usually need physical input (headed).",
    promptSnippet: "Click a specific element ref from the latest desktop snapshot",
    parameters: {
      type: "object",
      properties: {
        ref: REF,
        kind: { type: "string", enum: ["click", "double", "triple", "right"], default: "click" },
        ...ACTION_PROPERTIES,
      },
      required: ["ref"],
    },
    compat: { ...ACTION_COMPAT, aliases: { ...ACTION_COMPAT.aliases, button: "kind" } },
    run: (host, state, input) => clickDesktopElement(host, state, input.ref, input.kind ?? "click", actionOptions(input)),
  },
  {
    name: "desktop_type",
    label: "Desktop Type",
    description:
      "Put text into a text element by ref. mode type inserts at the caret like a person typing; mode set replaces the whole value through accessibility. The text is piped to agent-desktop, never placed in process arguments.",
    promptSnippet: "Type into, or set the value of, a text field by ref",
    parameters: {
      type: "object",
      properties: {
        ref: REF,
        text: { type: "string", description: "Text to enter" },
        mode: { type: "string", enum: ["type", "set"], default: "type" },
        intervalMs: { type: "number", description: "Type one keystroke every N ms (1-2000) instead of inserting at once (mode type)" },
        ...ACTION_PROPERTIES,
      },
      required: ["ref", "text"],
    },
    compat: {
      ...ACTION_COMPAT,
      aliases: { ...ACTION_COMPAT.aliases, value: "text", interval: "intervalMs" },
      numberFields: [...ACTION_COMPAT.numberFields, "intervalMs"],
    },
    run: (host, state, input) =>
      typeIntoDesktopElement(host, state, { ref: input.ref, text: input.text, mode: input.mode, intervalMs: input.intervalMs }, actionOptions(input)),
  },
  {
    name: "desktop_select",
    label: "Desktop Select",
    description: "Select an option in a list or dropdown by ref",
    parameters: {
      type: "object",
      properties: { ref: REF, option: { type: "string", description: "Option to select" }, ...ACTION_PROPERTIES },
      required: ["ref", "option"],
    },
    compat: { ...ACTION_COMPAT, aliases: { ...ACTION_COMPAT.aliases, value: "option" } },
    run: (host, state, input) => selectDesktopOption(host, state, input.ref, input.option, actionOptions(input)),
  },
  {
    name: "desktop_act",
    label: "Desktop Act",
    description:
      "Perform a simple ref action: focus, clear (empty a value), toggle, check or uncheck (idempotent), expand or collapse a disclosure or tree item, scroll-to (bring into view), or hover (physical input only).",
    promptSnippet: "Focus, clear, toggle, check, uncheck, expand, collapse, or reveal an element by ref",
    parameters: {
      type: "object",
      properties: { ref: REF, action: { type: "string", enum: [...ACT_ACTIONS] }, ...ACTION_PROPERTIES },
      required: ["ref", "action"],
    },
    compat: ACTION_COMPAT,
    run: (host, state, input) => actOnDesktopElement(host, state, input.ref, input.action, actionOptions(input)),
  },
  {
    name: "desktop_scroll",
    label: "Desktop Scroll",
    description: "Scroll a scrollable element by ref. Its snapshot line lists Scroll among its actions.",
    promptSnippet: "Scroll a list or scroll area to reveal more content",
    parameters: {
      type: "object",
      properties: {
        ref: REF,
        direction: { type: "string", enum: ["up", "down", "left", "right"], default: "down" },
        amount: { type: "number", description: "Scroll units (default 3)" },
        ...ACTION_PROPERTIES,
      },
      required: ["ref"],
    },
    compat: { ...ACTION_COMPAT, numberFields: [...ACTION_COMPAT.numberFields, "amount"] },
    run: (host, state, input) =>
      scrollDesktopElement(host, state, input.ref, input.direction ?? "down", input.amount, actionOptions(input)),
  },
  {
    name: "desktop_press",
    label: "Desktop Press",
    description:
      "Send a key combo to an app: return, escape, tab, space, delete, arrows, f1-f12, with cmd, ctrl, alt, shift (cmd+s on macOS, ctrl+s elsewhere). Keys go to the named app's process without focusing it. Delivery never proves the shortcut did anything, so verify.",
    promptSnippet: "Press a key or shortcut in a desktop app",
    parameters: {
      type: "object",
      properties: {
        combo: { type: "string", description: "Key combo, e.g. return, escape, cmd+s, shift+tab" },
        app: APP,
        windowId: WINDOW_ID,
        headed: HEADED,
      },
      required: ["combo"],
    },
    compat: { aliases: { key: "combo", keys: "combo", application: "app", window: "windowId" }, booleanFields: ["headed"] },
    run: (host, state, input) => pressDesktopKey(host, state, { combo: input.combo, app: input.app, windowId: input.windowId, headed: input.headed }),
  },
  {
    name: "desktop_wait",
    readOnly: true,
    label: "Desktop Wait",
    description:
      "Wait for desktop state: an element ref reaching a predicate, text appearing in an app, a window title, a menu opening or closing, a new notification, a lifecycle event, or plain milliseconds. Pick exactly one mode.",
    promptSnippet: "Wait for an element, text, window, menu or event before continuing",
    parameters: {
      type: "object",
      properties: {
        element: { type: "string", description: "Ref to wait on (see predicate)" },
        predicate: { type: "string", enum: [...WAIT_PREDICATES], description: "What the element must satisfy (default exists)" },
        value: { type: "string", description: "Expected value for predicate value" },
        action: { type: "string", enum: ["click", "type", "set-value", "clear"], description: "Action for predicate actionable (default click)" },
        text: { type: "string", description: "Wait until this text appears in the app's accessibility tree" },
        count: { type: "number", description: "Expected number of matches for a text wait" },
        window: { type: "string", description: "Wait until a window with this title appears; with event, narrows it to that title" },
        menu: { type: "string", enum: ["open", "closed"], description: "Wait until a menu is open, or dismissed" },
        notification: { type: "boolean", description: "Wait until a new notification arrives (text filters it)" },
        event: { type: "string", enum: [...WAIT_EVENTS] },
        windowId: { type: "string", description: "Narrow a window-opened, window-closed or focus-changed event to one window id" },
        ms: { type: "number", description: "Plain time wait in milliseconds (last resort)" },
        app: { type: "string", description: "Scope an element, window or text wait to this application" },
        timeoutMs: { type: "number", description: "Wait timeout in milliseconds (default 30000)" },
      },
    },
    compat: {
      aliases: { ref: "element", timeout: "timeoutMs", application: "app" },
      booleanFields: ["notification"],
      numberFields: ["ms", "count", "timeoutMs"],
    },
    run: (host, state, input) =>
      waitOnDesktop(host, state, {
        element: input.element,
        predicate: input.predicate,
        value: input.value,
        action: input.action,
        text: input.text,
        count: input.count,
        window: input.window,
        menu: input.menu,
        notification: input.notification,
        event: input.event,
        windowId: input.windowId,
        ms: input.ms,
        app: input.app,
        timeoutMs: input.timeoutMs,
      }),
  },
  {
    name: "desktop_app",
    label: "Desktop App",
    description:
      "Launch an application (returns once its process runs; activate=true brings it forward and waits for a window) or close one. Closing quits gracefully; force=true terminates it and loses unsaved work.",
    promptSnippet: "Launch or quit a desktop application",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["launch", "close"] },
        app: { type: "string", description: "Application name, or bundle id for launch" },
        args: { type: "array", items: { type: "string" }, description: "Command-line arguments for the launched app" },
        activate: { type: "boolean", description: "Bring the app forward and wait for a window (launch)" },
        newInstance: { type: "boolean", description: "Start a fresh instance instead of attaching to a running one (launch)" },
        force: { type: "boolean", description: "Terminate instead of quitting gracefully (close)" },
        timeoutMs: { type: "number", description: "Upper bound for the whole launch in milliseconds (default 30000)" },
        headed: HEADED,
      },
      required: ["action", "app"],
    },
    compat: {
      aliases: { name: "app", application: "app", timeout: "timeoutMs" },
      booleanFields: ["activate", "newInstance", "force", "headed"],
      numberFields: ["timeoutMs"],
    },
    prepare: (args) => ({ ...args, action: args.action === "quit" ? "close" : args.action === "open" ? "launch" : args.action }),
    run: (host, state, input) =>
      appDesktop(host, state, {
        action: input.action,
        app: input.app,
        args: input.args,
        activate: input.activate,
        newInstance: input.newInstance,
        force: input.force,
        timeoutMs: input.timeoutMs,
        headed: input.headed,
      }),
  },
  {
    name: "desktop_window",
    label: "Desktop Window",
    description:
      "Focus, resize, move, minimize, maximize or restore a window, chosen by app or by windowId from desktop_list what=windows. Focus brings it in front of what the user is doing, so use it only when the task needs it.",
    promptSnippet: "Bring a window forward or change its size, position or state",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: [...WINDOW_ACTIONS] },
        app: APP,
        windowId: WINDOW_ID,
        title: { type: "string", description: "Window title, partial match (focus only)" },
        width: { type: "number", description: "New width in pixels (resize)" },
        height: { type: "number", description: "New height in pixels (resize)" },
        x: { type: "number", description: "New X position (move)" },
        y: { type: "number", description: "New Y position (move)" },
        headed: HEADED,
      },
      required: ["action"],
    },
    compat: {
      aliases: { application: "app", window: "windowId", id: "windowId" },
      booleanFields: ["headed"],
      numberFields: ["width", "height", "x", "y"],
    },
    run: (host, state, input) =>
      windowDesktop(host, state, {
        action: input.action,
        app: input.app,
        windowId: input.windowId,
        title: input.title,
        width: input.width,
        height: input.height,
        x: input.x,
        y: input.y,
        headed: input.headed,
      }),
  },
  {
    name: "desktop_clipboard",
    label: "Desktop Clipboard",
    description:
      "Read, write or clear the system clipboard. The clipboard is the user's and can hold passwords or other private data: read it only when the task needs it, and never repeat its contents elsewhere. Written text is piped to agent-desktop, never placed in process arguments.",
    promptSnippet: "Read or write the system clipboard when a task needs it",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["get", "set", "clear"] },
        text: { type: "string", description: "Text to write (set)" },
        format: { type: "string", enum: [...CLIPBOARD_FORMATS], description: "What to read (get): text (default), auto, image or file-urls" },
      },
      required: ["action"],
    },
    compat: { aliases: { value: "text" } },
    prepare: (args) => ({ ...args, action: args.action === "read" ? "get" : args.action === "write" ? "set" : args.action }),
    run: (host, state, input) => clipboardDesktop(host, state, { action: input.action, text: input.text, format: input.format }),
  },
  {
    name: "desktop_command",
    label: "Desktop Command",
    description:
      "Run any other agent-desktop command with structured args: notifications, drag and mouse input, open-system-surface, batch, trace, skills, permissions. It runs in this session's namespace, so omit --session; pass headed=true instead of --headed. Text for type, set-value or clipboard-set goes in stdin with the --stdin flag, never in args.",
    promptSnippet: "Use any agent-desktop CLI feature not covered by the typed desktop tools",
    parameters: {
      type: "object",
      properties: {
        args: {
          type: "array",
          items: { type: "string", description: "agent-desktop CLI argument" },
          description: "Argument array, e.g. ['list-notifications', '--limit', '5'] or ['skills', 'get', 'desktop']",
        },
        stdin: { type: "string", description: "Text piped to the command, for --stdin" },
        headed: HEADED,
        timeoutMs: { type: "number", description: "Timeout in milliseconds, clamped between 1000 and 300000" },
        label: { type: "string", description: "Optional artifact label for saved output" },
      },
      required: ["args"],
    },
    compat: { booleanFields: ["headed"], numberFields: ["timeoutMs"] },
    run: (host, state, input) =>
      runDesktopCommand(host, state, { args: input.args, stdin: input.stdin, headed: input.headed, timeoutMs: input.timeoutMs, label: input.label }),
  },
];
