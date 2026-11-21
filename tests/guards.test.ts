import assert from "node:assert/strict";
import test from "node:test";

import {
  buildActArgs,
  buildAppArgs,
  buildClickArgs,
  buildClipboardArgs,
  buildFindArgs,
  buildGetArgs,
  buildInvocationArgs,
  buildIsArgs,
  buildListArgs,
  buildPressArgs,
  buildScreenshotArgs,
  buildScrollArgs,
  buildSelectArgs,
  buildSnapshotArgs,
  buildTypeArgs,
  buildWaitArgs,
  buildWindowArgs,
  commandOf,
  desktopSessionName,
  drivesAgentDesktop,
  normalizeCommandArgs,
  normalizeRef,
} from "../src/agent-desktop-args.ts";
import {
  autoRetryDelayMs,
  DesktopError,
  formatApps,
  formatDisplays,
  formatFind,
  formatNode,
  formatSnapshot,
  formatSurfaces,
  formatTree,
  formatValue,
  formatWindows,
  parseEnvelope,
  readAction,
  readDisposition,
  readIsResult,
  readPermissions,
  type Envelope,
} from "../src/agent-desktop-output.ts";
import { extractAgentDesktopVersion, supportsAgentDesktopVersion } from "../src/agent-desktop-version.ts";
import { prepareCompatArguments } from "../src/extension-utils.ts";

const REF = "@s8f3k2p9:e8";
const SESSION = "c2804a12-b277-4e01-a9bf-a1bb9b87f70f";

// Envelopes below are agent-desktop 1.3.1's own output, trimmed.
const envelope = (json: string): Envelope => parseEnvelope(json)!;

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

test("the version is read from --version and from the version envelope", () => {
  assert.equal(extractAgentDesktopVersion("agent-desktop 1.3.1"), "1.3.1");
  assert.equal(extractAgentDesktopVersion("agent-desktop v2.0.0-beta.1\n"), "2.0.0-beta.1");
  assert.equal(
    extractAgentDesktopVersion('{"version":"2.6","ok":true,"command":"version","data":{"os":"macos","target":"aarch64","version":"1.3.1"}}'),
    "1.3.1",
  );
  assert.equal(extractAgentDesktopVersion("command not found: agent-desktop"), undefined);
});

test("the minimum version is enforced and newer releases stay valid", () => {
  assert.equal(supportsAgentDesktopVersion("1.3.1"), true);
  assert.equal(supportsAgentDesktopVersion("1.3.0"), false);
  assert.equal(supportsAgentDesktopVersion("1.2.9"), false);
  assert.equal(supportsAgentDesktopVersion("1.4.0"), true);
  assert.equal(supportsAgentDesktopVersion("2.0.0"), true);
  assert.equal(supportsAgentDesktopVersion("1.3.1-rc.1"), false);
  assert.equal(supportsAgentDesktopVersion("garbage"), false);
});

// ---------------------------------------------------------------------------
// Refs and the session namespace
// ---------------------------------------------------------------------------

test("refs must be snapshot-qualified", () => {
  assert.equal(normalizeRef(REF), REF);
  assert.equal(normalizeRef("  s8f3k2p9:e8 "), REF);
  for (const bare of ["@e8", "e8", "", "@s8f3k2p9", "@s8f3k2p9:e", "--help", undefined, 8]) {
    assert.throws(() => normalizeRef(bare), /snapshot-qualified/, String(bare));
  }
});

test("every invocation runs in the host session's namespace", () => {
  const name = desktopSessionName(SESSION);
  assert.match(name, /^pi-[0-9a-f]{16}$/);
  assert.equal(desktopSessionName(SESSION, "cc"), name.replace(/^pi/, "cc"));
  assert.notEqual(desktopSessionName("another-session"), name);
  assert.deepEqual(buildInvocationArgs(["status"], SESSION), ["--session", name, "status"]);
});

test("headed and post-action waits are global flags placed before the command", () => {
  const name = desktopSessionName(SESSION, "cc");
  assert.deepEqual(buildInvocationArgs(["click", REF], SESSION, "cc", { headed: true, waitFor: "button:Save", waitTimeoutMs: 4000 }), [
    "--session", name, "--headed", "--wait-for", "button:Save", "--wait-timeout", "4000", "click", REF,
  ]);
  assert.deepEqual(buildInvocationArgs(["click", REF], SESSION, "cc", { waitForGone: "sheet:Save" }).slice(2, 4), ["--wait-for-gone", "sheet:Save"]);
  // A wait timeout without a wait selector would be a stray flag.
  assert.deepEqual(buildInvocationArgs(["click", REF], SESSION, "cc", { waitTimeoutMs: 4000 }), ["--session", name, "click", REF]);
  assert.throws(() => buildInvocationArgs(["click", REF], SESSION, "pi", { waitFor: "a:b", waitForGone: "c:d" }), /not both/);
});

// ---------------------------------------------------------------------------
// Argument builders
// ---------------------------------------------------------------------------

