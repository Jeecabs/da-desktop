import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { DesktopHost, ExecResult } from "./host.ts";

/**
 * pi.exec has no stdin, so a command that reads piped text is spawned here: no shell, the
 * text written to the pipe and never placed in argv, the call's signal and timeout honoured.
 */
export function execWithStdin(
  command: string,
  args: string[],
  options: { stdin: string; timeout: number; signal?: AbortSignal },
): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let killed = false;
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], signal: options.signal });
    const timer = setTimeout(() => {
      killed = true;
      child.kill("SIGKILL");
    }, options.timeout);
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    // A command that cannot start, or is aborted, reports as a failed run like pi.exec does.
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr || error.message, code: 1, killed: true });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1, killed });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin);
  });
}

/** The desktop core's host under pi: pi.exec bound to the call's signal, and node:fs. */
export function piHost(pi: ExtensionAPI, ctx: ExtensionContext): DesktopHost {
  return {
    exec: (command, args, { timeout, stdin }) =>
      stdin === undefined
        ? (pi.exec(command, args, { signal: ctx.signal, timeout }) as Promise<ExecResult>)
        : execWithStdin(command, args, { stdin, timeout, signal: ctx.signal }),
    async writeFile(path, text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, "utf8");
    },
    async writePrivateFile(path, text) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await writeFile(path, text, { mode: 0o600 });
      await chmod(path, 0o600); // writeFile's mode only applies when it creates the file
    },
    async ensurePrivateDir(path) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await chmod(path, 0o700); // mkdir's mode only applies when it creates the directory
    },
    cwd: ctx.cwd,
    homeDir: homedir(),
    sessionId: ctx.sessionManager.getSessionId(),
    sessionPrefix: "pi",
  };
}
