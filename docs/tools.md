# da-desktop tools and advanced setup

Full command and tool reference, install alternatives, and operational notes.
The [README](../README.md) stays lean on purpose.

## Install alternatives

Recommended:

```bash
pi install https://github.com/Jeecabs/da-desktop
```

Other routes that also work:

```bash
pi install git:github.com/Jeecabs/da-desktop
```

```bash
git clone https://github.com/Jeecabs/da-desktop.git ~/.pi/agent/extensions/da-desktop
cd ~/.pi/agent/extensions/da-desktop
pnpm install
```

Reload pi if already running:

```text
/reload
```

da-desktop has no runtime dependencies and no build step, so a production install (`npm install --omit=dev`) has nothing to fetch.

`agent-desktop` itself is installed separately:

```bash
npm install -g agent-desktop@latest   # or: brew install agent-desktop
agent-desktop status                  # platform, permissions, supported surfaces
agent-desktop permissions --guide     # macOS: walks through the Accessibility grant
```

On macOS the Accessibility permission belongs to the app that runs your agent: the terminal for pi and Claude Code.

## Commands

| Command | Description |
| --- | --- |
| `/desktop status` | Probe the CLI version, permissions, platform and this session's namespace |
| `/desktop headed on` | Allow physical input (real pointer, focus changes) for this session |
| `/desktop headed off` | Back to accessibility actions only |
| `/desktop headed` | Show the current setting |

## Tools

| Tool | Description |
| --- | --- |
| `desktop_status` | Probe version compatibility, platform, permissions, namespace and input mode |
| `desktop_list` | List apps, windows (with ids), displays, or an app's open surfaces |
| `desktop_snapshot` | Read an app's accessibility tree with refs; `skeleton`, `root`, `surface`, `waitFor` |
| `desktop_find` | Search by role/name/text/value/description/native id/state and get refs |
| `desktop_get` | Read text, value, title, bounds, role or states of a ref |
| `desktop_is` | Boolean visible/enabled/checked/focused/expanded/selected check |
| `desktop_screenshot` | Save a PNG of a window or a display |
| `desktop_click` | Click, right-click, double-click or triple-click a ref |
| `desktop_type` | Type into a ref, or `mode: "set"` to replace its value; text goes over stdin |
| `desktop_select` | Select an option in a list or dropdown |
| `desktop_act` | focus, clear, toggle, check, uncheck, expand, collapse, scroll-to, hover |
| `desktop_scroll` | Scroll a scrollable ref up, down, left or right |
| `desktop_press` | Send a key combo to a named app |
| `desktop_wait` | Wait for an element predicate, text, window, menu, notification, event, or ms |
| `desktop_app` | Launch or close an application |
| `desktop_window` | Focus, resize, move, minimize, maximize or restore a window |
| `desktop_clipboard` | Read, write or clear the clipboard; written text goes over stdin |
| `desktop_command` | Run any other `agent-desktop` command in this session's namespace |

Every ref action (`desktop_click`, `desktop_type`, `desktop_select`, `desktop_act`, `desktop_scroll`) also takes `timeoutMs`, `waitFor` / `waitForGone` (a `role:text` selector to poll for after the action, which returns a fresh snapshot), `waitTimeoutMs`, and `headed`.

Behind `desktop_command`: `list-notifications`, `dismiss-notification`, `dismiss-all-notifications`, `notification-action`, `drag`, `mouse-move`, `mouse-click`, `mouse-wheel`, `open-system-surface`, `batch`, `trace`, `session list`, `cursor-overlay`, `skills`, `permissions`, `sandbox`. It refuses `--session`, `--headed` (pass `headed: true`), `mcp`, and `session end`.

## Environment overrides

- `DA_DESKTOP_HEADED=1` starts sessions with physical input allowed. `/desktop headed on` does the same for one session.
- `DA_DESKTOP_BIN=/path/to/agent-desktop` uses another executable than the one on `PATH`.
- agent-desktop's own `AGENT_DESKTOP_HOME` relocates its state root. `AGENT_DESKTOP_SESSION` is ignored in effect: every call passes `--session`, which wins.

## Operational notes

