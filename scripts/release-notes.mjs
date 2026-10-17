#!/usr/bin/env node
// Usage: node scripts/release-notes.mjs <version>
// Read the dated release section from CHANGELOG.md in the working directory.
import { readFileSync } from "node:fs";

const version = process.argv[2];
try {
  if (!version || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) {
    throw new Error("pass a release version, such as 0.2.0");
  }
  const changelog = readFileSync("CHANGELOG.md", "utf8").replaceAll("\r\n", "\n");
  const sections = changelog.split(/^## /m).slice(1);
  const matching = sections.filter((section) => {
    const heading = section.split("\n", 1)[0];
    const match = /^(?:\[([^\]]+)\]|(\S+)) - \d{4}-\d{2}-\d{2}\s*$/.exec(heading);
    return (match?.[1] ?? match?.[2]) === version;
  });
  if (matching.length !== 1) {
    throw new Error(`expected exactly one dated section for ${version}, found ${matching.length}`);
  }
  // Reference definitions usually live below the last release. Keep them
  // available regardless of which version is selected, but never count them
  // as release content.
  const definition = /^\[[^\]]+\]:[^\n]*$/gm;
  const references = changelog.match(definition) ?? [];
  const body = matching[0].split("\n").slice(1).join("\n").replace(definition, "").trim();
  const content = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^#{1,6}\s.*$/gm, "")
    .trim();
  if (!content) throw new Error(`the section for ${version} is empty`);
  const parts = [`npm: https://www.npmjs.com/package/@feniix/backlog-ranker/v/${version}`, body];
  if (references.length > 0) parts.push(references.join("\n"));
  console.log(parts.join("\n\n"));
} catch (error) {
  console.error(`CHANGELOG.md: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