test("snapshot args", () => {
  assert.deepEqual(buildSnapshotArgs({}), ["snapshot"]);
  assert.deepEqual(buildSnapshotArgs({ app: "Finder", interactiveOnly: true, compact: true }), ["snapshot", "--app", "Finder", "-i", "--compact"]);
  assert.deepEqual(
    buildSnapshotArgs({ app: "Slack", windowId: "w-17009", skeleton: true, root: REF, surface: "menu", maxDepth: 4, includeBounds: true, timeoutMs: 8000 }),
    ["snapshot", "--app", "Slack", "--window-id", "w-17009", "--skeleton", "--root", REF, "--surface", "menu", "--max-depth", "4", "--include-bounds", "--timeout-ms", "8000"],
  );
  assert.throws(() => buildSnapshotArgs({ root: "@e3" }), /snapshot-qualified/);
  assert.throws(() => buildSnapshotArgs({ maxDepth: -1 }), /maxDepth/);
});

test("find args need a criterion and pick one result shape", () => {
  assert.deepEqual(buildFindArgs({ app: "Finder", role: "button", name: "Eject", exact: true }), [
    "find", "--app", "Finder", "--role", "button", "--name", "Eject", "--exact",
  ]);
  assert.deepEqual(buildFindArgs({ text: "Save", states: ["enabled", "offscreen=false"], pick: "first" }), [
    "find", "--text", "Save", "--state", "enabled", "--state", "offscreen=false", "--first",
  ]);
  assert.deepEqual(buildFindArgs({ nativeId: "Delete", nth: 2, limit: 0, root: REF }), ["find", "--native-id", "Delete", "--root", REF, "--nth", "2", "--limit", "0"]);
  assert.deepEqual(buildFindArgs({ role: "button", pick: "count" }).at(-1), "--count");
  assert.throws(() => buildFindArgs({ app: "Finder" }), /at least one of/);
  assert.throws(() => buildFindArgs({ role: "button", pick: "first", nth: 1 }), /not both/);
});

test("get, is and screenshot args", () => {
  assert.deepEqual(buildGetArgs(REF), ["get", REF, "--property", "text"]);
  assert.deepEqual(buildGetArgs(REF, "bounds"), ["get", REF, "--property", "bounds"]);
  assert.throws(() => buildGetArgs(REF, "html"), /property must be one of/);
  assert.deepEqual(buildIsArgs(REF, "enabled"), ["is", REF, "--property", "enabled"]);
  assert.throws(() => buildIsArgs(REF, "clickable"), /property must be one of/);
  assert.deepEqual(buildScreenshotArgs({ file: "/tmp/a.png", app: "Finder" }), ["screenshot", "--app", "Finder", "/tmp/a.png"]);
  assert.deepEqual(buildScreenshotArgs({ file: "/tmp/a.png", screen: 0 }), ["screenshot", "--screen", "0", "/tmp/a.png"]);
  assert.throws(() => buildScreenshotArgs({ file: "/tmp/a.png", screen: 0, app: "Finder" }), /not both/);
});

test("click kinds map to their commands", () => {
  assert.deepEqual(buildClickArgs(REF), ["click", REF]);
  assert.deepEqual(buildClickArgs(REF, "double"), ["double-click", REF]);
  assert.deepEqual(buildClickArgs(REF, "triple"), ["triple-click", REF]);
  assert.deepEqual(buildClickArgs(REF, "right", 2000), ["right-click", REF, "--timeout-ms", "2000"]);
  assert.throws(() => buildClickArgs(REF, "middle" as never), /kind must be one of/);
});

test("typed text travels on stdin, never in the arguments", () => {
  const secret = "hunter2 --force";
  const typed = buildTypeArgs({ ref: REF, text: secret });
  assert.deepEqual(typed, { args: ["type", REF, "--stdin"], stdin: secret });
  const set = buildTypeArgs({ ref: REF, text: secret, mode: "set", timeoutMs: 1000 });
  assert.deepEqual(set, { args: ["set-value", REF, "--stdin", "--timeout-ms", "1000"], stdin: secret });
  const clipboard = buildClipboardArgs({ action: "set", text: secret });
  assert.deepEqual(clipboard, { args: ["clipboard-set", "--stdin"], stdin: secret });
  for (const command of [typed, set, clipboard]) assert.ok(!command.args.join(" ").includes("hunter2"));
});

test("type enforces agent-desktop's stdin limits and interval range", () => {
  assert.deepEqual(buildTypeArgs({ ref: REF, text: "hi", intervalMs: 40 }).args, ["type", REF, "--stdin", "--interval-ms", "40"]);
  assert.throws(() => buildTypeArgs({ ref: REF, text: "hi", intervalMs: 0 }), /between 1 and 2000/);
  assert.throws(() => buildTypeArgs({ ref: REF, text: "hi", mode: "set", intervalMs: 40 }), /only applies to mode type/);
  assert.throws(() => buildTypeArgs({ ref: REF, text: "x".repeat(10_001) }), /at most 10000.*mode set/);
  assert.equal(buildTypeArgs({ ref: REF, text: "x".repeat(10_001), mode: "set" }).stdin.length, 10_001);
  assert.throws(() => buildTypeArgs({ ref: REF, text: "x".repeat(128 * 1024 + 1), mode: "set" }), /at most 131072/);
  // The limit is bytes, not characters.
  assert.throws(() => buildTypeArgs({ ref: REF, text: "é".repeat(5_001) }), /10002 bytes/);
  assert.throws(() => buildTypeArgs({ ref: REF, text: undefined as never }), /requires text/);
});

