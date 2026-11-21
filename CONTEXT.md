# da desktop

Lachlan's desktop-control package for pi and Claude Code. It wraps `agent-desktop` as typed tools, commands, status UI, and session-scoped state, with one desktop core shared by both hosts. It is the desktop sibling of da browser and follows its shape.

## Language

**Host**:
The agent that runs da desktop: pi (extension, `src/index.ts`) or Claude Code (mod, `hooks/register.tsx`). The desktop core reaches a host only through `DesktopHost`.
_Avoid_: Platform, client, port

**da desktop package**:
A focused pi package that owns desktop control, separate from da browser and from the general `pi-extensions` bundle.
_Avoid_: Generic extension bundle, computer-use framework

**Trusted Desktop Automation**:
Desktop actions are allowed on Lachlan's trusted machine without extra confirmation prompts, but only for user-directed work.
_Avoid_: Desktop sandbox, permission-gated read-only mode

**Curated Desktop Wrapper**:
Common `agent-desktop` commands are exposed as typed tools; uncommon ones (notifications, mouse input, drag, batch, traces) stay behind `desktop_command`.
_Avoid_: Full CLI clone, shell command passthrough

**Snapshot**:
One read of an app's accessibility tree. The CLI returns JSON; the model reads it as an indented text tree, a fraction of the size, saved privately as a **Desktop Artifact**.
_Avoid_: Screenshot (that is a picture), DOM

**Qualified Ref**:
An element handle that embeds its snapshot id, `@<snapshot_id>:eN`. da desktop passes refs through unchanged and refuses a bare `@eN` rather than guessing its snapshot.
_Avoid_: Selector, element index, auto-qualifying a bare ref with the newest snapshot

**Session Namespace**:
The `--session` name every command of one host session runs under, derived from the host's session id (`pi-…`, `cc-…`). agent-desktop confines snapshot lookups to it, so one session's refs are `SNAPSHOT_NOT_FOUND` in another. It is the desktop counterpart of da browser's controlled tab.
_Avoid_: Global namespace, a traced `session start` session, sharing refs across agents

**Disposition**:
agent-desktop's statement, on every failure and every action, of whether input reached the app (`delivery`) and whether repeating the command is safe (`retry`: safe, unsafe or unknown).
_Avoid_: Treating an exit code or a message as the retry signal

**Safe Retry**:
The one automatic retry da desktop performs: only when `retry` is `safe` and the CLI declares an `inspect_state_then_retry_original` plan (a transient `TIMEOUT` or `APP_UNRESPONSIVE`), never for a `wait` that ran out its own timeout. Everything else goes back to the model with the retry line spelled out.
_Avoid_: Retry loop, retrying a stale ref, retrying anything that may have landed

**Headless**:
The default. Ref actions go through the accessibility API without moving the pointer or taking focus.
_Avoid_: Background mode, hidden mode

**Physical Input (headed)**:
`--headed`: real pointer and keyboard events, with focus changes. It is off until the user types `/desktop headed on` (or sets `DA_DESKTOP_HEADED=1`). A slash command is the consent step because the model cannot call one. Once allowed, a tool still has to ask per call with `headed: true`.
_Avoid_: A tool that enables it, enabling it to get past `POLICY_DENIED`

**Desktop Artifact**:
Snapshot text, screenshot, or clipboard image saved under the deterministic `<tmp>/da-desktop/<cwd-slug>` directory, mode 700, files 600.
_Avoid_: Global permanent artifact store, world-readable temp files

## Relationships

- **da desktop** is installed separately from **da browser** and `pi-extensions`.
- The desktop core imports neither Node nor a **Host** package, because the Claude Code mod runs without Node. Host differences live in the adapters.
- Each **Host** names its **Session Namespace**, so pi and Claude Code sessions never share refs.
- A **Curated Desktop Wrapper** should keep schemas strict and use `prepareArguments` for resumed-session compatibility.
- **da desktop** checks its minimum supported `agent-desktop` version at session start and before each action. Newer versions remain valid.
- Failure is read from the JSON envelope, not the exit code. Callers branch on `error.code` and the **Disposition**; `message` and `suggestion` are not a stable interface.
- A success whose delivery is `delivered_unverified` is reported as unverified in the tool text and the transcript row. The model is told to look again.
- Text for `type`, `set-value` and `clipboard-set` travels on stdin (`--stdin`), never in argv. `DesktopHost.exec` therefore takes `stdin`; pi spawns the process itself for those calls because `pi.exec` has none.
- The transcript shows a few words per call and never typed text, clipboard contents or piped input: the TUI is visible to anyone nearby.
- `desktop_press` requires an app or window id. An unscoped press would type into whatever the user has focused.
- The Claude Code mod refuses `agent-desktop` from Bash when it would read or drive the desktop. Informational commands still run.
- **Desktop Artifacts** are temporary evidence for agent workflows and visual QA.
- agent-desktop keeps each **Session Namespace**'s refmaps under `~/.agent-desktop/sessions/<name>`. Nothing prunes a namespace that was never a traced session, so they accumulate, a few kilobytes each.

## Testing

Keep light guard tests around pure argument builders, envelope and tree parsers, the retry rule, the Bash guard, presentation, and state serialization. The runner is tested against a scripted CLI, so the suite needs neither `agent-desktop` nor the Accessibility permission.
