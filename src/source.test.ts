import { describe, expect, test } from "bun:test";
import { isRefusal } from "./errors.js";
import { assertAllowed, parseSource } from "./source.js";

describe("parseSource", () => {
  test.each([
    [
      "github:octo/hello-world",
      { kind: "github", owner: "octo", repo: "hello-world", spec: "github:octo/hello-world" },
    ],
    [
      "github:Octo/Hello.World",
      { kind: "github", owner: "Octo", repo: "Hello.World", spec: "github:octo/hello.world" },
    ],
    ["linear:eva", { kind: "linear", team: "EVA", spec: "linear:EVA" }],
  ])("%s parses", (spec, expected) => {
    expect(parseSource(spec)).toEqual(expected as never);
  });

  test.each([
    "EVA",
    "linear:",
    "linear:E V",
    "jira:X",
    "github:",
    "github:owner",
    "github:a/b/c",
    "github:/r",
  ])("%s is refused naming both spellings", (bad) => {
    let err: unknown;
    try {
      parseSource(bad);
    } catch (e) {
      err = e;
    }
    expect(isRefusal(err)).toBe(true);
    expect((err as Error).message).toBe(
      `--source takes github:<owner>/<repo> (for example github:octocat/hello-world) or linear:<TEAM>, not "${bad}"`,
    );
  });
});

describe("assertAllowed", () => {
  test("admits a listed source, matching case-insensitively", () => {
    expect(() => assertAllowed(parseSource("github:Kit/Kit"), ["github:kit/kit"], "sources")).not.toThrow();
  });

  test("refuses an unlisted source, says nothing was sent and names the settings key", () => {
    let err: unknown;
    try {
      assertAllowed(
        parseSource("github:acme/app"),
        ["github:kit/kit", "garbage"],
        "sources in .backlog-decisions/config.yaml",
      );
    } catch (e) {
      err = e;
    }
    expect(isRefusal(err)).toBe(true);
    expect((err as Error).message).toBe(
      "github:acme/app is not on the backlog source allowlist (sources in .backlog-decisions/config.yaml; it lists github:kit/kit). " +
        'No request was sent. To rank this backlog, add "github:acme/app" to sources in .backlog-decisions/config.yaml ' +
        "in the project's committed settings, so the decision to send its tickets to the " +
        "decision engine is reviewed like any other change.",
    );
  });

  test("an empty allowlist says it lists no sources", () => {
    expect(() => assertAllowed(parseSource("linear:EVA"), [], "sources")).toThrow("it lists no sources");
  });
});