test("select, act and scroll args", () => {
  assert.deepEqual(buildSelectArgs(REF, "Large"), ["select", REF, "Large"]);
  assert.throws(() => buildSelectArgs(REF, ""), /requires option/);
  assert.deepEqual(buildActArgs(REF, "check"), ["check", REF]);
  assert.deepEqual(buildActArgs(REF, "scroll-to", 500), ["scroll-to", REF, "--timeout-ms", "500"]);
  assert.throws(() => buildActArgs(REF, "delete" as never), /action must be one of/);
  assert.deepEqual(buildScrollArgs(REF, "down"), ["scroll", REF, "--direction", "down"]);
  assert.deepEqual(buildScrollArgs(REF, "left", 5), ["scroll", REF, "--direction", "left", "--amount", "5"]);
  assert.throws(() => buildScrollArgs(REF, "sideways" as never), /direction must be/);
  assert.throws(() => buildScrollArgs(REF, "up", 0), /positive integer/);
});

test("press args", () => {
  assert.deepEqual(buildPressArgs({ combo: "cmd+s", app: "TextEdit" }), ["press", "cmd+s", "--app", "TextEdit"]);
  assert.deepEqual(buildPressArgs({ combo: " escape ", windowId: "w-1" }), ["press", "escape", "--window-id", "w-1"]);
  assert.throws(() => buildPressArgs({ combo: "" }), /requires combo/);
  assert.throws(() => buildPressArgs({ combo: "--force" }), /Invalid key combo/);
});

test("wait takes exactly one mode", () => {
  assert.deepEqual(buildWaitArgs({ ms: 250.4 }), ["wait", "250"]);
  assert.deepEqual(buildWaitArgs({ element: REF, predicate: "actionable", action: "type", timeoutMs: 5000 }), [
    "wait", "--element", REF, "--predicate", "actionable", "--action", "type", "--timeout", "5000",
  ]);
  assert.deepEqual(buildWaitArgs({ element: REF, predicate: "value", value: "42" }), ["wait", "--element", REF, "--predicate", "value", "--value", "42"]);
  assert.deepEqual(buildWaitArgs({ text: "Saved", count: 1, app: "TextEdit" }), ["wait", "--text", "Saved", "--count", "1", "--app", "TextEdit"]);
  assert.deepEqual(buildWaitArgs({ window: "Untitled" }), ["wait", "--window", "Untitled"]);
  assert.deepEqual(buildWaitArgs({ menu: "open" }), ["wait", "--menu"]);
  assert.deepEqual(buildWaitArgs({ menu: "closed" }), ["wait", "--menu-closed"]);
  // text filters a notification wait, and window narrows an event wait, instead of adding a mode.
  assert.deepEqual(buildWaitArgs({ notification: true, text: "Build done" }), ["wait", "--notification", "--text", "Build done"]);
  assert.deepEqual(buildWaitArgs({ event: "window-opened", window: "Save", windowId: "w-2" }), [
    "wait", "--event", "window-opened", "--window", "Save", "--window-id", "w-2",
  ]);
  assert.throws(() => buildWaitArgs({}), /exactly one of.*got none/);
  assert.throws(() => buildWaitArgs({ ms: 100, text: "x" }), /exactly one of.*ms, text/);
  assert.throws(() => buildWaitArgs({ event: "window-exploded" }), /event must be one of/);
  assert.throws(() => buildWaitArgs({ element: REF, predicate: "value" }), /needs the expected value/);
  assert.throws(() => buildWaitArgs({ element: "@e1" }), /snapshot-qualified/);
});

test("app args", () => {
  assert.deepEqual(buildAppArgs({ action: "launch", app: "Calculator" }), ["launch", "Calculator"]);
  // --arg=<value> keeps an app argument that starts with a dash from parsing as a flag.
  assert.deepEqual(buildAppArgs({ action: "launch", app: "TextEdit", args: ["--new", "/tmp/a.txt"], activate: true, newInstance: true, timeoutMs: 9000 }), [
    "launch", "TextEdit", "--arg=--new", "--arg=/tmp/a.txt", "--activate", "--no-attach", "--timeout", "9000",
  ]);
  assert.deepEqual(buildAppArgs({ action: "close", app: "Calculator" }), ["close-app", "Calculator"]);
  assert.deepEqual(buildAppArgs({ action: "close", app: "Calculator", force: true }), ["close-app", "Calculator", "--force"]);
  assert.throws(() => buildAppArgs({ action: "launch", app: " " }), /requires app/);
  assert.throws(() => buildAppArgs({ action: "launch", app: "--force" }), /Invalid app name/);
});

