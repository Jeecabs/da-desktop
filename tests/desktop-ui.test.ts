import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { summarizeToolText } from "../src/compact-tool-renderer.ts";
import { renderDesktopResult } from "../src/desktop-result-renderer.ts";
import { createDesktopState, desktopHealth, type DesktopState } from "../src/state.ts";
import {
    artifactName,
    chipText,
    deliveryFact,
    describeActivity,
    desktopCallLine,
    desktopChip,
    DesktopTrail,
    explainFailure,
    formatBody,
    presentResult,
    resultLine,
    snapshotLabel,
    TRAIL_TIMING,
    type ResultInput,
} from "../src/desktop-ui.ts";

const theme = { fg: (color: string, text: string) => `[${color}:${text}]` };
const plain = { fg: (_color: string, text: string) => text };
const REF = "@s21nz0od1aqhoj:e3";
const SNAPSHOT = [
    "Calculator · snapshot s21nz0od1aqhoj · 3 refs",
    '- window "Calculator"',
    '  - scrollarea "Edit field" @s21nz0od1aqhoj:e1 {Scroll}',
    "  - button @s21nz0od1aqhoj:e2 id=Delete",
    '  - button "7" @s21nz0od1aqhoj:e3',
    '  - button "A very long accessible name that goes on" @s21nz0od1aqhoj:e30 [focused]',
].join("\n");
const label = (ref: string) => snapshotLabel(SNAPSHOT, ref);

const base = (): DesktopState => createDesktopState("/tmp/project");
const ready = (): DesktopState => ({ ...base(), agentDesktopVersion: "1.3.1", agentDesktopCompatible: true, lastVerifiedAt: 1, permissions: { accessibility: "granted" } });
const chip = (state: DesktopState) => desktopChip(theme, state, desktopHealth(state));

describe("desktopChip", () => {
    it("hides itself until the desktop has something to say", () => {
        assert.equal(chip(base()), undefined);
        assert.equal(chip(ready()), undefined);
    });

    it("names the app the agent is in", () => {
        assert.equal(chip({ ...ready(), app: "Finder" }), "[dim:da desktop] [muted:Finder]");
    });

    it("always shows that physical input is allowed", () => {
        assert.equal(chip({ ...ready(), app: "Finder", headed: true }), "[dim:da desktop] [muted:Finder]  [warning:headed]");
        assert.equal(chip({ ...ready(), headed: true }), "[dim:da desktop]  [warning:headed]");
    });

    it("says what is wrong in words", () => {
        assert.equal(chip({ ...ready(), permissions: { accessibility: "denied" } }), "[dim:da desktop] [warning:no accessibility]");
        assert.equal(chip({ ...ready(), agentDesktopVersion: "1.0.0", agentDesktopCompatible: false }), "[dim:da desktop] [warning:update agent-desktop]");
        assert.equal(
            chip({ ...base(), agentDesktopCompatible: false, lastError: "agent-desktop CLI not found" }),
            "[dim:da desktop] [warning:install agent-desktop]",
        );
    });

    it("stays quiet about a missing CLI until the agent has tried to use it", () => {
        assert.equal(chip({ ...base(), agentDesktopCompatible: false }), undefined);
    });

    it("stays short enough for a shared status row, and drops its name for Claude Code", () => {
        const state = { ...ready(), app: "A Remarkably Long Application Name Indeed" };
        assert.ok(chip(state)!.replace(/\[\w+:|\]/g, "").length <= 36);
        assert.equal(chipText(plain, { ...ready(), app: "Finder" }, "ok", false), "Finder");
    });
});

describe("snapshotLabel", () => {
    it("names what a ref points at", () => {
        assert.equal(label(REF), '"7"');
        assert.equal(label("s21nz0od1aqhoj:e1"), '"Edit field"');
        assert.equal(label("@s21nz0od1aqhoj:e30"), '"A very long accessible…"');
    });

    it("falls back to the role for an unnamed element", () => {
        assert.equal(label("@s21nz0od1aqhoj:e2"), "button");
    });

    it("does not confuse e3 with e30, or another snapshot's e3", () => {
        assert.equal(label("@s21nz0od1aqhoj:e3"), '"7"');
        assert.equal(label("@sother:e3"), undefined);
        assert.equal(label("@e3"), undefined);
        assert.equal(label("@s21nz0od1aqhoj:e99"), undefined);
    });
});

