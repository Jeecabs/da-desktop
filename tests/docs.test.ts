import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { MIN_AGENT_DESKTOP_VERSION } from "../src/agent-desktop-version.ts";
import { DESKTOP_TOOLS } from "../src/desktop-tools.ts";

// The docs and the skill name tools and parameters by hand; these keep them honest.

const read = (path: string): string => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const names = new Set(DESKTOP_TOOLS.map((spec) => spec.name));
const DOCS = ["README.md", "CONTEXT.md", "docs/tools.md", "docs/agent-desktop-v1.3.1.md", "skills/desktop/SKILL.md"];

test("every desktop_* tool the docs mention exists", () => {
  for (const path of DOCS) {
    for (const mention of read(path).match(/\bdesktop_[a-z]+\b/g) ?? []) {
      // agent-desktop's own MCP server names its tools after commands, which the reference doc quotes.
      if (mention === "desktop_session") continue;
      assert.ok(names.has(mention), `${path} mentions ${mention}`);
    }
  }
});

test("the README and the tool reference list every tool", () => {
  for (const path of ["README.md", "docs/tools.md"]) {
    const text = read(path);
    for (const name of names) assert.ok(text.includes(`\`${name}\``), `${path} is missing ${name}`);
  }
  assert.match(read("README.md"), new RegExp(`^${names.size} tools, the same in both hosts`, "m"));
});

test("the skill has frontmatter and uses real parameters", () => {
  const skill = read("skills/desktop/SKILL.md");
  assert.match(skill, /^---\nname: desktop\ndescription: .+\ncompatibility: .+\n---\n/);
  const properties = new Set(DESKTOP_TOOLS.flatMap((spec) => Object.keys(spec.parameters.properties)));
  for (const [, parameter] of skill.matchAll(/`desktop_[a-z]+ ([a-zA-Z]+)=/g)) {
    assert.ok(properties.has(parameter!), `the skill uses ${parameter}=`);
  }
});

test("the pinned version is the one the docs and manifests name", () => {
  assert.match(read("README.md"), new RegExp(`agent-desktop\\) ${MIN_AGENT_DESKTOP_VERSION.replace(/\./g, "\\.")} or newer`));
  assert.ok(read(`docs/agent-desktop-v${MIN_AGENT_DESKTOP_VERSION}.md`).includes(`**${MIN_AGENT_DESKTOP_VERSION}**`));
  const pkg = JSON.parse(read("package.json")) as { version: string };
  const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { version: string };
  assert.equal(plugin.version, pkg.version);
});