test("window args", () => {
  assert.deepEqual(buildWindowArgs({ action: "focus", app: "Finder", title: "Downloads" }), ["focus-window", "--app", "Finder", "--title", "Downloads"]);
  assert.deepEqual(buildWindowArgs({ action: "focus", title: "Downloads" }), ["focus-window", "--title", "Downloads"]);
  assert.deepEqual(buildWindowArgs({ action: "resize", windowId: "w-1", width: 800.4, height: 600 }), ["resize-window", "--window-id", "w-1", "--width", "800", "--height", "600"]);
  // The = form is how a negative coordinate gets through.
  assert.deepEqual(buildWindowArgs({ action: "move", app: "Finder", x: -100, y: 40 }), ["move-window", "--app", "Finder", "--x=-100", "--y=40"]);
  assert.deepEqual(buildWindowArgs({ action: "minimize", app: "Finder" }), ["minimize", "--app", "Finder"]);
  assert.deepEqual(buildWindowArgs({ action: "restore", windowId: "w-1" }), ["restore", "--window-id", "w-1"]);
  assert.throws(() => buildWindowArgs({ action: "maximize" }), /needs app or windowId/);
  assert.throws(() => buildWindowArgs({ action: "resize", app: "Finder", width: 800 }), /positive width and height/);
  assert.throws(() => buildWindowArgs({ action: "move", app: "Finder", x: 1 }), /needs x and y/);
});

test("list and clipboard args", () => {
  assert.deepEqual(buildListArgs("apps"), ["list-apps"]);
  assert.deepEqual(buildListArgs("windows", "Finder"), ["list-windows", "--app", "Finder"]);
  assert.deepEqual(buildListArgs("displays", "Finder"), ["list-displays"]);
  assert.deepEqual(buildListArgs("surfaces", "Finder"), ["list-surfaces", "--app", "Finder"]);
  assert.throws(() => buildListArgs("surfaces"), /needs app/);
  assert.deepEqual(buildClipboardArgs({ action: "get" }), { args: ["clipboard-get"] });
  assert.deepEqual(buildClipboardArgs({ action: "get", format: "image", out: "/tmp/c.png" }), { args: ["clipboard-get", "--format", "image", "--out", "/tmp/c.png"] });
  assert.deepEqual(buildClipboardArgs({ action: "get", format: "file-urls", out: "/tmp/c.png" }), { args: ["clipboard-get", "--format", "file-urls"] });
  assert.deepEqual(buildClipboardArgs({ action: "clear" }), { args: ["clipboard-clear"] });
  assert.throws(() => buildClipboardArgs({ action: "set" }), /requires text/);
  assert.throws(() => buildClipboardArgs({ action: "get", format: "html" }), /format must be one of/);
});

// ---------------------------------------------------------------------------
// Passthrough and the Bash guard
// ---------------------------------------------------------------------------

test("commandOf steps over global flags and their values", () => {
  assert.equal(commandOf(["snapshot", "--app", "Finder"]), "snapshot");
  assert.equal(commandOf(["--trace", "/tmp/t.jsonl", "-v", "click", REF]), "click");
  assert.equal(commandOf(["--wait-for", "button:Save", "click", REF]), "click");
  assert.equal(commandOf(["--help"]), undefined);
});

test("desktop_command keeps the namespace and the headed policy to itself", () => {
  assert.deepEqual(normalizeCommandArgs(["list-notifications", "--limit", "5"]), ["list-notifications", "--limit", "5"]);
  assert.throws(() => normalizeCommandArgs([]), /at least one/);
  assert.throws(() => normalizeCommandArgs(["click", 5]), /must be strings/);
  assert.throws(() => normalizeCommandArgs(["click", ""]), /empty strings/);
  assert.throws(() => normalizeCommandArgs(["--session", "other", "snapshot"]), /omit --session/);
  assert.throws(() => normalizeCommandArgs(["--session=other", "snapshot"]), /omit --session/);
  assert.throws(() => normalizeCommandArgs(["--headed", "hover", REF]), /headed=true instead/);
  assert.throws(() => normalizeCommandArgs(["mcp"]), /long-lived stdio server/);
  assert.throws(() => normalizeCommandArgs(["session", "end"]), /cannot end the session/);
  assert.deepEqual(normalizeCommandArgs(["session", "list"]), ["session", "list"]);
});