describe("describeActivity", () => {
    const text = (tool: string, params: Record<string, unknown> = {}) => describeActivity(`desktop_${tool}`, params, label).text;

    it("reads as a few human words", () => {
        assert.equal(text("status"), "check desktop");
        assert.equal(text("list", { what: "windows", app: "Finder" }), "list windows Finder");
        assert.equal(text("snapshot", { app: "Finder" }), "snapshot Finder");
        assert.equal(text("find", { role: "button", name: "Save" }), 'find button "Save"');
        assert.equal(text("get", { ref: REF, property: "value" }), 'get value of "7"');
        assert.equal(text("is", { ref: REF, property: "enabled" }), 'check "7" enabled');
        assert.equal(text("screenshot", { app: "Finder" }), "screenshot Finder");
        assert.equal(text("click", { ref: REF }), 'click "7"');
        assert.equal(text("click", { ref: REF, kind: "right" }), 'right-click "7"');
        assert.equal(text("select", { ref: REF, option: "Large" }), 'choose "Large"');
        assert.equal(text("act", { ref: REF, action: "check" }), 'check "7"');
        assert.equal(text("scroll", { ref: REF, direction: "up" }), "scroll up");
        assert.equal(text("press", { combo: "cmd+s", app: "TextEdit" }), "press cmd+s");
        assert.equal(text("wait", { text: "Saved" }), 'wait for "Saved"');
        assert.equal(text("wait", { event: "window-opened" }), "wait for window-opened");
        assert.equal(text("wait", { ms: 2400 }), "wait 2s");
        assert.equal(text("wait", { ms: 50 }), "wait 50ms");
        assert.equal(text("app", { action: "launch", app: "Calculator" }), "launch Calculator");
        assert.equal(text("app", { action: "close", app: "Calculator" }), "quit Calculator");
        assert.equal(text("window", { action: "minimize", app: "Finder" }), "minimize window Finder");
        assert.equal(text("command", { args: ["--trace", "/tmp/t.jsonl", "list-notifications"] }), "run list-notifications");
    });

    it("drops the snapshot id from a ref no snapshot names", () => {
        assert.equal(describeActivity("desktop_click", { ref: "@sgone:e12" }).text, "click e12");
    });

    it("never echoes typed text, clipboard text or piped input", () => {
        const secret = "hunter2";
        for (const activity of [
            text("type", { ref: REF, text: secret }),
            text("type", { ref: REF, text: secret, mode: "set" }),
            text("clipboard", { action: "set", text: secret }),
            text("command", { args: ["clipboard-set", "--stdin"], stdin: secret }),
        ]) {
            assert.doesNotMatch(activity, /hunter2/);
        }
        assert.equal(text("type", { ref: REF, text: secret }), 'type into "7"');
        assert.equal(text("clipboard", { action: "get" }), "read clipboard");
        assert.equal(text("clipboard", { action: "set", text: secret }), "write clipboard");
    });

    it("picks a motion that suits the action", () => {
        assert.equal(describeActivity("desktop_type", { ref: REF }).motion, "caret");
        assert.equal(describeActivity("desktop_scroll", { direction: "left" }).motion, "left");
        assert.equal(describeActivity("desktop_screenshot").motion, "shutter");
        assert.equal(describeActivity("desktop_wait", { ms: 5 }).motion, "clock");
    });
});

describe("DesktopTrail", () => {
    const trailAt = () => {
        let now = 1_000;
        const trail = new DesktopTrail(() => now);
        return { trail, advance: (ms: number) => (now += ms) };
    };

    it("draws nothing at rest", () => {
        assert.deepEqual(trailAt().trail.lines(plain, 80), []);
    });

    it("shows finished steps, the running one, and the app", () => {
        const { trail } = trailAt();
        trail.begin("1", { text: "snapshot Finder", motion: "scan" });
        trail.end("1", true);
        trail.begin("2", { text: 'click "Downloads"', motion: "ripple" });
        assert.deepEqual(trail.lines(plain, 80, "Finder"), [' da desktop  snapshot Finder › ∙ click "Downloads"   Finder']);
    });

    it("marks a failure and animates typing after the words", () => {
        const { trail } = trailAt();
        trail.begin("1", { text: 'click "Save"', motion: "ripple" });
        trail.end("1", false);
        trail.begin("2", { text: 'type into "Name"', motion: "caret" });
        assert.equal(trail.lines(theme, 120)[0], ' [muted:da desktop]  [error:✗ click "Save"][borderMuted: › ][accent:type into "Name"▏]');
    });

    it("lingers, fades, then disappears", () => {
        const { trail, advance } = trailAt();
        trail.begin("1", { text: "snapshot", motion: "scan" });
        trail.end("1", true);
        advance(TRAIL_TIMING.lingerMs - 1);
        assert.match(trail.lines(theme, 80)[0]!, /\[muted:snapshot\]/);
        advance(2);
        assert.match(trail.lines(theme, 80)[0]!, /\[dim:snapshot\]/);
        advance(TRAIL_TIMING.drainMs);
        assert.deepEqual(trail.lines(theme, 80), []);
        assert.equal(trail.nextDelay(), undefined);
    });

    it("keeps the newest steps when the row is narrow", () => {
        const { trail } = trailAt();
        for (const [id, text] of [["1", "snapshot Finder"], ["2", 'click "Downloads"'], ["3", 'click "Report.pdf"']] as const) {
            trail.begin(id, { text, motion: "ripple" });
            trail.end(id, true);
        }
        const line = trail.lines(plain, 44)[0]!;
        assert.match(line, /…/);
        assert.match(line, /Report\.pdf/);
        assert.doesNotMatch(line, /snapshot Finder/);
    });
});

