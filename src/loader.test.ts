import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRefusal } from "./errors.js";
import { replayFetch } from "./fixtures/replay.js";
import { loadProject } from "./loader.js";
import { parseSource } from "./source.js";

let root: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "backlog-decisions-loader-")));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(file: string, text: string): void {
  mkdirSync(join(root, ".backlog-decisions"), { recursive: true });
  writeFileSync(join(root, ".backlog-decisions", file), text);
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
    expect(err.message).toContain(join(root, ".backlog-decisions", "config.yaml"));
    expect(err.message).toContain("sources:");
    expect(err.message).toContain("backend: typesafe");
  });

  test("reads the committed config and defaults the key variables", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\nmodel: jev-1.13\n");
    const project = loadProject(root, {});
    expect(project.projectRoot).toBe(root);
    expect(project.configPath).toBe(join(".backlog-decisions", "config.yaml"));
    expect(project.sources).toEqual(["github:kit/kit"]);
    expect(project.allowlistKey).toBe("sources in .backlog-decisions/config.yaml");
    expect(project.backend).toBe("typesafe");
    expect(project.config.keys).toEqual({
      github: "GITHUB_TOKEN",
      typesafe: "TYPESAFE_API_KEY",
      openrouter: "OPENROUTER_API_KEY",
    });
  });

  test("config.local.yaml replaces the committed config outright and is named", () => {
    writeConfig("config.yaml", "sources:\n  - github:kit/kit\nbackend: typesafe\n");
    writeConfig("config.local.yaml", "sources:\n  - github:mine/fork\nbackend: openrouter\n");
    const project = loadProject(root, {});
    expect(project.configPath).toBe(join(".backlog-decisions", "config.local.yaml"));
    expect(project.sources).toEqual(["github:mine/fork"]);
    expect(project.backend).toBe("openrouter");
  });

  test.each([
    ["an unknown key", "sources: []\nbackend: typesafe\nextra: 1\n", "extra"],
    ["a bad source", "sources:\n  - jira:X\nbackend: typesafe\n", "sources.0"],
    ["an unknown backend", "sources: []\nbackend: acme\n", "backend"],
    ["a floating model", "sources: []\nbackend: typesafe\nmodel: jev-latest\n", "model"],
    [
      "a key value instead of a name",
      "sources: []\nbackend: typesafe\nkeys:\n  github: ghp-abc\n",
      "keys.github",
    ],
  ])("refuses %s, naming the field", (_, text, field) => {
    writeConfig("config.yaml", text);
    const err = refusal(() => loadProject(root, {}));
    expect(err.message).toContain(".backlog-decisions/config.yaml is not a valid config");
    expect(err.message).toContain(field);
  });

  test("walks up from a subdirectory to the directory holding .backlog-decisions/", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\n");
    const deep = join(root, "packages", "a", "src");
    mkdirSync(deep, { recursive: true });
    expect(loadProject(deep, {}).projectRoot).toBe(root);
  });

  test("the walk stops at the nearest .git, so an outer config is not borrowed", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\n");
    const inner = join(root, "vendor", "repo");
    mkdirSync(join(inner, ".git"), { recursive: true });
    const err = refusal(() => loadProject(join(inner), {}));
    expect(err.message).toContain(join(inner, ".backlog-decisions", "config.yaml"));
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
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\nkeys:\n  github: GH_RO_TOKEN\n");
    const err = refusal(() =>
      loadProject(root, { GITHUB_TOKEN: "t" }).tracker(parseSource("github:kit/kit")),
    );
    expect(err.message).toContain("GH_RO_TOKEN is not set");
    expect(err.message).toContain("gh auth login");
    expect(err.message).toContain("export GH_RO_TOKEN=$(gh auth token)");
    const tracker = loadProject(root, { GH_RO_TOKEN: "t" }).tracker(parseSource("github:kit/kit"));
    expect(tracker.source).toBe("github:kit/kit");
  });

  test("tracker() refuses a Linear source as a planned adapter", () => {
    writeConfig("config.yaml", "sources: []\nbackend: typesafe\n");
    expect(refusal(() => loadProject(root, {}).tracker(parseSource("linear:KIT"))).message).toContain(
      "planned",
    );
  });
});