test("the Bash guard refuses raw desktop control and lets informational commands through", () => {
  for (const command of [
    "agent-desktop snapshot --app Finder -i",
    "agent-desktop click @s8f3k2p9:e8",
    "agent-desktop --headed mouse-click --xy 10,10",
    "npx -y agent-desktop@1.3.1 clipboard-get",
    "npx agent-desktop screenshot /tmp/a.png",
    "pnpm dlx agent-desktop type @s1:e1 hello",
    "./node_modules/.bin/agent-desktop list-windows",
    "cd /tmp && agent-desktop press cmd+q --app Finder",
    "AGENT_DESKTOP_SESSION=x agent-desktop snapshot",
    "agent-desktop --session other snapshot --app Mail",
    "echo hi; agent-desktop batch '[]'",
    "agent-desktop status && agent-desktop snapshot --app Notes",
    "agent-desktop mcp",
  ]) {
    assert.equal(drivesAgentDesktop(command), true, command);
  }
  for (const command of [
    "agent-desktop --version",
    "agent-desktop -V",
    "agent-desktop version",
    "agent-desktop status",
    "agent-desktop permissions --guide",
    "agent-desktop skills get desktop",
    "agent-desktop --help",
    "agent-desktop click --help",
    "agent-desktop",
    "npx -y agent-desktop@1.3.1 --version",
    "npm install -g agent-desktop@latest",
    "brew install agent-desktop",
    "which agent-desktop",
    'git commit -m "wrap agent-desktop snapshot output"',
    "echo agent-desktop click @s1:e1",
    "grep -r agent-desktop src/",
    "cat docs/agent-desktop-v1.3.1.md",
    "ls",
  ]) {
    assert.equal(drivesAgentDesktop(command), false, command);
  }
});

// ---------------------------------------------------------------------------
// Envelopes, errors and retries
// ---------------------------------------------------------------------------

const STALE = `{"version":"2.6","ok":false,"command":"get","error":{"code":"SNAPSHOT_NOT_FOUND","message":"Snapshot 's15iiu53bt23ii' not found","suggestion":"Re-run a snapshot and retry","recovery":{"strategy":"refresh_snapshot_then_retry_original","retryable":true,"requires_fresh_snapshot":true},"disposition":{"delivery":"not_delivered","retry":"safe"}}}`;
const WAIT_TIMEOUT = `{"version":"2.6","ok":false,"command":"wait","error":{"code":"TIMEOUT","message":"Text (6 chars) did not match within 300ms","recovery":{"strategy":"inspect_state_then_retry_original","retryable":true,"requires_fresh_snapshot":true,"retry_after_ms":250},"details":{"kind":"wait_timeout","predicate":"text","timeout_ms":300},"disposition":{"delivery":"not_delivered","retry":"safe"}}}`;
const FOCUS_FAILED = `{"version":"2.6","ok":false,"command":"focus-window","error":{"code":"ACTION_FAILED","message":"Window focus did not settle on the requested window","suggestion":"Run 'list-windows' to refresh window IDs, then retry.","disposition":{"delivery":"unknown","retry":"unknown"}}}`;
const POLICY = `{"version":"2.6","ok":false,"command":"hover","error":{"code":"POLICY_DENIED","message":"hover moves the cursor and is disabled in headless mode","suggestion":"enable physical interaction in the policy (CLI: --headed)","recovery":{"strategy":"request_explicit_policy_then_retry_original","retryable":true,"requires_fresh_snapshot":false},"disposition":{"delivery":"not_delivered","retry":"safe"}}}`;
const timeout = (overrides: Record<string, unknown> = {}, command = "click"): Envelope =>
  envelope(
    JSON.stringify({
      version: "2.6",
      ok: false,
      command,
      error: {
        code: "TIMEOUT",
        message: "Target did not become actionable",
        recovery: { strategy: "inspect_state_then_retry_original", retryable: true, requires_fresh_snapshot: true, retry_after_ms: 250 },
        details: { kind: "actionability_timeout" },
        disposition: { delivery: "not_delivered", retry: "safe" },
        ...overrides,
      },
    }),
  );

test("parseEnvelope reads success and failure, and ignores anything else", () => {
  const ok = envelope('{"version":"2.6","ok":true,"command":"wait","data":{"waited_ms":50}}');
  assert.deepEqual(ok, { ok: true, command: "wait", version: "2.6", data: { waited_ms: 50 } });
  const failed = envelope(STALE);
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.error.code, "SNAPSHOT_NOT_FOUND");
    assert.deepEqual(failed.error.disposition, { delivery: "not_delivered", retry: "safe" });
    assert.deepEqual(failed.error.recovery, { strategy: "refresh_snapshot_then_retry_original", retryable: true, requiresFreshSnapshot: true, retryAfterMs: undefined });
  }
  // Log noise before the envelope is stepped over.
  assert.equal(parseEnvelope('warning: slow\n{"ok":true,"command":"status","data":{}}')?.ok, true);
  assert.equal(parseEnvelope(""), undefined);
  assert.equal(parseEnvelope("agent-desktop 1.3.1"), undefined);
  assert.equal(parseEnvelope('{"truncated":'), undefined);
  assert.equal(parseEnvelope('{"data":{}}'), undefined);
});

