import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  clickDesktopElement,
  clipboardDesktop,
  DesktopError,
  findDesktopElements,
  isDesktopState,
  pressDesktopKey,
  resolveHeaded,
  runDesktopCommand,
  screenshotDesktop,
  setupWarning,
  snapshotDesktop,
  typeIntoDesktopElement,
  verifyDesktop,
  waitOnDesktop,
} from "../src/agent-desktop.ts";
import { desktopSessionName } from "../src/agent-desktop-args.ts";
import type { DesktopHost, ExecOptions, ExecResult } from "../src/host.ts";
import { basename, dirname, join, resolve } from "../src/paths.ts";
import { execWithStdin } from "../src/pi-host.ts";
import { sha256Hex } from "../src/sha256.ts";
import { createDesktopState } from "../src/state.ts";
import { truncateText } from "../src/tool-output.ts";

// The core runs without Node in the Claude Code mod, so its stand-ins for node:crypto and
// node:path must agree with the originals exactly.

test("sha256Hex matches node:crypto", () => {
  for (const input of ["", "abc", "c2804a12-b277-4e01-a9bf-a1bb9b87f70f", "x".repeat(1000), "ünïcødé ✳"]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input).digest("hex"));
  }
});

test("each host gets its own session namespace, valid for agent-desktop", () => {
  const id = "c2804a12-b277-4e01-a9bf-a1bb9b87f70f";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 16);
  assert.equal(desktopSessionName(id), `pi-${digest}`);
  assert.equal(desktopSessionName(id, "cc"), `cc-${digest}`);
  // agent-desktop accepts 1 to 64 letters, digits, - or _.
  assert.match(desktopSessionName(id, "cc"), /^[A-Za-z0-9_-]{1,64}$/);
});

test("posix path helpers agree with node:path", () => {
  assert.equal(join("/tmp", "da-desktop", "x"), path.join("/tmp", "da-desktop", "x"));
  for (const [base, target] of [["/a/b", "../c"], ["/a", "./x/y"], ["/a/b", "/abs/./z"], ["/", "a"]]) {
    assert.equal(resolve(base!, target!), path.resolve(base!, target!));
  }
  assert.equal(dirname("/a/b/c.txt"), path.dirname("/a/b/c.txt"));
  assert.equal(basename("/a/b/"), path.basename("/a/b/"));
});

test("truncateText keeps whole lines from the head or the tail", () => {
  const text = Array.from({ length: 10 }, (_, index) => `line ${index}`).join("\n");
  assert.equal(truncateText(text, "head", 3).content, "line 0\nline 1\nline 2");
  assert.equal(truncateText(text, "tail", 3).content, "line 7\nline 8\nline 9");
  assert.equal(truncateText("short", "head").truncated, false);
});

// ---------------------------------------------------------------------------
// The runner, against a scripted CLI. No desktop, no Accessibility permission.
// ---------------------------------------------------------------------------

interface Call {
  command: string;
  args: string[];
  options: ExecOptions;
}

const REF = "@s21nz0od1aqhoj:e3";
const SESSION = desktopSessionName("session-1", "pi");
const ok = (command: string, data: unknown): ExecResult => ({ stdout: JSON.stringify({ version: "2.6", ok: true, command, data }), stderr: "", code: 0 });
const fail = (command: string, error: Record<string, unknown>): ExecResult => ({ stdout: JSON.stringify({ version: "2.6", ok: false, command, error }), stderr: "", code: 1 });
const VERSION: ExecResult = { stdout: "agent-desktop 1.3.1\n", stderr: "", code: 0 };
const CLICKED = { action: "click", disposition: { delivery: "delivered_unverified", retry: "unsafe" }, steps: [{ label: "AXPress", mechanism: "semantic_api", outcome: "succeeded" }] };
const SNAPSHOT = {
  app: "Calculator",
  complete: true,
  ref_count: 1,
  snapshot_id: "s21nz0od1aqhoj",
  tree: { role: "window", name: "Calculator", children: [{ role: "button", name: "7", ref_id: REF, available_actions: ["Click"] }] },
};

