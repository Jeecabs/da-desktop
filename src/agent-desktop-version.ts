// 1.3.1: the release da-desktop was written against (JSON envelope 2.6). Snapshot-qualified
// refs, error.disposition and --stdin all predate it; see docs/agent-desktop-v1.3.1.md.
export const MIN_AGENT_DESKTOP_VERSION = "1.3.1";

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

/** Reads `agent-desktop 1.3.1` (--version) or the `version` command's JSON envelope. */
export function extractAgentDesktopVersion(output: string): string | undefined {
  return (
    output.match(/agent-desktop\s+v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/i)?.[1] ??
    output.match(/"data"\s*:\s*\{[^{}]*"version"\s*:\s*"(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)"/)?.[1]
  );
}

export function supportsAgentDesktopVersion(
  installed: string,
  required = MIN_AGENT_DESKTOP_VERSION,
): boolean {
  const current = parseVersion(installed);
  const minimum = parseVersion(required);
  if (!current || !minimum) return false;

  const order = coreVersionOrder(current) - coreVersionOrder(minimum);
  if (order !== 0) return order > 0;
  return supportsEqualCoreVersion(current, minimum);
}

function coreVersionOrder(version: ParsedVersion): number {
  return version.major * 1_000_000 + version.minor * 1_000 + version.patch;
}

function supportsEqualCoreVersion(current: ParsedVersion, minimum: ParsedVersion): boolean {
  if (!current.prerelease) return true;
  if (!minimum.prerelease) return false;
  return current.prerelease >= minimum.prerelease;
}

function parseVersion(version: string): ParsedVersion | undefined {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return undefined;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4],
  };
}