test("a missing disposition is unknown, never safe", () => {
  assert.deepEqual(readDisposition(undefined), { delivery: "unknown", retry: "unknown" });
  assert.deepEqual(readDisposition({ delivery: "delivered_verified", retry: "unsafe" }), { delivery: "delivered_verified", retry: "unsafe" });
  assert.deepEqual(readDisposition({ delivery: "not_delivered", retry: "maybe" }), { delivery: "not_delivered", retry: "unknown" });
  const bare = envelope('{"ok":false,"command":"click","error":{"code":"INTERNAL","message":"boom"}}');
  assert.equal(!bare.ok && bare.error.disposition.retry, "unknown");
});

test("a failure tells the model the code, the next step and whether a retry is safe", () => {
  const stale = envelope(STALE);
  assert.ok(!stale.ok);
  const error = new DesktopError(stale.command, stale.error);
  assert.equal(error.code, "SNAPSHOT_NOT_FOUND");
  assert.equal(error.disposition.retry, "safe");
  const [first, next, retry] = error.message.split("\n");
  assert.equal(first, "agent-desktop get failed: SNAPSHOT_NOT_FOUND: Snapshot 's15iiu53bt23ii' not found");
  assert.match(next!, /^Next: .*new desktop_snapshot/);
  assert.match(retry!, /^Retry: safe\./);

  const focus = envelope(FOCUS_FAILED);
  assert.ok(!focus.ok);
  const unknown = new DesktopError(focus.command, focus.error).message;
  assert.match(unknown, /^Retry: unknown\. .*Observe first/m);
  // The CLI's "then retry" suggestion is dropped once the input may have landed.
  assert.doesNotMatch(unknown, /Next:|then retry/);
  // A code with no hint of its own keeps the CLI's suggestion while a retry is safe.
  const safe = envelope(WAIT_TIMEOUT.replace('"recovery"', '"suggestion":"The target application may be busy","recovery"'));
  assert.ok(!safe.ok);
  assert.match(new DesktopError(safe.command, safe.error).message, /^Next: The target application may be busy$/m);

  const policy = envelope(POLICY);
  assert.ok(!policy.ok);
  assert.match(new DesktopError(policy.command, policy.error).message, /only the user|ask the user to allow it with \/desktop headed on/);
});

test("error details keep the cause and drop the CLI's statistics", () => {
  const noisy = envelope(
    `{"ok":false,"command":"find","error":{"code":"TIMEOUT","message":"Locator traversal returned incomplete evidence","details":{"kind":"locator_incomplete","observed_matches":0,"query_stats":{"reads":{"child_reads":840}},"retryable":false},"disposition":{"delivery":"not_delivered","retry":"safe"}}}`,
  );
  assert.ok(!noisy.ok);
  const message = new DesktopError(noisy.command, noisy.error).message;
  assert.match(message, /Details: \{"kind":"locator_incomplete","observed_matches":0,"retryable":false\}/);
  assert.doesNotMatch(message, /query_stats|child_reads/);
});

test("an automatic retry happens only where the CLI declares one safe", () => {
  assert.equal(autoRetryDelayMs(timeout()), 250);
  assert.equal(autoRetryDelayMs(timeout({ code: "APP_UNRESPONSIVE" })), 250);
  assert.equal(autoRetryDelayMs(timeout({ recovery: { strategy: "inspect_state_then_retry_original", retryable: true } })), 250);
  assert.equal(autoRetryDelayMs(timeout({ recovery: { strategy: "inspect_state_then_retry_original", retryable: true, retry_after_ms: 60_000 } })), 2000);

  // Anything that may have reached the app is never repeated.
  assert.equal(autoRetryDelayMs(timeout({ disposition: { delivery: "delivery_uncertain", retry: "unsafe" } })), undefined);
  assert.equal(autoRetryDelayMs(timeout({ disposition: { delivery: "unknown", retry: "unknown" } })), undefined);
  assert.equal(autoRetryDelayMs(timeout({ disposition: undefined })), undefined);
  assert.equal(autoRetryDelayMs(envelope(FOCUS_FAILED)), undefined);
  // Safe, but repeating cannot help: the caller must change something first.
  assert.equal(autoRetryDelayMs(envelope(STALE)), undefined);
  assert.equal(autoRetryDelayMs(envelope(POLICY)), undefined);
  assert.equal(autoRetryDelayMs(envelope(WAIT_TIMEOUT)), undefined);
  assert.equal(autoRetryDelayMs(timeout({}, "wait")), undefined);
  assert.equal(autoRetryDelayMs(timeout({ details: { retryable: false } })), undefined);
  assert.equal(autoRetryDelayMs(timeout({ details: { process_state: "exited" } })), undefined);
  assert.equal(autoRetryDelayMs(timeout({ recovery: undefined })), undefined);
  assert.equal(autoRetryDelayMs(envelope('{"ok":true,"command":"click","data":{}}')), undefined);
});

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const SNAPSHOT = {
  app: "Calculator",
  complete: true,
  ref_count: 3,
  snapshot_id: "s21nz0od1aqhoj",
  tree: {
    role: "window",
    name: "Calculator",
    children: [
      {
        role: "group",
        available_actions: ["SetFocus"],
        children: [
          { role: "scrollarea", name: "Edit field", available_actions: ["Scroll"], native_id: { kind: "ax_identifier", value: "StandardInputView" }, ref_id: "@s21nz0od1aqhoj:e1", children: [{ role: "statictext", name: "77", value: "77" }] },
          { role: "button", name: "Delete", available_actions: ["Click", "SetFocus"], ref_id: "@s21nz0od1aqhoj:e2", states: ["focused"] },
          { role: "button", name: "7", available_actions: ["Click"], ref_id: "@s21nz0od1aqhoj:e3" },
        ],
      },
    ],
  },
};

