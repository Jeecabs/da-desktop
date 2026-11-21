import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
    createDesktopState,
    desktopHealth,
    desktopSummary,
    formatRelativeTime,
    mergeDesktopState,
    resolveAgentDesktopBin,
    resolveHeadedDefault,
    sanitizeArtifactLabel,
    serializeDesktopState,
    type DesktopState,
} from "../src/state.ts";

afterEach(() => {
    delete process.env.DA_DESKTOP_HEADED;
    delete process.env.DA_DESKTOP_BIN;
});

const ready = (): DesktopState => ({
    ...createDesktopState("/tmp/project"),
    agentDesktopVersion: "1.3.1",
    agentDesktopCompatible: true,
    platform: "macos",
    permissions: { accessibility: "granted", screenRecording: "granted", automation: "unknown" },
    lastVerifiedAt: Date.now(),
});

describe("createDesktopState", () => {
    it("keeps artifacts in a per-project temp directory", () => {
        const state = createDesktopState("/Users/someone/My Project");
        assert.match(state.artifactDir, /\/da-desktop\/My-Project-[0-9a-f]+$/);
        assert.notEqual(state.artifactDir, createDesktopState("/Users/other/My Project").artifactDir);
        assert.equal(state.headed, false);
    });
});

describe("physical input", () => {
    it("is off unless DA_DESKTOP_HEADED says otherwise", () => {
        assert.equal(resolveHeadedDefault(), false);
        for (const value of ["1", "true", " ON ", "yes"]) {
            process.env.DA_DESKTOP_HEADED = value;
            assert.equal(resolveHeadedDefault(), true, value);
        }
        for (const value of ["0", "false", "off", "", "maybe"]) {
            process.env.DA_DESKTOP_HEADED = value;
            assert.equal(resolveHeadedDefault(), false, value);
        }
    });

    it("survives a reload once the user has allowed it, and only then", () => {
        assert.equal(mergeDesktopState("/tmp/p", { headed: true }).headed, true);
        assert.equal(mergeDesktopState("/tmp/p", { headed: "true" }).headed, false);
        assert.equal(mergeDesktopState("/tmp/p", {}).headed, false);
        process.env.DA_DESKTOP_HEADED = "1";
        assert.equal(mergeDesktopState("/tmp/p", { headed: false }).headed, true);
    });
});

describe("state serialization", () => {
    it("round-trips", () => {
        const state: DesktopState = { ...ready(), headed: true, app: "Finder", lastSnapshotId: "s1", lastSnapshotAt: 5, lastSnapshotFile: "/tmp/s.txt", lastScreenshotFile: "/tmp/a.png", lastAction: "click", lastError: "boom" };
        assert.deepEqual(mergeDesktopState("/tmp/project", JSON.parse(JSON.stringify(serializeDesktopState(state)))), state);
    });

    it("ignores junk and recomputes the artifact directory for the cwd", () => {
        assert.deepEqual(mergeDesktopState("/tmp/project", "nope"), createDesktopState("/tmp/project"));
        const merged = mergeDesktopState("/tmp/project", { artifactDir: "/etc", app: 5, lastSnapshotAt: "now", permissions: { accessibility: 1, screenRecording: "denied" } });
        assert.equal(merged.artifactDir, createDesktopState("/tmp/project").artifactDir);
        assert.equal(merged.app, undefined);
        assert.equal(merged.lastSnapshotAt, undefined);
        assert.deepEqual(merged.permissions, { accessibility: undefined, screenRecording: "denied", automation: undefined });
    });
});

describe("desktopHealth", () => {
    it("is unknown until checked, blocked when something is missing, ok otherwise", () => {
        assert.equal(desktopHealth(createDesktopState("/tmp/p")), "unknown");
        assert.equal(desktopHealth(ready()), "ok");
        assert.equal(desktopHealth({ ...ready(), agentDesktopCompatible: false }), "blocked");
        assert.equal(desktopHealth({ ...ready(), permissions: { accessibility: "denied" } }), "blocked");
        // Windows and Linux report not_required or unknown where nothing needs granting.
        assert.equal(desktopHealth({ ...ready(), permissions: { accessibility: "unknown" } }), "ok");
        assert.equal(desktopHealth({ ...ready(), permissions: { accessibility: "not_required" } }), "ok");
    });
});

describe("desktopSummary", () => {
    it("states the checkable facts", () => {
        const summary = desktopSummary({ ...ready(), app: "Finder", lastAction: "click" }, {
            agentDesktopVersion: "1.3.1",
            agentDesktopCompatible: true,
            requiredAgentDesktopVersion: "1.3.1",
            agentDesktopSession: "pi-0123456789abcdef",
            supportedSurfaces: ["window", "menu"],
            stateRoot: "/h/.agent-desktop",
        });
        assert.match(summary, /^● ready  macos  verified just now$/m);
        assert.match(summary, /^  cli       agent-desktop 1\.3\.1  ok$/m);
        assert.match(summary, /^  access    accessibility granted · screen recording granted · automation unknown$/m);
        assert.match(summary, /^  input     headless \(accessibility actions only/m);
        assert.match(summary, /^  app       Finder$/m);
        assert.match(summary, /^  session   pi-0123456789abcdef$/m);
        assert.match(summary, /^  surfaces  window, menu$/m);
    });

    it("says what blocks it", () => {
        const old = desktopSummary({ ...ready(), agentDesktopVersion: "1.0.0", agentDesktopCompatible: false }, {
            agentDesktopVersion: "1.0.0",
            agentDesktopCompatible: false,
            requiredAgentDesktopVersion: "1.3.1",
            agentDesktopSession: "pi-x",
        });
        assert.match(old, /^○ blocked/);
        assert.match(old, /agent-desktop 1\.0\.0  requires >=1\.3\.1/);
        assert.match(desktopSummary({ ...createDesktopState("/tmp/p"), agentDesktopCompatible: false }), /agent-desktop not found/);
        assert.match(desktopSummary({ ...ready(), headed: true }), /input     headed allowed/);
        assert.match(desktopSummary({ ...ready(), lastError: "first line\nsecond line" }), /error     first line$/m);
    });
});

describe("small helpers", () => {
    it("resolves the executable", () => {
        assert.equal(resolveAgentDesktopBin(), "agent-desktop");
        process.env.DA_DESKTOP_BIN = " /opt/bin/agent-desktop ";
        assert.equal(resolveAgentDesktopBin(), "/opt/bin/agent-desktop");
    });

    it("sanitizes artifact labels and formats ages", () => {
        assert.equal(sanitizeArtifactLabel(" Finder Window / 2 "), "finder-window-2");
        assert.equal(sanitizeArtifactLabel("///"), "artifact");
        assert.equal(formatRelativeTime(undefined), "-");
        assert.equal(formatRelativeTime(Date.now() - 65_000), "1m ago");
    });
});
