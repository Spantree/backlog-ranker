import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release-notes.mjs", import.meta.url));
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function notes(changelog: string, version = "0.2.0") {
  const cwd = mkdtempSync(join(tmpdir(), "release-notes-"));
  roots.push(cwd);
  writeFileSync(join(cwd, "CHANGELOG.md"), changelog);
  return spawnSync("node", [script, version], { cwd, encoding: "utf8" });
}

describe("release notes from the changelog", () => {
  test("selects the exact version, keeps its Markdown and resolves reference links", () => {
    const result = notes(`# Changelog

## Unreleased

- Future work.

## [0.2.0] - 2026-10-20

### Fixed

- Preserve [gate outcomes][gates].

## 0.1.0 - 2026-10-16

- Old work.

[gates]: https://example.com/gates
`);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      "npm: https://www.npmjs.com/package/@feniix/backlog-ranker/v/0.2.0\n\n" +
        "### Fixed\n\n- Preserve [gate outcomes][gates].\n\n" +
        "[gates]: https://example.com/gates\n",
    );
  });

  test("accepts an unbracketed version heading and the last section", () => {
    const result = notes("## Unreleased\n\n## 0.2.0 - 2026-10-20\n\n### Changed\n\n- Gate policy.\n");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("### Changed\n\n- Gate policy.");
  });

  test.each([
    ["missing", "## Unreleased\n\n- Future work.\n\n## 0.2.01 - 2026-10-20\n\n- Other version.\n"],
    ["empty", "## 0.2.0 - 2026-10-20\n\n### Fixed\n\n<!-- pending -->\n"],
    ["heading-only", "## 0.2.0 - 2026-10-20"],
    ["duplicate", "## 0.2.0 - 2026-10-20\n\n- First.\n\n## [0.2.0] - 2026-10-20\n\n- Second.\n"],
    ["undated", "## 0.2.0\n\n- Not ready.\n"],
  ])("refuses a %s release section without printing partial notes", (_kind, changelog) => {
    const result = notes(changelog);
    expect(result.status).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("CHANGELOG.md");
    expect(result.stderr).toContain("0.2.0");
  });
});
