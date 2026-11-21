---
name: desktop
description: See and operate desktop apps with da-desktop's desktop_* tools, which read the OS accessibility tree through agent-desktop. Use for "open <app> and…", "click … in <app>", "what does <app> show", "fill in this dialog", "change a setting in System Settings", "take a screenshot of the window", "use the Finder / Calculator / Xcode / Mail app", or any task in a native desktop app that has no API or CLI. Not for websites: use a browser tool for those.
compatibility: Needs the da-desktop extension (this package), agent-desktop 1.3.1 or newer on PATH, and on macOS the Accessibility permission for the app that runs the agent.
---

# Desktop

Drive the user's own desktop apps through their accessibility tree. No screenshots or pixel coordinates are needed for most work: every element you can act on has a ref.

## The loop

1. **Observe.** `desktop_snapshot app=<name>` returns the app's interactive elements as a tree:

   ```text
   Calculator · snapshot s21nz0od1aqhoj · 26 refs
   - window "Calculator"
     - group
       - button "7" @s21nz0od1aqhoj:e6 {Click,SetFocus}
       - button "Add" @s21nz0od1aqhoj:e17 {Click,SetFocus}
   ```

   A line is role, name, ref, `[states]`, `{actions it offers}`.
2. **Act** on a ref: `desktop_click`, `desktop_type`, `desktop_select`, `desktop_act`, `desktop_scroll`.
3. **Observe again.** Most actions report "effect not verified". Check with a new snapshot, `desktop_get` or `desktop_is`, or pass `waitFor: "role:text"` on the action to get a fresh snapshot once the expected element appears.

If the app is not running, start it with `desktop_app action=launch`. If you do not know its exact name, `desktop_list what=apps`.

## Refs

- Copy a ref exactly, snapshot id included: `@s21nz0od1aqhoj:e6`. A bare `@e6` is refused.
- A ref belongs to the snapshot that printed it. `desktop_find` takes a snapshot of its own, so use the ref it returned.
- `STALE_REF`, `SNAPSHOT_NOT_FOUND` or `AMBIGUOUS_TARGET` means the UI moved on. Snapshot again and use the new ref. Never reuse an old ref by changing its number.

## Dense apps

A full tree of Slack, Xcode or a browser is large. Map first, then drill in:

1. `desktop_snapshot app=Slack skeleton=true` gives a shallow overview. Containers that were cut show `(+N children)`.
2. `desktop_snapshot root=<that container's ref>` reads one region.

When you know what you are looking for, `desktop_find role=button name=Send` is cheaper than either. Add `exact=true` when a loose match returns too much.

## Windows, menus, sheets

- Several windows give `AMBIGUOUS_TARGET`. Get ids from `desktop_list what=windows app=<name>` and pass `windowId`.
- Menus: `desktop_snapshot app=<name> surface=menubar` lists every menu item with a ref, and clicking an item works without opening its menu first. This is the reliable way to run a menu command in an app that is not in front.
- An open sheet, popover, alert or context menu is its own surface: `desktop_list what=surfaces app=<name>` shows what is open, then `desktop_snapshot surface=sheet` (or `alert`, `popover`, `menu`).
- A dialog that blocks the app shows up in a plain snapshot as `dialog "alert" [focused, modal]`. Deal with it before anything else.

## Typing and keys

- `desktop_type ref=… text=…` inserts at the caret. `mode=set` replaces the whole value and suits long text.
- `desktop_act action=clear` empties a field.
- `desktop_press combo=cmd+s app=<name>` sends a shortcut to that app. It needs `app` or `windowId`. An app with no focused element refuses keys: use its menu item instead.
- Use `cmd` on macOS and `ctrl` on Windows and Linux.

## Retry rules

Every failure ends with a `Retry:` line. Follow it.

- **safe**: nothing reached the app. Fix the cause (new ref, right window, correct argument) and repeat.
- **unsafe** or **unknown**: the input may have landed. Look first with `desktop_snapshot`, `desktop_get` or `desktop_is`, then decide. A repeated click can submit a form twice, and a repeated toggle undoes itself.

`ACTION_NOT_SUPPORTED` means the element does not offer that action. Check the `{…}` list on its snapshot line and pick another element or tool. Prefer `desktop_act action=check` or `uncheck` over `toggle`: they are idempotent.

## Waiting

Use `desktop_wait` rather than sleeping: `element=<ref> predicate=actionable`, `text="Saved" app=<name>`, `window="Export"`, `menu=open`, or `event=window-opened`. Plain `ms` is the last resort.

## Physical input

Actions are headless: the pointer does not move and the user's window keeps focus. `POLICY_DENIED` means the action needs real pointer or keyboard input (hover, drag, most double-clicks, coordinates).

Only the user can allow that, with `/desktop headed on`. Do not try to get around it. Either find an accessibility route (a menu item, a button, `mode=set`), or tell the user what needs physical input and why, and let them decide. Once allowed, pass `headed: true` on the call that needs it, and expect their pointer to move.

## Privacy and care

- This is the user's desktop, signed in as them. Do only what they asked.
- Snapshots, screenshots and the clipboard can hold private content. Use what the task needs and do not quote the rest back or copy it elsewhere.
- Read the clipboard only when the task calls for it.
- `desktop_app action=close force=true` loses unsaved work. Quit gracefully first.
- `desktop_window action=focus` puts a window in front of what the user is doing. Use it only when the task needs it.

## When the tree is not enough

Some apps (canvas editors, games, some Electron apps) expose little. Raise `timeoutMs` on the snapshot for a slow Electron app, try `interactiveOnly=false` to see static text, and take a `desktop_screenshot` to see what is on screen. Clicking by coordinate (`desktop_command ["mouse-click", "--xy", "x,y"]`) needs physical input.

## More

- `desktop_status` when something looks wrong: it reports the CLI version, permissions and input mode.
- agent-desktop's own guides match its version: `desktop_command ["skills", "get", "desktop"]` and `["skills", "get", "platform"]`.
- Anything without a typed tool goes through `desktop_command`: notifications, drag, `open-system-surface`, traces.