const result = (overrides: Partial<ResultInput>): ResultInput => ({
    tool: "desktop_snapshot",
    params: {},
    text: "",
    details: {},
    durationMs: 120,
    snapshotFiles: [],
    ...overrides,
});
const facts = (overrides: Partial<ResultInput>) => presentResult(result(overrides)).facts.map((fact) => `${fact.tone}:${fact.text}`);

describe("presentResult", () => {
    it("adds only what the call line does not say", () => {
        assert.deepEqual(facts({ tool: "desktop_snapshot", details: { refCount: 140, complete: true } }), ["muted:140 refs"]);
        assert.deepEqual(facts({ tool: "desktop_snapshot", details: { refCount: 1, complete: false } }), ["muted:1 ref", "warning:incomplete"]);
        assert.deepEqual(facts({ tool: "desktop_find", details: { totalMatches: 18 } }), ["muted:18 matches"]);
        assert.deepEqual(facts({ tool: "desktop_find", details: { totalMatches: 1 } }), ["muted:1 match"]);
        assert.deepEqual(facts({ tool: "desktop_find", details: { totalMatches: 0 } }), ["warning:no match"]);
        assert.deepEqual(facts({ tool: "desktop_is", params: { property: "enabled" }, details: { result: true } }), ["success:enabled"]);
        assert.deepEqual(facts({ tool: "desktop_is", params: { property: "enabled" }, details: { result: false } }), ["warning:not enabled"]);
        assert.deepEqual(facts({ tool: "desktop_wait", durationMs: 2300 }), ["muted:after 2.3s"]);
        assert.deepEqual(facts({ tool: "desktop_list", details: { count: 3, what: "windows" } }), ["muted:3 windows"]);
        assert.deepEqual(facts({ tool: "desktop_app", params: { action: "launch" }, details: { pid: 75799 } }), ["muted:pid 75799"]);
    });

    it("says how an action landed, and never calls an unverified one verified", () => {
        assert.deepEqual(facts({ tool: "desktop_click", details: { delivery: "delivered_verified" } }), ["success:verified"]);
        assert.deepEqual(facts({ tool: "desktop_click", details: { delivery: "delivered_unverified" } }), ["muted:sent, unverified"]);
        assert.deepEqual(facts({ tool: "desktop_act", details: { delivery: "not_delivered" } }), ["muted:already so"]);
        assert.deepEqual(facts({ tool: "desktop_click", details: { delivery: "delivered_unverified", refCount: 26 } }), ["muted:sent, unverified", "muted:26 refs"]);
        assert.deepEqual(deliveryFact("delivery_uncertain"), { text: "delivery uncertain", tone: "warning" });
        assert.equal(deliveryFact(undefined), undefined);
    });

    it("shows a value's first line and counts the rest", () => {
        assert.deepEqual(facts({ tool: "desktop_get", text: "text of @s1:e1:\n\nHello\nworld" }), ["text:Hello", "dim:+1 line"]);
    });

    it("keeps clipboard contents out of the row", () => {
        const text = "Clipboard text (11 characters). Clipboard contents can be private.\n\nhunter2 pwd";
        const row = presentResult(result({ tool: "desktop_clipboard", params: { action: "get" }, text, details: { action: "get", type: "text", chars: 11 } }));
        assert.deepEqual(row.facts, [{ text: "11 chars", tone: "muted" }]);
        assert.doesNotMatch(JSON.stringify(row.facts), /hunter2/);
        assert.deepEqual(facts({ tool: "desktop_clipboard", details: { action: "set" } }), ["success:written"]);
        assert.deepEqual(facts({ tool: "desktop_clipboard", details: { action: "get", found: false } }), ["muted:empty"]);
        // The passthrough gets the same care.
        const passthrough = result({ tool: "desktop_command", params: { args: ["clipboard-get"] }, text: 'agent-desktop clipboard-get completed.\n\n{"text":"hunter2"}', details: {} });
        assert.deepEqual(presentResult(passthrough).facts, []);
    });

    it("reports readiness from the probe", () => {
        const probe = { agentDesktopCompatible: true, permissions: { accessibility: "granted" } };
        assert.deepEqual(facts({ tool: "desktop_status", details: { probe, headed: false } }), ["success:ready"]);
        assert.deepEqual(facts({ tool: "desktop_status", details: { probe, headed: true } }), ["success:ready", "warning:physical input on"]);
        assert.deepEqual(facts({ tool: "desktop_status", details: { probe: { ...probe, permissions: { accessibility: "denied" } } } }), ["error:accessibility denied"]);
        assert.deepEqual(facts({ tool: "desktop_status", details: { probe: { agentDesktopCompatible: false } } }), ["error:agent-desktop missing or too old"]);
    });

    it("lists a screenshot as a file and an image, and hides snapshot dumps", () => {
        const shot = presentResult(result({ tool: "desktop_screenshot", details: { screenshotFile: "/tmp/a/2026-11-21T00-00-00-000Z-finder.png", artifacts: ["/tmp/a/2026-11-21T00-00-00-000Z-finder.png"] } }));
        assert.deepEqual(shot.files, ["/tmp/a/2026-11-21T00-00-00-000Z-finder.png"]);
        assert.equal(shot.image, shot.files[0]);
        const snap = presentResult(result({ details: { snapshotFile: "/tmp/a/s.txt", fullOutputFile: "/tmp/a/s.txt", refCount: 2 }, snapshotFiles: ["/tmp/a/s.txt"] }));
        assert.deepEqual(snap.files, []);
        assert.equal(snap.bodyKind, "tree");
    });

    it("splits the agent-facing summary from the body", () => {
        const row = presentResult(result({ text: "Snapshot of Finder: 2 refs (snapshot s1).\n\nFinder · snapshot s1\n- window" }));
        assert.equal(row.summary, "Snapshot of Finder: 2 refs (snapshot s1).");
        assert.equal(presentResult(result({ tool: "desktop_command", details: { refCount: 2 } })).bodyKind, "tree");
        assert.equal(presentResult(result({ tool: "desktop_command" })).bodyKind, "code");
    });
});

