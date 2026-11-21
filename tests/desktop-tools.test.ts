import assert from "node:assert/strict";
import test from "node:test";

import { DESKTOP_GUIDELINES, DESKTOP_TOOLS, prepareDesktopInput, type DesktopToolSpec } from "../src/desktop-tools.ts";

// pi and the Claude Code mod both register from this table, so a tool missing here is
// missing in both hosts.

const tool = (name: string): DesktopToolSpec => DESKTOP_TOOLS.find((spec) => spec.name === name)!;
const REF = "@s8f3k2p9:e8";

test("the table holds all 18 tools, each once", () => {
  const names = DESKTOP_TOOLS.map((spec) => spec.name).sort();
  assert.deepEqual(
    names,
    [
      "act", "app", "click", "clipboard", "command", "find", "get", "is", "list",
      "press", "screenshot", "scroll", "select", "snapshot", "status", "type", "wait", "window",
    ].map((name) => `desktop_${name}`),
  );
});

test("required and compat fields name real properties", () => {
  for (const spec of DESKTOP_TOOLS) {
    const properties = Object.keys(spec.parameters.properties);
    const { aliases = {}, booleanFields = [], numberFields = [] } = spec.compat ?? {};
    for (const field of [...(spec.parameters.required ?? []), ...Object.values(aliases), ...booleanFields, ...numberFields]) {
      assert.ok(properties.includes(field), `${spec.name}: ${field}`);
    }
    assert.ok(spec.description.length <= 2048, `${spec.name} description is ${spec.description.length} chars`);
  }
});

test("only tools that observe are marked read-only", () => {
  const readOnly = DESKTOP_TOOLS.filter((spec) => spec.readOnly).map((spec) => spec.name).sort();
  assert.deepEqual(readOnly, ["find", "get", "is", "list", "screenshot", "snapshot", "status", "wait"].map((name) => `desktop_${name}`));
});

test("every tool that can deliver input offers headed, and no observer does", () => {
  for (const spec of DESKTOP_TOOLS) {
    const offersHeaded = "headed" in spec.parameters.properties;
    const acts = !spec.readOnly && spec.name !== "desktop_clipboard";
    assert.equal(offersHeaded, acts, spec.name);
  }
});

test("a missing required field is named instead of reaching agent-desktop as undefined", () => {
  assert.throws(() => prepareDesktopInput(tool("desktop_click"), {}), /desktop_click requires ref/);
  assert.throws(() => prepareDesktopInput(tool("desktop_type"), { ref: REF }), /desktop_type requires text/);
  assert.throws(() => prepareDesktopInput(tool("desktop_app"), { action: "launch" }), /desktop_app requires app/);
  assert.equal(prepareDesktopInput(tool("desktop_click"), { element: REF }).ref, REF);
});

test("aliases and string coercion match what models tend to send", () => {
  const click = prepareDesktopInput(tool("desktop_click"), { element: REF, headed: "true", timeout: "800", button: "right" });
  assert.deepEqual([click.ref, click.headed, click.timeoutMs, click.kind], [REF, true, 800, "right"]);
  assert.equal(prepareDesktopInput(tool("desktop_type"), { ref: REF, value: "hi" }).text, "hi");
  assert.equal(prepareDesktopInput(tool("desktop_press"), { key: "escape", application: "Finder" }).combo, "escape");
  assert.equal(prepareDesktopInput(tool("desktop_wait"), { ref: REF, timeout: "5000" }).element, REF);
  assert.equal(prepareDesktopInput(tool("desktop_snapshot"), { application: "Finder", interactive: "false" }).interactiveOnly, false);
});

test("find splits a comma-separated state list", () => {
  assert.deepEqual(prepareDesktopInput(tool("desktop_find"), { role: "button", state: "enabled, offscreen=false," }).states, ["enabled", "offscreen=false"]);
  assert.deepEqual(prepareDesktopInput(tool("desktop_find"), { role: "button", states: ["enabled"] }).states, ["enabled"]);
});

test("app and clipboard accept the everyday verbs", () => {
  assert.equal(prepareDesktopInput(tool("desktop_app"), { action: "quit", name: "Calculator" }).action, "close");
  assert.equal(prepareDesktopInput(tool("desktop_app"), { action: "open", app: "Calculator" }).action, "launch");
  assert.equal(prepareDesktopInput(tool("desktop_clipboard"), { action: "read" }).action, "get");
  assert.equal(prepareDesktopInput(tool("desktop_clipboard"), { action: "write", value: "x" }).action, "set");
});

test("the guidelines carry the rules that keep a desktop safe", () => {
  const text = DESKTOP_GUIDELINES.join("\n");
  for (const rule of [/bare @e8 is refused/, /only when it says safe/, /only the user can allow/, /private data/, /did not ask for/]) {
    assert.match(text, rule);
  }
});
