import { describe, expect, test } from "bun:test";
import { isRefusal } from "./errors.js";
import { assertAllowed, issueKeyIn, parseIssueKey, parseSource } from "./source.js";

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
        "sources in .backlog-ranker/config.yaml",
      );
    } catch (e) {
      err = e;
    }
    expect(isRefusal(err)).toBe(true);
    expect((err as Error).message).toBe(
      "github:acme/app is not on the backlog source allowlist (sources in .backlog-ranker/config.yaml; it lists github:kit/kit). " +
        'No request was sent. To rank this backlog, add "github:acme/app" to sources in .backlog-ranker/config.yaml, ' +
        "so the decision to send its tickets to the decision engine is reviewed like any " +
        "other settings change.",
    );
  });

  test("an empty allowlist says it lists no sources", () => {
    expect(() => assertAllowed(parseSource("linear:EVA"), [], "sources")).toThrow("it lists no sources");
  });
});

describe("parseIssueKey", () => {
  test("owner/repo#N yields its GitHub source", () => {
    const parsed = parseIssueKey("kit/kit#3");
    expect(parsed.source.spec).toBe("github:kit/kit");
    expect(parsed.key).toBe("kit/kit#3");
  });

  test("TEAM-N yields its Linear source and the uppercased key", () => {
    const parsed = parseIssueKey("kit-3");
    expect(parsed.source).toEqual({ kind: "linear", team: "KIT", spec: "linear:KIT" });
    expect(parsed.key).toBe("KIT-3");
    expect(parsed.number).toBe(3);
  });

  test.each(["3", "#3", "KIT-0", "KIT-", "-3", "K I-3", "kit/kit#0", "TOOLONGTEAM1-3"])(
    "%s is refused naming both key spellings",
    (bad) => {
      let err: unknown;
      try {
        parseIssueKey(bad);
      } catch (e) {
        err = e;
      }
      expect(isRefusal(err)).toBe(true);
      expect((err as Error).message).toContain("<owner>/<repo>#<number>");
      expect((err as Error).message).toContain("<TEAM>-<number>");
    },
  );
});

describe("issueKeyIn", () => {
  const github = parseSource("github:Kit/Kit");
  const linear = parseSource("linear:KIT");

  test("spells a GitHub source's keys as the tracker does", () => {
    expect(issueKeyIn("kit/KIT#3", github, { bare: false })).toBe("Kit/Kit#3");
    expect(issueKeyIn("#3", github, { bare: true })).toBe("Kit/Kit#3");
    expect(issueKeyIn("3", github, { bare: false })).toBeUndefined();
    expect(issueKeyIn("other/repo#3", github, { bare: true })).toBeUndefined();
    expect(issueKeyIn("KIT-3", github, { bare: true })).toBeUndefined();
  });

  test("spells a Linear source's keys as TEAM-N, expanding bare numbers to its team", () => {
    expect(issueKeyIn("kit-3", linear, { bare: false })).toBe("KIT-3");
    expect(issueKeyIn("3", linear, { bare: true })).toBe("KIT-3");
    expect(issueKeyIn("#3", linear, { bare: true })).toBe("KIT-3");
    expect(issueKeyIn("3", linear, { bare: false })).toBeUndefined();
    expect(issueKeyIn("EVA-3", linear, { bare: true })).toBeUndefined();
    expect(issueKeyIn("kit/kit#3", linear, { bare: true })).toBeUndefined();
  });
});
