# agent-desktop 1.3.1 reference

## Decision

da-desktop requires agent-desktop **1.3.1** (JSON envelope version 2.6) or newer. It is the release da-desktop was written and tested against, and the minimum is recorded in `src/agent-desktop-version.ts`. Newer versions stay valid; the check runs at session start and before each action.

Everything below was read from the 1.3.1 binary (`agent-desktop <command> --help`, and real output on macOS) and from the docs at the `v1.3.1` tag.

Sources:

- [v1.3.1 release](https://github.com/vercel-labs/agent-desktop/releases/tag/v1.3.1)
- [README at v1.3.1](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/README.md)
- [Docs at v1.3.1](https://github.com/vercel-labs/agent-desktop/tree/v1.3.1/apps/docs/content/docs), published at [agent-browser.dev/desktop](https://agent-browser.dev/desktop)

## What da-desktop relies on

### One JSON envelope per command

```json
{ "version": "2.6", "ok": true, "command": "snapshot", "data": { } }
{ "version": "2.6", "ok": false, "command": "click", "error": { "code": "STALE_REF", "message": "…", "disposition": { "delivery": "not_delivered", "retry": "safe" } } }
```

A failure exits 1 (2 for a parse error) and still prints the envelope on stdout. da-desktop reads the envelope and never the exit code alone (`parseEnvelope`).

Source: [JSON output](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/apps/docs/content/docs/json-output.mdx)

### Snapshot-qualified refs

`snapshot` and `find` give each actionable element a `ref_id` such as `@s8f3k2p9:e8`. The snapshot id is part of the ref, and a bare `@e8` fails with `INVALID_ARGS`. When the UI changes, a ref returns `STALE_REF` or `AMBIGUOUS_TARGET` and is never re-pointed at a look-alike.

da-desktop validates the shape (`normalizeRef`) and passes refs through unchanged.

Source: [Snapshots and refs](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/apps/docs/content/docs/snapshots-and-refs.mdx)

### Session namespaces

`--session <id>` (1 to 64 letters, digits, `-` or `_`) selects an on-disk snapshot namespace. A ref used under a different `--session`, or none, fails with `SNAPSHOT_NOT_FOUND`. An id with no manifest still works as a namespace and writes no trace, so da-desktop never runs `session start`: it passes `--session pi-<hash>` or `cc-<hash>` on every call.

`--session` wins over `AGENT_DESKTOP_SESSION`. `session gc` removes ended or stale traced sessions and leaves manifest-less namespaces in place.

Source: [Sessions](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/apps/docs/content/docs/sessions.mdx)

### Disposition and recovery

Every error, and every action's success, carries `disposition`:

| `delivery` | `retry` | Meaning |
| --- | --- | --- |
| `not_delivered` | `safe` | The input never reached the app |
| `delivery_uncertain` | `unsafe` | It may have landed |
| `delivered_unverified` | `unsafe` | Dispatched, effect not confirmed |
| `delivered_verified` | `unsafe` | Dispatched and read back |
| `unknown` | `unknown` | Nothing established |

`error.recovery` appears only when retry is safe and the code has a plan: `refresh_snapshot_then_retry_original` (`STALE_REF`, `SNAPSHOT_NOT_FOUND`), `inspect_state_then_retry_original` (`TIMEOUT`, `APP_UNRESPONSIVE`, with `retry_after_ms`, 250 in this release), or `request_explicit_policy_then_retry_original` (`POLICY_DENIED`). `details.retryable: false` suppresses it.

da-desktop's one automatic retry is the second strategy only (`autoRetryDelayMs`). The first needs a new snapshot, which is the model's job; the third needs the user.

The 16 error codes: `PERM_DENIED`, `ELEMENT_NOT_FOUND`, `APP_NOT_FOUND`, `ACTION_FAILED`, `ACTION_NOT_SUPPORTED`, `STALE_REF`, `AMBIGUOUS_TARGET`, `WINDOW_NOT_FOUND`, `PLATFORM_NOT_SUPPORTED`, `TIMEOUT`, `INVALID_ARGS`, `NOTIFICATION_NOT_FOUND`, `SNAPSHOT_NOT_FOUND`, `SANDBOX_NOT_FOUND`, `POLICY_DENIED`, `APP_UNRESPONSIVE`, `INTERNAL`.

Source: [Errors and recovery](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/apps/docs/content/docs/errors-and-recovery.mdx)

### Headless by default

Ref actions use the accessibility API without moving the pointer or taking focus. The global `--headed` flag allows physical input. `hover`, `drag`, `mouse-move`, `mouse-click` and `mouse-wheel` require it, and `double-click` usually does. The docs say never to switch to headed mode on your own to get past `POLICY_DENIED`, which is why da-desktop leaves the switch with the user.

Source: [Headed mode](https://github.com/vercel-labs/agent-desktop/blob/v1.3.1/apps/docs/content/docs/guides/headed-mode.mdx)

### `--stdin`

`type` (up to 10,000 bytes), `set-value` and `clipboard-set` (up to 128 KiB) read their text from a pipe with `--stdin`, which keeps it out of process arguments. Batch JSON does appear in arguments, so da-desktop offers no typed batch tool.

### Post-action waits

The global `--wait-for <role:text>` and `--wait-for-gone <role:text>` (with `--wait-timeout`, default 30000) apply to `snapshot` and ref actions. A ref action then returns a fresh snapshot, with the action's own result under `data.after_action` and the selector under `data.matched_selector`.

## Flags by command

Global: `--session`, `--headed`, `-w/--wait-for`, `--wait-for-gone`, `--wait-timeout`, `--agent-id`, `--trace`, `--trace-strict`, `--debug`, `--screenshot <PATH.html>`, `-v`.

| Command | Arguments and flags | Typed tool |
| --- | --- | --- |
| `snapshot` | `--app` `--window-id` `-i` `--compact` `--skeleton` `--root REF` `--surface KIND` `--max-depth N` (10) `--include-bounds` `--timeout-ms` (3000) `--force-electron-a11y` | `desktop_snapshot` |
| `find` | `--app` `--window-id` `--role` `--name` `--value` `--text` `--description` `--native-id` `--exact` `--root` `--surface` `--state TOKEN[=BOOL]` `--timeout-ms` (5000) `--count` `--first` `--last` `--nth N` `--limit N` (50) | `desktop_find` |
| `get` | `REF` `--property text\|value\|title\|bounds\|role\|states` | `desktop_get` |
| `is` | `REF` `--property visible\|enabled\|checked\|focused\|expanded\|selected` | `desktop_is` |
| `screenshot` | `[PATH]` `--app` `--window-id` `--screen N` | `desktop_screenshot` |
| `list-apps` `list-windows` | `--app` `--timeout-ms` | `desktop_list` |
| `list-displays` | none | `desktop_list` |
| `list-surfaces` | `--app` | `desktop_list` |
| `click` `double-click` `triple-click` `right-click` | `REF` `--timeout-ms` (5000) | `desktop_click` |
| `type` | `REF [TEXT]` `--stdin` `--interval-ms` (1-2000) `--timeout-ms` | `desktop_type` |
| `set-value` | `REF [VALUE]` `--stdin` `--timeout-ms` | `desktop_type` mode `set` |
| `select` | `REF VALUE` `--timeout-ms` | `desktop_select` |
| `focus` `clear` `toggle` `check` `uncheck` `expand` `collapse` `scroll-to` | `REF` `--timeout-ms` | `desktop_act` |
| `hover` | `[REF]` `--xy x,y` `--timeout-ms` (headed) | `desktop_act` |
| `scroll` | `REF` `--direction` (down) `--amount` (3) `--timeout-ms` | `desktop_scroll` |
| `press` | `COMBO` `--app` `--window-id` `--force` | `desktop_press` (no `--force`) |
| `wait` | `[MS]` `--element REF` `--predicate exists\|enabled\|visible\|actionable\|value` `--value` `--action` `--window TITLE` `--text` `--count` `--menu` `--menu-closed` `--notification` `--event KIND` `--window-id` `--app` `--timeout` (30000) | `desktop_wait` |
| `launch` | `APP` `--arg` `--env K=V` `--cwd` `--no-attach` `--activate` `--cdp [PORT]` `--timeout` (30000) | `desktop_app` (no env, cwd, cdp) |
| `close-app` | `APP` `--force` | `desktop_app` |
| `focus-window` | `--window-id` `--app` `--title` | `desktop_window` |
| `resize-window` | `--app` `--window-id` `--width` `--height` | `desktop_window` |
| `move-window` | `--app` `--window-id` `--x` `--y` | `desktop_window` |
| `minimize` `maximize` `restore` | `--app` `--window-id` | `desktop_window` |
| `clipboard-get` | `--format text\|auto\|image\|file-urls` `--out PATH` | `desktop_clipboard` |
| `clipboard-set` | `[TEXT]` `--stdin` `--image PATH` `--file-url PATH` | `desktop_clipboard` (text only) |
| `clipboard-clear` | none | `desktop_clipboard` |
| `status` `permissions` `version` | `permissions --request` `--guide` | `desktop_status` |
| `drag` `mouse-move` `mouse-click` `mouse-wheel` | coordinates and refs (headed) | `desktop_command` |
| `list-notifications` `dismiss-notification` `dismiss-all-notifications` `notification-action` | `--app` `--text` `--limit`, `INDEX` with `--expected-app` / `--expected-title` | `desktop_command` |
| `open-system-surface` | `--surface KIND` | `desktop_command` |
| `batch` | `JSON` `--stop-on-error` `--timeout-ms` (60000) | `desktop_command` |
| `session` `trace` `cursor-overlay` `sandbox` `skills` | subcommands | `desktop_command` |
| `key-down` `key-up` `mouse-down` `mouse-up` | refuse to run without a daemon | none |
| `mcp` | serves every command over stdio | refused |

Negative numbers take the `=` form (`--x=-100`), which is what da-desktop always emits for window positions.

## Payload shapes da-desktop parses

| Command | `data` |
| --- | --- |
| `snapshot` | `{app, snapshot_id, ref_count, complete, tree}`; a node has `role`, and when present `name`, `value`, `ref_id`, `states`, `available_actions`, `native_id`, `bounds`, `children`, `children_count` |
| `find` | `{matches: [{role, name, ref_id, states, value, path, interactive}], snapshot_id, total_matches, truncated}`; `{match, snapshot_id}` for `--first`/`--last`/`--nth`; `{count}` for `--count` |
| `get` | `{property, ref, value}` |
| `is` | `{property, ref, result, applicable}` |
| `screenshot` | `{path, width, height, format, scale_factor}`; the file is written mode 600 |
| `list-apps` | `{apps: [{name, pid, bundle_id, presentation, process_instance}]}` |
| `list-windows` | `[{id, app_name, title, bounds, is_focused, minimized, visible, accessible, pid}]` |
| `list-displays` | `[{id, bounds, scale, is_primary}]` |
| `list-surfaces` | `{pid, surfaces: [{id, type, title, item_count}]}` |
| ref actions, `press`, window actions, `close-app` | `{action, disposition, steps: [{label, mechanism, outcome, verified}], details}` |
| `launch` | `{app, pid, window}` |
| `wait` | `{waited_ms}` for a plain wait; `{found, …}` otherwise |
| `clipboard-get` | `{type: "text", text}`, `{type: "image", path, width, height}`, `{type: "file_urls", file_urls}`, or `{found: false, type}` |
| `status` | `{version, platform, permissions: {accessibility: {state}, screen_recording: {state}, automation: {state}}, supported_surfaces, state_root, session_id, tracing}` |

## Not wrapped

- `agent-desktop mcp`, the CLI's own MCP server. It exposes every command as a `desktop_*` tool and returns raw envelopes. da-desktop wraps the CLI instead, for text trees, private artifacts, a per-session namespace, the physical-input gate, and the same tools in pi.
- Traced sessions (`session start`), the cursor overlay, and sandboxes. They are reachable through `desktop_command`.
- The C library.