- Refs look like `@s8f3k2p9:e8` and belong to the snapshot that printed them. da-desktop passes them through unchanged and refuses a bare `@e8` with the fix, instead of qualifying it with the newest snapshot: that guess could land a click on whatever now holds that number.
- A snapshot comes back from the CLI as JSON and reaches the model as an indented tree: `- button "Save" @s8f3k2p9:e8 [focused] {Click,SetFocus}`. Role, name, ref, states, then the actions the element offers (left out when it only clicks), then `value=`, `id=` for an unnamed element's native id, bounds when asked for, and `(+N children)` on a truncated skeleton container.
- `desktop_find` only looks. It returns refs from a snapshot of its own, so use the ref it printed, not one from an earlier `desktop_snapshot`.
- Every command runs with `--session <host>-<hash of the session id>`. Snapshots taken by one pi or Claude Code session are `SNAPSHOT_NOT_FOUND` in another, and in a plain shell.
- A failed command's text starts `agent-desktop <command> failed: <CODE>: <message>` and always carries a `Retry:` line. `safe` means nothing reached the app. `unsafe` and `unknown` mean the input may have landed, and the text tells the model to observe before acting again.
- One automatic retry happens, only for a transient `TIMEOUT` or `APP_UNRESPONSIVE` whose retry the CLI marks safe, after the pause it asks for. A `wait` that timed out, a stale ref, and anything that may have landed are never retried.
- Actions are headless. A command that needs the real pointer (`hover`, `drag`, the `mouse-*` commands, most double-clicks) returns `POLICY_DENIED` until the user allows physical input, and then only for calls that pass `headed: true`.
- A successful action reports its delivery: verified, unverified, or already satisfied. Most accessibility presses are unverified, so the tool text asks for a second look.
- `desktop_press` needs `app` or `windowId`. Without one agent-desktop sends the keys to the focused window, which is usually the user's.
- An app in the background may not open its menus on a click. `desktop_snapshot surface=menubar` lists every menu item with a ref, and a click on the item works without opening the menu.
- `desktop_find` on a large surface such as `menubar` can hit its 5s deadline; raise `timeoutMs` or use a snapshot.
- `desktop_type` reads at most 10,000 bytes and `mode: "set"` 128 KiB, which are agent-desktop's stdin limits.
- The artifact directory is `<tmp>/da-desktop/<cwd-slug>`, mode 700. Snapshot text and screenshots in it are mode 600.
- agent-desktop stores each session namespace's refmaps under `~/.agent-desktop/sessions/<name>`. `agent-desktop session gc` does not remove them, since they are not traced sessions; delete old ones by hand if they bother you.
- The transcript row for a call never shows typed text or clipboard contents. Reading the clipboard shows only its length.

## Skills

`desktop` (`skills/desktop`) is the usage guide: the observe, act, verify loop, skeleton and drill-down for dense apps, menus and sheets, retry rules, and the physical-input policy. agent-desktop also carries its own guides, which match its version exactly: `desktop_command ["skills", "get", "desktop"]` and `["skills", "get", "platform"]`.

## Development

```bash
pnpm install
pnpm check
pnpm test
```

The suite needs neither agent-desktop nor the Accessibility permission: the runner is tested against a scripted CLI.

## Tested behaviour

Checked by hand on macOS 26 (Apple Silicon) with agent-desktop 1.3.1, Accessibility and Screen Recording granted:

| Area | Result |
| --- | --- |
| `desktop_status`, `desktop_list` (apps, windows, displays, surfaces) | Work |
| `desktop_snapshot` (plain, skeleton, `surface=menubar`), `desktop_find`, `desktop_get`, `desktop_is`, `desktop_screenshot` | Work, on Finder, Calculator and TextEdit |
| `desktop_click`, with and without `waitFor` | Works headless; delivery is reported unverified |
| `desktop_type` in both modes, `desktop_act clear` | Work headless on a TextEdit document and read back verified |
| `desktop_press` with `app` | Works on an app that has a focused element; an app with no window returns `ACTION_FAILED`, retry safe |
| `desktop_app` launch and close | Work; close is verified by process exit |
| `desktop_wait` on ms, element, window and text | Works |
| `desktop_window` minimize and restore | The window action is sent, then agent-desktop's read-back of `AXMinimized` times out on Calculator, so the result is a `TIMEOUT` with retry unsafe |
| Clicking a menu-bar title of a background app | Does not open the menu headless; click the menu item's own ref instead |
| Physical input (`headed`), `desktop_select`, `desktop_scroll`, `desktop_clipboard`, `desktop_window` focus/resize/move | Not exercised by hand |
| Windows and Linux | Not run |