test("a snapshot becomes an indented tree with its refs intact", () => {
  const snapshot = formatSnapshot(SNAPSHOT)!;
  assert.equal(snapshot.app, "Calculator");
  assert.equal(snapshot.snapshotId, "s21nz0od1aqhoj");
  assert.equal(snapshot.refCount, 3);
  assert.equal(
    snapshot.text,
    [
      "Calculator · snapshot s21nz0od1aqhoj · 3 refs",
      '- window "Calculator"',
      "  - group {SetFocus}",
      '    - scrollarea "Edit field" @s21nz0od1aqhoj:e1 {Scroll}',
      '      - statictext "77"',
      '    - button "Delete" @s21nz0od1aqhoj:e2 [focused] {Click,SetFocus}',
      '    - button "7" @s21nz0od1aqhoj:e3',
    ].join("\n"),
  );
  // A fraction of the JSON's size is the point of the conversion.
  assert.ok(snapshot.text.length < JSON.stringify(SNAPSHOT).length / 2);
  assert.equal(formatSnapshot({ app: "Finder" }), undefined);
  assert.equal(formatSnapshot(undefined), undefined);
});

test("a snapshot header flags an incomplete read and a skeleton", () => {
  const skeleton = formatSnapshot({ app: "Finder", snapshot_id: "s3", ref_count: 1, complete: false, tree: { role: "window", children: [{ role: "treeitem", name: "Recent", ref_id: "@s3:e1", children_count: 4 }] } })!;
  assert.match(skeleton.text.split("\n")[0]!, /INCOMPLETE/);
  assert.match(skeleton.text.split("\n")[0]!, /pass its ref as root/);
  assert.match(skeleton.text, /- treeitem "Recent" @s3:e1 \(\+4 children\)/);
  assert.equal(skeleton.complete, false);
});

test("formatNode covers values, ids, bounds and awkward names", () => {
  assert.equal(formatNode({ role: "textfield", name: "Search", value: "cats", ref_id: "@s1:e1" }), 'textfield "Search" @s1:e1 value="cats"');
  assert.equal(formatNode({ role: "slider", value: 40, ref_id: "@s1:e2" }), 'slider @s1:e2 value="40"');
  assert.equal(formatNode({ role: "button", native_id: { kind: "ax_identifier", value: "Delete" }, ref_id: "@s1:e3" }), "button @s1:e3 id=Delete");
  assert.equal(formatNode({ role: "scrollarea", native_id: { kind: "ax_identifier", value: "_NS:61" }, ref_id: "@s1:e4" }), "scrollarea @s1:e4");
  assert.equal(formatNode({ role: "button", name: "OK", bounds: { x: 10.4, y: 20, width: 80, height: 24.6 } }), 'button "OK" @10,20 80x25');
  assert.equal(formatNode({ role: "treeitem", name: "A", children_count: 1 }), 'treeitem "A" (+1 child)');
  assert.equal(formatNode({ role: "statictext", name: 'say "hi"\nnow' }), 'statictext "say \\"hi\\" now"');
  assert.equal(formatNode({ name: "x".repeat(200) }).length, 'element ""'.length + 80);
  assert.equal(formatNode({}), "element");
  assert.equal(formatTree(null), "");
});

test("find results list refs with where they sit", () => {
  const found = formatFind({
    matches: [
      { interactive: true, name: "Eject", path: ["window", "group", "cell"], ref_id: "@s2:e1", role: "button", states: ["disabled", "offscreen"], value: null },
      { interactive: true, path: ["window", "scrollbar"], ref_id: "@s2:e2", role: "button", value: null },
    ],
    snapshot_id: "s2",
    total_matches: 18,
    truncated: true,
  });
  assert.deepEqual({ shown: found.shown, total: found.total, truncated: found.truncated, snapshotId: found.snapshotId }, { shown: 2, total: 18, truncated: true, snapshotId: "s2" });
  assert.equal(found.text, '- button "Eject" @s2:e1 [disabled, offscreen]  in window > group > cell\n- button @s2:e2  in window > scrollbar');

  const single = formatFind({ match: { name: "Eject", ref_id: "@s3:e1", role: "button" }, snapshot_id: "s3" });
  assert.deepEqual([single.shown, single.total], [1, 1]);
  assert.deepEqual(formatFind({ count: 18 }), { snapshotId: undefined, shown: 0, total: 18, truncated: false, text: "18" });
  assert.equal(formatFind({ matches: [], total_matches: 0 }).text, "(no matches)");
  assert.equal(formatFind(undefined).total, 0);
});