/** A host whose CLI answers from a script: `--version` always works, the rest are queued. */
function scripted(...results: ExecResult[]) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const dirs: string[] = [];
  const queue = [...results];
  const host: DesktopHost = {
    async exec(command, args, options) {
      if (args[0] === "--version") return VERSION;
      calls.push({ command, args, options });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected call: ${args.join(" ")}`);
      return next;
    },
    async writeFile(file, text) {
      files.set(file, text);
    },
    async writePrivateFile(file, text) {
      files.set(file, text);
    },
    async ensurePrivateDir(dir) {
      dirs.push(dir);
    },
    cwd: "/tmp/project",
    homeDir: "/tmp/home",
    sessionId: "session-1",
    sessionPrefix: "pi",
  };
  return { host, calls, files, dirs, state: createDesktopState("/tmp/project") };
}

test("a snapshot runs in the session namespace and is saved privately", async () => {
  const { host, calls, files, dirs, state } = scripted(ok("snapshot", SNAPSHOT));
  const result = await snapshotDesktop(host, state, { app: "Calculator", interactiveOnly: true, compact: true });

  assert.deepEqual(calls[0]!.args, ["--session", SESSION, "snapshot", "--app", "Calculator", "-i", "--compact"]);
  assert.equal(calls[0]!.command, "agent-desktop");
  assert.equal(result.summary, "Snapshot of Calculator: 1 ref (snapshot s21nz0od1aqhoj).");
  assert.match(result.contentText!, /- button "7" @s21nz0od1aqhoj:e3/);
  assert.deepEqual(dirs, [state.artifactDir]);
  assert.equal(state.app, "Calculator");
  assert.equal(state.lastSnapshotId, "s21nz0od1aqhoj");
  assert.equal(files.get(state.lastSnapshotFile!), result.contentText);
  assert.ok(state.lastSnapshotFile!.startsWith(state.artifactDir));
});

test("an action reports delivery and asks for a look when it was not verified", async () => {
  const { host, calls, state } = scripted(ok("click", CLICKED));
  const result = await clickDesktopElement(host, state, REF);
  assert.deepEqual(calls[0]!.args, ["--session", SESSION, "click", REF]);
  assert.equal(result.summary, `Sent click to ${REF} (delivered, effect not verified). Observe again to confirm the effect.`);
  assert.deepEqual(result.diagnostics, { delivery: "delivered_unverified", retry: "unsafe", mechanism: "AXPress via semantic_api" });
  assert.equal(state.lastAction, "click");
});

test("an action with waitFor returns the fresh snapshot it waited for", async () => {
  const { host, calls, state } = scripted(ok("click", { after_action: CLICKED, matched_selector: "button:7", ...SNAPSHOT }));
  const result = await clickDesktopElement(host, state, REF, "click", { waitFor: "button:7", waitTimeoutMs: 4000 });
  assert.deepEqual(calls[0]!.args, ["--session", SESSION, "--wait-for", "button:7", "--wait-timeout", "4000", "click", REF]);
  assert.equal(result.summary, `Sent click to ${REF} (delivered, effect not verified). Waited for button:7.`);
  assert.match(result.contentText!, /- button "7"/);
  assert.equal(result.diagnostics!.refCount, 1);
  assert.equal(state.lastSnapshotId, "s21nz0od1aqhoj");
});

test("typed text and clipboard text reach the CLI on stdin only", async () => {
  const secret = "correct horse battery staple";
  const typed = scripted(ok("type", { action: "type", disposition: { delivery: "delivered_verified", retry: "unsafe" } }));
  const result = await typeIntoDesktopElement(typed.host, typed.state, { ref: REF, text: secret });
  assert.deepEqual(typed.calls[0]!.args, ["--session", SESSION, "type", REF, "--stdin"]);
  assert.equal(typed.calls[0]!.options.stdin, secret);
  assert.equal(result.summary, `Typed into ${REF} (delivered and verified).`);

  const clipboard = scripted(ok("clipboard-set", {}));
  const written = await clipboardDesktop(clipboard.host, clipboard.state, { action: "set", text: secret });
  assert.deepEqual(clipboard.calls[0]!.args, ["--session", SESSION, "clipboard-set", "--stdin"]);
  assert.equal(clipboard.calls[0]!.options.stdin, secret);

  // Neither the arguments nor anything handed back to the model or state repeats the text.
  for (const everything of [typed.calls[0]!.args, result, typed.state, clipboard.calls[0]!.args, written, clipboard.state]) {
    assert.ok(!JSON.stringify(everything).includes("horse"));
  }
});

test("reading the clipboard returns the text with a caution and counts it for the row", async () => {
  const { host, state } = scripted(ok("clipboard-get", { text: "hello", type: "text" }));
  const result = await clipboardDesktop(host, state, { action: "get" });
  assert.match(result.summary, /^Clipboard text \(5 characters\)\. Clipboard contents can be private/);
  assert.equal(result.contentText, "hello");
  assert.deepEqual(result.diagnostics, { action: "get", type: "text", chars: 5 });

  const empty = scripted(ok("clipboard-get", { found: false, type: "text" }));
  assert.equal((await clipboardDesktop(empty.host, empty.state, { action: "get" })).summary, "The clipboard holds no text.");
});

test("a failure carries the CLI's code and disposition, and is not retried when unsafe", async () => {
  const { host, calls, state } = scripted(
    fail("click", { code: "ACTION_FAILED", message: "Press was rejected", disposition: { delivery: "delivery_uncertain", retry: "unsafe" } }),
  );
  await assert.rejects(clickDesktopElement(host, state, REF), (error: unknown) => {
    assert.ok(error instanceof DesktopError);
    assert.equal(error.code, "ACTION_FAILED");
    assert.equal(error.disposition.retry, "unsafe");
    assert.match(error.message, /^Retry: unsafe/m);
    return true;
  });
  assert.equal(calls.length, 1);
});

test("a stale ref is not retried: the model has to snapshot again", async () => {
  const { host, calls, state } = scripted(
    fail("click", {
      code: "STALE_REF",
      message: "Ref no longer matches",
      recovery: { strategy: "refresh_snapshot_then_retry_original", retryable: true, requires_fresh_snapshot: true },
      disposition: { delivery: "not_delivered", retry: "safe" },
    }),
  );
  await assert.rejects(clickDesktopElement(host, state, REF), /STALE_REF[\s\S]*new desktop_snapshot[\s\S]*Retry: safe/);
  assert.equal(calls.length, 1);
});

const TRANSIENT = {
  code: "TIMEOUT",
  message: "Target did not become actionable",
  recovery: { strategy: "inspect_state_then_retry_original", retryable: true, requires_fresh_snapshot: true, retry_after_ms: 250 },
  details: { kind: "actionability_timeout" },
  disposition: { delivery: "not_delivered", retry: "safe" },
};

test("a transient failure the CLI calls safe is retried once, after its pause", async () => {
  const { host, calls, state } = scripted(fail("click", TRANSIENT), ok("wait", { waited_ms: 250 }), ok("click", CLICKED));
  const result = await clickDesktopElement(host, state, REF);
  assert.match(result.summary, /^Sent click/);
  assert.deepEqual(calls.map((call) => call.args.slice(-2)), [["click", REF], ["wait", "250"], ["click", REF]]);
});

test("the retry happens once: a second failure is reported", async () => {
  const { host, calls, state } = scripted(fail("click", TRANSIENT), ok("wait", { waited_ms: 250 }), fail("click", TRANSIENT));
  await assert.rejects(clickDesktopElement(host, state, REF), /TIMEOUT/);
  assert.equal(calls.length, 3);
});

test("a wait that times out is not waited out a second time", async () => {
  const { host, calls, state } = scripted(fail("wait", { ...TRANSIENT, details: { kind: "wait_timeout" } }));
  await assert.rejects(waitOnDesktop(host, state, { text: "Saved", app: "TextEdit", timeoutMs: 300 }), /TIMEOUT/);
  assert.equal(calls.length, 1);
});

test("output that is not an envelope is reported as a failed command", async () => {
  const { host, state } = scripted({ stdout: "", stderr: "dyld: Library not loaded", code: 134, killed: false });
  await assert.rejects(snapshotDesktop(host, state, { app: "Finder" }), /Command failed: agent-desktop --session \S+ snapshot[\s\S]*Exit code: 134[\s\S]*dyld/);
});

test("a missing or outdated CLI stops every tool with the fix", async () => {
  const state = createDesktopState("/tmp/project");
  const host = (version: ExecResult | Error): DesktopHost => ({
    ...scripted().host,
    async exec() {
      if (version instanceof Error) throw version;
      return version;
    },
  });
  await assert.rejects(snapshotDesktop(host(new Error("ENOENT")), state, {}), /agent-desktop CLI not found.*npm i -g agent-desktop@latest/);
  assert.equal(state.agentDesktopCompatible, false);
  await assert.rejects(snapshotDesktop(host({ stdout: "agent-desktop 1.2.0", stderr: "", code: 0 }), state, {}), /requires agent-desktop >=1\.3\.1; found 1\.2\.0/);
  assert.equal(state.agentDesktopVersion, "1.2.0");
});

test("physical input needs the user's say-so before --headed is ever passed", async () => {
  const { host, calls, state } = scripted(ok("hover", CLICKED));
  assert.equal(resolveHeaded(state, undefined), false);
  assert.equal(resolveHeaded(state, false), false);
  await assert.rejects(clickDesktopElement(host, state, REF, "double", { headed: true }), /Physical input \(headed\) is off.*only the user can allow it/);
  await assert.rejects(runDesktopCommand(host, state, { args: ["hover", REF], headed: true }), /Physical input \(headed\) is off/);
  assert.equal(calls.length, 0);

  state.headed = true;
  await runDesktopCommand(host, state, { args: ["hover", REF], headed: true });
  assert.deepEqual(calls[0]!.args, ["--session", SESSION, "--headed", "hover", REF]);
});

test("allowing physical input does not make every call physical", async () => {
  const { host, calls, state } = scripted(ok("click", CLICKED));
  state.headed = true;
  await clickDesktopElement(host, state, REF);
  assert.ok(!calls[0]!.args.includes("--headed"));
});

test("a key press must name its app", async () => {
  const { host, calls, state } = scripted(ok("press", { action: "press_key", disposition: { delivery: "delivered_unverified", retry: "unsafe" } }));
  await assert.rejects(pressDesktopKey(host, state, { combo: "cmd+w" }), /needs app or windowId/);
  assert.equal(calls.length, 0);
  await pressDesktopKey(host, state, { combo: "cmd+w", app: "Finder" });
  assert.deepEqual(calls[0]!.args, ["--session", SESSION, "press", "cmd+w", "--app", "Finder"]);
});

test("find, is and screenshot read their payloads", async () => {
  const find = scripted(ok("find", { matches: [{ name: "7", ref_id: REF, role: "button", path: ["window"] }], snapshot_id: "s9", total_matches: 1 }));
  const found = await findDesktopElements(find.host, find.state, { app: "Calculator", role: "button", name: "7" });
  assert.equal(found.summary, "Found 1 element.");
  assert.match(found.contentText!, /- button "7" @s21nz0od1aqhoj:e3  in window/);

  const none = scripted(ok("find", { matches: [], snapshot_id: "s9", total_matches: 0 }));
  assert.equal((await findDesktopElements(none.host, none.state, { text: "nope" })).summary, "No element matched.");

  const is = scripted(ok("is", { applicable: true, property: "enabled", ref: REF, result: false }));
  const checked = await isDesktopState(is.host, is.state, REF, "enabled");
  assert.equal(checked.summary, `${REF} enabled: false`);
  assert.equal(checked.diagnostics!.result, false);

  const shot = scripted(ok("screenshot", { format: "png", height: 1008, path: "/tmp/x/shot.png", scale_factor: 2, width: 1976 }));
  const saved = await screenshotDesktop(shot.host, shot.state, { app: "Finder", label: "Finder window" });
  const file = shot.calls[0]!.args.at(-1)!;
  assert.ok(file.startsWith(shot.state.artifactDir) && file.endsWith("-finder-window.png"));
  assert.match(saved.summary, /^Saved screenshot \(1976x1008\) to \/tmp\/x\/shot\.png\. It can hold private screen content/);
  assert.deepEqual(saved.artifacts, ["/tmp/x/shot.png"]);
});

test("the passthrough renders snapshot-shaped output as a tree and other output as JSON", async () => {
  const snap = scripted(ok("snapshot", SNAPSHOT));
  const tree = await runDesktopCommand(snap.host, snap.state, { args: ["snapshot", "--app", "Calculator", "--surface", "menubar"] });
  assert.match(tree.contentText!, /^Calculator · snapshot/);
  assert.equal(snap.state.lastSnapshotId, "s21nz0od1aqhoj");

  const list = scripted(ok("list-notifications", { notifications: [] }));
  const json = await runDesktopCommand(list.host, list.state, { args: ["list-notifications", "--limit", "5"], timeoutMs: 5 });
  assert.equal(json.summary, "agent-desktop list-notifications completed.");
  assert.equal(json.contentText, '{\n  "notifications": []\n}');
  assert.equal(list.calls[0]!.options.timeout, 1000);
});

test("session start learns what is missing without touching an app", async () => {
  const granted = scripted(ok("status", { permissions: { accessibility: { state: "granted" }, screen_recording: { state: "granted" }, automation: { state: "unknown" } }, platform: "macos", state_root: "/h/.agent-desktop", supported_surfaces: ["window", "menu"], version: "1.3.1" }));
  const probe = await verifyDesktop(granted.host, granted.state);
  assert.equal(probe.agentDesktopSession, SESSION);
  assert.deepEqual(probe.permissions, { accessibility: "granted", screenRecording: "granted", automation: "unknown" });
  assert.equal(granted.state.platform, "macos");
  assert.equal(setupWarning(probe), undefined);

  const denied = scripted(ok("status", { permissions: { accessibility: { state: "denied" } }, platform: "macos" }));
  assert.match(setupWarning(await verifyDesktop(denied.host, denied.state))!, /Accessibility is denied.*permissions --guide$/);
  const linux = scripted(ok("status", { permissions: { accessibility: { state: "denied" } }, platform: "linux" }));
  assert.match(setupWarning(await verifyDesktop(linux.host, linux.state))!, /agent-desktop permissions$/);
  const windows = scripted(ok("status", { permissions: { accessibility: { state: "granted" }, automation: { state: "not_required" } }, platform: "windows" }));
  assert.equal(setupWarning(await verifyDesktop(windows.host, windows.state)), undefined);

  const old = { ...scripted().host, exec: async () => ({ stdout: "agent-desktop 1.0.0", stderr: "", code: 0 }) };
  assert.match(setupWarning(await verifyDesktop(old, createDesktopState("/tmp/p")))!, /requires agent-desktop >=1\.3\.1; found 1\.0\.0/);
});

test("a permission refusal is remembered for the status chip", async () => {
  const { host, state } = scripted(fail("snapshot", { code: "PERM_DENIED", message: "Accessibility permission is required", disposition: { delivery: "not_delivered", retry: "safe" } }));
  await assert.rejects(snapshotDesktop(host, state, { app: "Finder" }), /PERM_DENIED[\s\S]*permissions --guide/);
  assert.equal(state.permissions?.accessibility, "denied");
});

// ---------------------------------------------------------------------------
// pi's stdin exec, against real processes
// ---------------------------------------------------------------------------

test("execWithStdin pipes text to the process and keeps it out of argv", async () => {
  const result = await execWithStdin("/bin/sh", ["-c", 'cat; printf " argc=%s" "$#"'], { stdin: "pïped text", timeout: 5000 });
  assert.deepEqual(result, { stdout: "pïped text argc=0", stderr: "", code: 0, killed: false });
});

test("execWithStdin reports exit codes, timeouts and commands that cannot start", async () => {
  assert.equal((await execWithStdin("/bin/sh", ["-c", "cat >/dev/null; exit 3"], { stdin: "x", timeout: 5000 })).code, 3);
  const slow = await execWithStdin("/bin/sh", ["-c", "sleep 5"], { stdin: "", timeout: 100 });
  assert.equal(slow.killed, true);
  const missing = await execWithStdin("/nonexistent/agent-desktop", [], { stdin: "x", timeout: 1000 });
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /ENOENT/);
});

test("private files and directories are created owner-only", async () => {
  const { piHost } = await import("../src/pi-host.ts");
  const root = await mkdtemp(path.join(tmpdir(), "da-desktop-test-"));
  const host = piHost({ exec: async () => ({ stdout: "", stderr: "", code: 0 }) } as never, { cwd: root, sessionManager: { getSessionId: () => "s" } } as never);
  const dir = path.join(root, "artifacts");
  await host.ensurePrivateDir(dir);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  const file = path.join(dir, "snapshot.txt");
  await host.writePrivateFile(file, "tree");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal(await readFile(file, "utf8"), "tree");
});