describe("resultLine and formatBody", () => {
    it("joins facts, a slow duration and files", () => {
        const row = { facts: [{ text: "sent, unverified", tone: "muted" as const }], files: ["/tmp/a/2026-11-21T00-00-00-000Z-finder.png"], durationMs: 2400, summary: "", bodyKind: "text" as const };
        assert.equal(resultLine(theme, row, { link: false }), "[muted:sent, unverified]  [dim:2.4s]  [dim:finder.png]");
        assert.match(resultLine(plain, row), /\x1b\]8;;file:\/\/\/tmp\/a\//);
        assert.equal(resultLine(theme, { ...row, files: [], durationMs: 200 }), "[muted:sent, unverified]");
        assert.equal(artifactName("/tmp/a/2026-11-21T00-00-00-000Z-after-click.txt"), "after-click.txt");
    });

    it("colours a tree by role, name and ref", () => {
        const painted = formatBody(theme, "tree", SNAPSHOT).split("\n");
        assert.equal(painted[1], '[dim:- ][mdHeading:window][text: "Calculator"][mdLink:][dim:]');
        assert.equal(painted[4], '[dim:  - ][accent:button][text: "7"][mdLink: @s21nz0od1aqhoj:e3][dim:]');
        assert.equal(painted[3], "[dim:  - ][accent:button][text:][mdLink: @s21nz0od1aqhoj:e2][dim: id=Delete]");
        assert.equal(painted[0], "[muted:Calculator · snapshot s21nz0od1aqhoj · 3 refs]");
        assert.equal(formatBody(theme, "text", "a\nb"), "[muted:a]\n[muted:b]");
        assert.equal(formatBody(theme, "code", '{"a":1}'), '{"a":1}');
    });

    it("titles a call row", () => {
        const titled = { fg: (color: string, text: string) => `[${color}:${text}]`, bold: (text: string) => `*${text}*` };
        assert.equal(desktopCallLine(titled, 'click "7"'), '[toolTitle:*desktop*] [accent:click "7"]');
    });
});