test("an action reports how it was delivered", () => {
  const click = readAction({
    action: "click",
    disposition: { delivery: "delivered_unverified", retry: "unsafe" },
    steps: [{ label: "AXPress", mechanism: "semantic_api", outcome: "succeeded", verified: false }],
  });
  assert.deepEqual(click, { disposition: { delivery: "delivered_unverified", retry: "unsafe" }, mechanism: "AXPress via semantic_api", snapshot: undefined });

  // With a post-action wait the action nests under after_action beside a fresh snapshot.
  const waited = readAction({ after_action: { action: "click", disposition: { delivery: "delivered_verified", retry: "unsafe" }, steps: [] }, matched_selector: "button:8", ...SNAPSHOT });
  assert.equal(waited.disposition?.delivery, "delivered_verified");
  assert.equal(waited.snapshot?.matchedSelector, "button:8");
  assert.equal(waited.snapshot?.refCount, 3);
  assert.deepEqual(readAction(undefined), {});
});

test("lists read apps, windows, displays and surfaces", () => {
  const apps = formatApps({
    apps: [
      { bundle_id: "com.apple.finder", name: "Finder", pid: 1508, presentation: "foreground" },
      { bundle_id: "com.1password.1password", name: "1Password", pid: 60307, presentation: "background" },
      { name: "Google Drive", pid: 1604 },
      { name: "Google Drive", pid: 1774 },
    ],
  });
  assert.equal(apps.count, 1);
  assert.equal(apps.text, "Finder  com.apple.finder  pid 1508\nbackground and helper processes (3): 1Password, Google Drive");
  // A platform that does not classify its apps lists them all.
  assert.equal(formatApps({ apps: [{ name: "gedit", pid: 7 }, { name: "nautilus", pid: 8 }] }).text, "gedit  pid 7\nnautilus  pid 8");
  assert.equal(formatApps({ apps: [] }).text, "(no matching apps)");

  // list-windows and list-displays return a bare array.
  const windows = formatWindows([
    { accessible: true, app_name: "Finder", bounds: { height: 436, width: 920, x: 296, y: 162 }, id: "w-17009", is_focused: true, minimized: false, title: "Downloads", visible: true },
    { accessible: false, app_name: "Menu", bounds: { height: 33, width: 1512, x: 0, y: 0 }, id: "w-1", is_focused: false, title: "", visible: false },
  ]);
  assert.equal(windows.text, 'w-17009  Finder  "Downloads"  @296,162 920x436  [focused]\nw-1  Menu  @0,0 1512x33  [hidden, not accessible]');
  assert.equal(formatDisplays([{ bounds: { height: 982, width: 1512, x: 0, y: 0 }, id: "1", is_primary: true, scale: 2 }]).text, "0  id 1  @0,0 1512x982  scale 2  [primary]");
  assert.equal(formatSurfaces({ pid: 1, surfaces: [{ id: "m1", type: "menu", title: "File", item_count: 9 }] }).text, 'menu  "File"');
  assert.equal(formatSurfaces({ pid: 1, surfaces: [] }).count, 0);
});

test("get, is and permission payloads", () => {
  assert.equal(formatValue(null), "(no value)");
  assert.equal(formatValue("Hello"), "Hello");
  assert.equal(formatValue(""), "(empty)");
  assert.equal(formatValue(["focused", "enabled"]), "focused, enabled");
  assert.equal(formatValue({ x: 1, y: 2 }), '{\n  "x": 1,\n  "y": 2\n}');
  assert.deepEqual(readIsResult({ applicable: true, property: "enabled", ref: REF, result: false }), { result: false, applicable: true });
  assert.deepEqual(readIsResult({ applicable: false, result: false }), { result: false, applicable: false });
  assert.throws(() => readIsResult({ property: "enabled" }), /expected a boolean result/);
  const permissions = { accessibility: { state: "granted" }, automation: { state: "unknown" }, screen_recording: { state: "denied" } };
  const expected = { accessibility: "granted", screenRecording: "denied", automation: "unknown" };
  assert.deepEqual(readPermissions(permissions), expected);
  assert.deepEqual(readPermissions({ platform: "macos", permissions }), expected);
  assert.equal(readPermissions({ platform: "macos" }), undefined);
});

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

test("compat arguments alias and coerce", () => {
  const prepared = prepareCompatArguments<Record<string, unknown>>(
    { element: REF, headed: "true", timeout: "500" },
    { aliases: { element: "ref", timeout: "timeoutMs" }, booleanFields: ["headed"], numberFields: ["timeoutMs"] },
  );
  assert.equal(prepared.ref, REF);
  assert.equal(prepared.headed, true);
  assert.equal(prepared.timeoutMs, 500);
});
