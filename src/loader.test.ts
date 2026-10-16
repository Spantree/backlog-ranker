import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { findProjectRoot } from "./config.js";
import { isRefusal } from "./errors.js";
import { replayFetch } from "./fixtures/replay.js";
import { loadProject } from "./loader.js";
import { parseSource } from "./source.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "backlog-ranker-loader-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(file: string, text: string): void {
  mkdirSync(join(root, ".backlog-ranker"), { recursive: true });
  writeFileSync(join(root, ".backlog-ranker", file), text);
}

function refusal(fn: () => unknown): Error {
  try {
    fn();
  } catch (err) {
    expect(isRefusal(err)).toBe(true);
    return err as Error;
  }
  throw new Error("expected a refusal");
}

describe("loadProject", () => {
  test("a missing config refuses with the expected path and a minimal example", () => {
    mkdirSync(join(root, ".git"));
    const err = refusal(() => loadProject(root, {}));
    expect(err.message).toContain(join(root, ".backlog-ranker", "config.yaml"));
    expect(err.message).toContain("sources:");
    expect(err.message).toContain("backend: typesafe");
  });

  test("a project with only the directory from before the rename has no config", () => {
    mkdirSync(join(root, ".git"));
    const old = join(root, `.${["backlog", "decisions"].join("-")}`);
    mkdirSync(old);
    writeFileSync(join(old, "config.yaml"), "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    const err = refusal(() => loadProject(root, {}));
    expect(err.message).toContain(join(root, ".backlog-ranker", "config.yaml"));
  });

  test("reads the committed config and defaults the key variables", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\nmodel: jev-1.13\n");
    const project = loadProject(root, {});
    expect(project.projectRoot).toBe(root);
    expect(project.configPath).toBe(join(".backlog-ranker", "config.yaml"));
    expect(project.sources).toEqual(["github:kit/kit"]);
    expect(project.allowlistKey).toBe("sources in .backlog-ranker/config.yaml");
    expect(project.backend).toBe("typesafe");
    expect(project.config.keys).toEqual({
      github: "GITHUB_TOKEN",
      linear: "LINEAR_API_KEY",
      typesafe: "TYPESAFE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    });
  });

  test("keys.linear names the Linear key variable", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\nkeys:\n  linear: KIT_LINEAR_KEY\n");
    expect(loadProject(root, {}).config.keys.linear).toBe("KIT_LINEAR_KEY");
  });

  test("config.local.yaml replaces the committed config outright and is named", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    writeConfig("config.local.yaml", "sources:\n  - github:mine/fork\nbackend: openrouter\n");
    const project = loadProject(root, {});
    expect(project.configPath).toBe(join(".backlog-ranker", "config.local.yaml"));
    expect(project.sources).toEqual(["github:mine/fork"]);
    expect(project.backend).toBe("openrouter");
  });

  test("names the sources config.local.yaml lists that the committed config does not", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    writeConfig(
      "config.local.yaml",
      "sources:\n  - github:Kit/Kit\n  - github:mine/fork\n  - linear:eng\nbackend: openrouter\n",
    );
    expect(loadProject(root, {}).unreviewedSources).toEqual(["github:mine/fork", "linear:ENG"]);
  });

  test("without a committed config, every source config.local.yaml lists is unreviewed", () => {
    writeConfig("config.local.yaml", "sources:\n  - github:mine/fork\nbackend: openrouter\n");
    expect(loadProject(root, {}).unreviewedSources).toEqual(["github:mine/fork"]);
  });

  test("the committed config alone leaves no source unreviewed", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    expect(loadProject(root, {}).unreviewedSources).toEqual([]);
  });

  test.each([
    ["an unknown key", "sources: []\nbackend: typesafe\nextra: 1\n", "extra"],
    ["a bad source", "sources:\n  - jira:X\nbackend: typesafe\n", "sources.0"],
    ["an unknown backend", "sources: []\nbackend: acme\n", "backend"],
    ["a floating model", "sources: []\nbackend: typesafe\nmodel: jev-latest\n", "model"],
    ["an unknown key service", "sources: []\nbackend: typesafe\nkeys:\n  jira: JIRA_KEY\n", "keys"],
    [
      "linear.states not a list",
      "sources: []\nbackend: typesafe\nlinear:\n  states: Todo\n",
      "linear.states",
    ],
    ["an empty linear.states", "sources: []\nbackend: typesafe\nlinear:\n  states: []\n", "linear.states"],
    ["a blank state", "sources: []\nbackend: typesafe\nlinear:\n  states: ['']\n", "linear.states.0"],
    ["an unknown linear setting", "sources: []\nbackend: typesafe\nlinear:\n  team: KIT\n", "linear"],
    [
      "a key value instead of a name",
      "sources: []\nbackend: typesafe\nkeys:\n  github: ghp-abc\n",
      "keys.github",
    ],
  ])("refuses %s, naming the field", (_, text, field) => {
    writeConfig("config.yaml", text);
    const err = refusal(() => loadProject(root, {}));
    expect(err.message).toContain(".backlog-ranker/config.yaml is not a valid config");
    expect(err.message).toContain(field);
  });

  test("a YAML syntax error refuses with the line and column, never the file's text", () => {
    const pasted = "sk-or-v1-0123456789abcdef";
    writeConfig("config.yaml", `sources: []\nbackend: typesafe\nkeys:\n  github: ${pasted}: x\n`);
    const err = refusal(() => loadProject(root, {}));
    expect(err.message).toContain(".backlog-ranker/config.yaml is not valid YAML at line 4, column 11");
    expect(err.message).not.toContain(pasted);
    expect(err.message).not.toContain("github");
  });

  test("walks up from a subdirectory to the directory holding .backlog-ranker/", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\n");
    const deep = join(root, "packages", "a", "src");
    mkdirSync(deep, { recursive: true });
    expect(loadProject(deep, {}).projectRoot).toBe(root);
  });

  test.each([
    ["config.yaml", "config.yaml"],
    ["config.local.yaml", "config.local.yaml"],
    ["rubrics/", "rubrics/impact-roi.yaml"],
  ])(".backlog-ranker/%s marks a project root", (_, file) => {
    const inner = join(root, "inner");
    const path = join(inner, ".backlog-ranker", file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "sources: []\nbackend: typesafe\n");
    mkdirSync(join(inner, "src"));
    expect(findProjectRoot(join(inner, "src"))).toBe(inner);
  });

  test("a .backlog-ranker/ holding only a cache is not a root marker", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\n");
    const inner = join(root, "work");
    mkdirSync(join(inner, ".backlog-ranker", "cache"), { recursive: true });
    expect(findProjectRoot(inner)).toBe(root);
    expect(loadProject(inner, {}).projectRoot).toBe(root);
  });

  test("the walk stops at the nearest .git, so an outer config is not borrowed", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\n");
    const inner = join(root, "vendor", "repo");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const err = refusal(() => loadProject(join(inner), {}));
    expect(err.message).toContain(join(inner, ".backlog-ranker", "config.yaml"));
  });

  test("engine() refuses naming the backend's key variable when it is unset or empty", () => {
    writeConfig("config.yaml", "sources: []\nbackend: openrouter\n");
    expect(refusal(() => loadProject(root, {}).engine()).message).toContain("OPENROUTER_API_KEY is not set");
    expect(refusal(() => loadProject(root, { OPENROUTER_API_KEY: "" }).engine()).message).toContain(
      "OPENROUTER_API_KEY",
    );
  });

  test("engine() reads the key from the variable the config names", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\nkeys:\n  typesafe: MY_JEV_KEY\n");
    expect(refusal(() => loadProject(root, { TYPESAFE_API_KEY: "k" }).engine()).message).toContain(
      "MY_JEV_KEY is not set",
    );
    const engine = loadProject(root, { MY_JEV_KEY: "k" }).engine();
    expect({ id: engine.id, model: engine.model }).toEqual({ id: "typesafe", model: "jev-1.14" });
  });

  test("a 401 from the backend names the key variable the config renamed", async () => {
    writeConfig("config.yaml", "sources: []\nbackend: openrouter\nkeys:\n  openrouter: MY_OR_KEY\n");
    const net = replayFetch({ jevStatus: 401 });
    const engine = loadProject(root, { MY_OR_KEY: "k" }, { fetch: net.fetch }).engine();
    const err = await engine.decide({ title: "t" }, { q: { kind: "noul", instructions: "?" } }).then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(isRefusal(err)).toBe(true);
    expect(err?.message).toContain("HTTP 401; check MY_OR_KEY");
    expect(err?.message).not.toContain("OPENROUTER_API_KEY");
    expect(net.counts.jev).toBe(1);
  });

  test("tracker() refuses naming the token variable and the gh commands", () => {
    writeConfig(
      "config.yaml",
      "sources:\n  - github:kit/kit\nbackend: typesafe\nkeys:\n  github: GH_RO_TOKEN\n",
    );
    const err = refusal(() =>
      loadProject(root, { GITHUB_TOKEN: "t" }).tracker(parseSource("github:kit/kit")),
    );
    expect(err.message).toContain("GH_RO_TOKEN is not set");
    expect(err.message).toContain("gh auth login");
    expect(err.message).toContain("export GH_RO_TOKEN=$(gh auth token)");
    const tracker = loadProject(root, { GH_RO_TOKEN: "t" }).tracker(parseSource("github:kit/kit"));
    expect(tracker.source).toBe("github:kit/kit");
  });

  test("tracker() refuses an unlisted source with the allowlist refusal, reading no token", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    const err = refusal(() => loadProject(root, {}).tracker(parseSource("github:other/repo")));
    expect(err.message).toContain("github:other/repo is not on the backlog source allowlist");
    expect(err.message).toContain("No request was sent");
    expect(err.message).not.toContain("GITHUB_TOKEN");
  });

  test("tracker() decides on the ref's owner and repo, never the caller's spec string", () => {
    writeConfig("config.yaml", "sources:\n  - github:acme/app\nbackend: typesafe\n");
    const project = loadProject(root, { GITHUB_TOKEN: "t" });
    const forged = { kind: "github" as const, owner: "evil", repo: "secret", spec: "github:acme/app" };
    const err = refusal(() => project.tracker(forged));
    expect(err.message).toStartWith("github:evil/secret is not on the backlog source allowlist");
    const cased = { kind: "github" as const, owner: "Acme", repo: "App", spec: "github:Acme/App" };
    expect(project.tracker(cased).source).toBe("github:acme/app");
  });

  test("tracker() decides on a Linear ref's team, never the caller's spec string", () => {
    writeConfig("config.yaml", "sources:\n  - linear:KIT\nbackend: typesafe\n");
    const project = loadProject(root, { LINEAR_API_KEY: "k" });
    const forged = { kind: "linear" as const, team: "OPS", spec: "linear:KIT" };
    expect(refusal(() => project.tracker(forged)).message).toStartWith(
      "linear:OPS is not on the backlog source allowlist",
    );
    expect(project.tracker({ kind: "linear", team: "kit", spec: "linear:kit" }).source).toBe("linear:KIT");
  });

  test("--allow-once admits the source its ref's fields name, not its spec string", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\n");
    const forged = { kind: "github" as const, owner: "evil", repo: "secret", spec: "github:acme/app" };
    const project = loadProject(root, { GITHUB_TOKEN: "t" }, { allowOnce: forged });
    expect(project.sources).toEqual(["github:evil/secret"]);
    expect(refusal(() => project.tracker(parseSource("github:acme/app"))).message).toContain(
      "not on the backlog source allowlist",
    );
  });

  test("the allowlist refusal names config.yaml when that is the file read", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    const project = loadProject(root, {});
    const err = refusal(() => project.tracker(parseSource("github:other/repo")));
    expect(err.message).toContain('add "github:other/repo" to sources in .backlog-ranker/config.yaml');
    expect(err.message).not.toContain("config.local.yaml");
  });

  test("the allowlist refusal names config.local.yaml when that is the file read", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    writeConfig("config.local.yaml", "sources:\n  - github:mine/fork\nbackend: openrouter\n");
    const project = loadProject(root, {});
    expect(project.allowlistKey).toBe("sources in .backlog-ranker/config.local.yaml");
    const err = refusal(() => project.tracker(parseSource("github:other/repo")));
    expect(err.message).toContain('add "github:other/repo" to sources in .backlog-ranker/config.local.yaml');
    expect(err.message).not.toContain("config.yaml");
    expect(err.message).not.toContain("committed");
  });

  test("tracker() admits the one source --allow-once names", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    const other = parseSource("github:other/repo");
    const project = loadProject(root, { GITHUB_TOKEN: "t" }, { allowOnce: other });
    expect(project.tracker(other).source).toBe("github:other/repo");
    expect(refusal(() => project.tracker(parseSource("github:third/repo"))).message).toContain(
      "not on the backlog source allowlist",
    );
  });

  test("tracker() builds the Linear tracker for an allowlisted linear: source", async () => {
    writeConfig("config.yaml", "sources:\n  - linear:kit\nbackend: typesafe\n");
    const net = replayFetch();
    const tracker = loadProject(root, { LINEAR_API_KEY: "k" }, { fetch: net.fetch }).tracker(
      parseSource("linear:KIT"),
    );
    expect(tracker.source).toBe("linear:KIT");
    expect((await tracker.pending()).map((t) => t.key)).toEqual([
      "KIT-1",
      "KIT-2",
      "KIT-3",
      "KIT-4",
      "KIT-5",
      "KIT-6",
    ]);
    expect(net.counts).toEqual({ github: 0, linear: 2, jev: 0, other: 0 });
  });

  test("tracker() refuses an unset Linear key naming the variable the config names", () => {
    writeConfig(
      "config.yaml",
      "sources:\n  - linear:KIT\nbackend: typesafe\nkeys:\n  linear: KIT_LINEAR_KEY\n",
    );
    const err = refusal(() =>
      loadProject(root, { LINEAR_API_KEY: "k", GITHUB_TOKEN: "t" }).tracker(parseSource("linear:KIT")),
    );
    expect(err.message).toContain("KIT_LINEAR_KEY is not set");
    expect(err.message).toContain("https://linear.app/settings/account/security");
    expect(err.message).not.toContain("GITHUB_TOKEN");
  });

  test("a 401 from Linear names the key variable the config renamed, never the key", async () => {
    writeConfig(
      "config.yaml",
      "sources:\n  - linear:KIT\nbackend: typesafe\nkeys:\n  linear: KIT_LINEAR_KEY\n",
    );
    const fetch = (async () => new Response("denied", { status: 401 })) as unknown as typeof globalThis.fetch;
    const tracker = loadProject(root, { KIT_LINEAR_KEY: "lin_api_SECRET" }, { fetch }).tracker(
      parseSource("linear:KIT"),
    );
    const err = await tracker.pending().then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    expect(isRefusal(err)).toBe(true);
    expect(err?.message).toContain("HTTP 401");
    expect(err?.message).toContain("KIT_LINEAR_KEY");
    expect(err?.message).not.toContain("lin_api_SECRET");
    expect(err?.message).not.toContain("denied");
  });

  test("linear.states reaches the Linear tracker", async () => {
    writeConfig("config.yaml", "sources:\n  - linear:KIT\nbackend: typesafe\nlinear:\n  states: [Todo]\n");
    const net = replayFetch();
    const project = loadProject(root, { LINEAR_API_KEY: "k" }, { fetch: net.fetch });
    expect(project.config.linear).toEqual({ states: ["Todo"] });
    const tickets = await project.tracker(parseSource("linear:KIT")).pending();
    expect(tickets.map((t) => t.key)).toEqual(["KIT-1", "KIT-3", "KIT-6"]);
  });
});