describe("explainFailure", () => {
    const failure = (code: string, retry: string, message = "something went wrong") =>
        explainFailure(`agent-desktop click failed: ${code}: ${message}\nNext: do a thing\nRetry: ${retry}. More words.`);

    it("gives a short reason and the next step", () => {
        assert.deepEqual(failure("STALE_REF", "safe"), { reason: "stale ref", hint: "the UI changed; take a new snapshot" });
        assert.deepEqual(failure("SNAPSHOT_NOT_FOUND", "safe"), { reason: "stale ref", hint: "its snapshot is gone; take a new one" });
        assert.deepEqual(failure("PERM_DENIED", "safe"), { reason: "permission missing", hint: "agent-desktop permissions --guide" });
        assert.deepEqual(failure("POLICY_DENIED", "safe"), { reason: "needs physical input", hint: "/desktop headed on allows it" });
        assert.deepEqual(failure("APP_NOT_FOUND", "safe"), { reason: "app not running", hint: "launch it first" });
        assert.deepEqual(failure("TIMEOUT", "safe"), { reason: "timed out", hint: undefined });
    });

    it("warns when the input may have landed", () => {
        assert.deepEqual(failure("ACTION_FAILED", "unsafe", "Press was rejected"), { reason: "ACTION_FAILED: Press was rejected", hint: "may have landed; look before retrying" });
        assert.deepEqual(failure("TIMEOUT", "unknown"), { reason: "timed out", hint: "may have landed; look before retrying" });
    });

    it("explains setup problems and local refusals", () => {
        assert.deepEqual(explainFailure("da-desktop requires agent-desktop >=1.3.1; found 1.0.0. Upgrade with `npm i -g agent-desktop@latest`."), {
            reason: "agent-desktop missing or too old",
            hint: "npm i -g agent-desktop@latest",
        });
        assert.equal(explainFailure("Physical input (headed) is off for this session. It moves the real pointer.").reason, "physical input is off");
        assert.deepEqual(explainFailure("Invalid ref \"@e8\": desktop refs are snapshot-qualified"), { reason: 'Invalid ref "@e8": desktop refs are snapshot-qualified' });
        assert.deepEqual(explainFailure(""), { reason: "failed" });
    });
});

describe("renderDesktopResult", () => {
    const piTheme = { fg: (color: string, text: string) => `[${color}:${text}]`, bold: (text: string) => text } as never;
    const render = (details: unknown, text: string, options: { expanded?: boolean; isError?: boolean } = {}) =>
        renderDesktopResult(
            { content: [{ type: "text", text }], details } as never,
            { expanded: options.expanded ?? false, isPartial: false },
            piTheme,
            { isError: options.isError ?? false, showImages: false },
        )
            .render(120)
            .map((line) => line.trimEnd())
            .filter(Boolean);

    it("collapses a result to its facts and expands to the coloured tree", () => {
        const text = `Snapshot of Calculator: 3 refs (snapshot s21nz0od1aqhoj).\n\n${SNAPSHOT}`;
        const presentation = presentResult(result({ text, details: { refCount: 3 } }));
        assert.deepEqual(render({ presentation }, text), ["[muted:3 refs]"]);
        const expanded = render({ presentation }, text, { expanded: true });
        assert.equal(expanded[0], "[muted:3 refs]");
        assert.ok(expanded.includes('[dim:  - ][accent:button][text: "7"][mdLink: @s21nz0od1aqhoj:e3][dim:]'));
        assert.ok(!expanded.some((line) => line.includes("Snapshot of Calculator")));
    });

    it("shows a failure as a reason and a hint", () => {
        const text = "agent-desktop click failed: STALE_REF: Ref no longer matches\nNext: snapshot again\nRetry: safe. Nothing reached the app.";
        assert.deepEqual(render(undefined, text, { isError: true }), ["[error:stale ref]  [dim:the UI changed; take a new snapshot]"]);
        assert.ok(render(undefined, text, { isError: true, expanded: true }).some((line) => line.includes("Retry: safe")));
    });

    it("draws nothing while a call is still running", () => {
        const partial = renderDesktopResult({ content: [], details: undefined } as never, { expanded: false, isPartial: true }, piTheme, { isError: false });
        assert.deepEqual(partial.render(80).filter((line) => line.trim()), []);
    });
});

describe("compact fallback renderer", () => {
    it("summarizes plain text for results saved before the presentation existed", () => {
        assert.equal(summarizeToolText("Found 3 elements.\n- a\n- b").summary, "Found 3 elements.");
        assert.equal(summarizeToolText("").summary, "Done");
    });
});
