// What the desktop core needs from whoever runs it. pi implements it with pi.exec and
// node:fs (pi-host.ts); the Claude Code mod implements it with $.process and $.fs.
// Nothing in the core imports Node or a host package, so both can load it.

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
  killed?: boolean;
}

export interface ExecOptions {
  timeout: number;
  /**
   * Text piped to the command's stdin. Typed text, set values and clipboard writes travel
   * this way (`--stdin`), so they never appear in the process arguments.
   */
  stdin?: string;
}

export interface DesktopHost {
  /** Runs a command by argv, no shell. Cancellation belongs to the host's own signal. */
  exec(command: string, args: string[], options: ExecOptions): Promise<ExecResult>;
  /** Writes a text file, creating its directories. */
  writeFile(path: string, text: string): Promise<void>;
  /** Writes a file only the user can read (directory 700, file 600), never briefly wider. */
  writePrivateFile(path: string, text: string): Promise<void>;
  /** Creates a directory only the user can enter (700): artifacts hold private screen content. */
  ensurePrivateDir(path: string): Promise<void>;
  cwd: string;
  homeDir: string;
  /** The host session's id; hashed into the agent-desktop session namespace. */
  sessionId: string;
  /** Names the host in the namespace (`pi-…`, `cc-…`) so sessions never share refs. */
  sessionPrefix: string;
}
