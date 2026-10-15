import { describe, expect, test } from "bun:test";
import { type CliIo, run } from "./cli.js";

function capture(env: Record<string, string | undefined> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    stdout: (text) => {
      out.push(text);
    },
    stderr: (text) => {
      err.push(text);
    },
    env,
  };
  return { io, out: () => out.join(""), err: () => err.join("") };
}

describe("help", () => {
  test("--help is a help request: usage on stdout, nothing on stderr, exit 0", async () => {
    const c = capture();
    expect(await run(["--help"], c.io)).toBe(0);
    expect(c.out()).toContain("backlog-ranker <verb>");
    for (const verb of ["rank", "calibrate", "explain"]) expect(c.out()).toContain(verb);
    expect(c.err()).toBe("");
  });

  test("-h is help too", async () => {
    const c = capture();
    expect(await run(["-h"], c.io)).toBe(0);
    expect(c.out()).toContain("backlog-ranker <verb>");
  });

  test("help shows the default rank form first, then calibrate and explain", async () => {
    const c = capture();
    await run(["--help"], c.io);
    const text = c.out();
    expect(text).toStartWith("usage: backlog-ranker [rank] -r <rubric> -s <source>");
    const at = (form: string): number => text.indexOf(form);
    expect(at("backlog-ranker calibrate")).toBeGreaterThan(at("backlog-ranker [rank]"));
    expect(at("backlog-ranker explain")).toBeGreaterThan(at("backlog-ranker calibrate"));
  });

  test("no arguments is also help", async () => {
    const c = capture();
    expect(await run([], c.io)).toBe(0);
    expect(c.out()).toContain("backlog-ranker <verb>");
  });

  test.each(["rank", "calibrate", "explain"])("%s --help and -h print the verb's usage", async (verb) => {
    for (const flag of ["--help", "-h"]) {
      const c = capture();
      expect(await run([verb, flag], c.io)).toBe(0);
      expect(c.out()).toContain(verb === "rank" ? "backlog-ranker [rank]" : `backlog-ranker ${verb}`);
      expect(c.out()).toContain("--rubric");
      expect(c.err()).toBe("");
    }
  });
});

describe("the default verb", () => {
  function recording() {
    const calls: Array<{ verb: string; args: readonly string[] }> = [];
    const verbs = Object.fromEntries(
      ["rank", "calibrate", "explain"].map((verb) => [
        verb,
        (args: readonly string[]) => {
          calls.push({ verb, args });
        },
      ]),
    );
    return { calls, verbs };
  }

  test("a first argument that is a flag runs rank with every argument", async () => {
    const r = recording();
    const argv = ["-r", "impact-roi", "-s", "github:octocat/hello-world", "--json"];
    expect(await run(argv, capture().io, { verbs: r.verbs })).toBe(0);
    expect(r.calls).toEqual([{ verb: "rank", args: argv }]);
  });

  test("a long flag first runs rank too", async () => {
    const r = recording();
    const argv = ["--rubric", "impact-roi", "--source", "github:octocat/hello-world"];
    expect(await run(argv, capture().io, { verbs: r.verbs })).toBe(0);
    expect(r.calls).toEqual([{ verb: "rank", args: argv }]);
  });

  test("rank stays an explicit verb and receives the arguments after it", async () => {
    const r = recording();
    expect(await run(["rank", "-r", "x", "-s", "github:a/b"], capture().io, { verbs: r.verbs })).toBe(0);
    expect(r.calls).toEqual([{ verb: "rank", args: ["-r", "x", "-s", "github:a/b"] }]);
  });

  test("a mistyped verb is refused naming it and listing the verbs, and runs nothing", async () => {
    const r = recording();
    const c = capture();
    expect(await run(["explian", "-r", "x"], c.io, { verbs: r.verbs })).toBe(1);
    expect(r.calls).toEqual([]);
    expect(c.out()).toBe("");
    expect(c.err()).toStartWith("unknown verb `explian`; expected one of rank, calibrate, explain");
  });

  test("--version is not a rank flag: it is refused and runs nothing", async () => {
    const r = recording();
    const c = capture();
    expect(await run(["--version"], c.io, { verbs: r.verbs })).toBe(1);
    expect(r.calls).toEqual([]);
  });
});

describe("refusals", () => {
  test("an unknown verb refuses message-first on stderr with exit 1 and no frames", async () => {
    const c = capture();
    expect(await run(["bogus"], c.io)).toBe(1);
    expect(c.out()).toBe("");
    expect(c.err()).toStartWith("unknown verb `bogus`");
    expect(c.err()).toContain("bogus");
    expect(c.err()).not.toMatch(/^\s+at /m);
    expect(c.err()).toContain("BACKLOG_RANKER_DEBUG");
  });

  test("a bad flag on a verb refuses naming the flag", async () => {
    const c = capture();
    expect(await run(["rank", "--bogus"], c.io)).toBe(1);
    expect(c.err()).toStartWith("Unknown option '--bogus'");
    expect(c.err()).toContain("--bogus");
    expect(c.err()).not.toMatch(/^\s+at /m);
  });

  test("BACKLOG_RANKER_DEBUG restores the frames and drops the hint", async () => {
    const c = capture({ BACKLOG_RANKER_DEBUG: "1" });
    expect(await run(["bogus"], c.io)).toBe(1);
    expect(c.err()).toStartWith("unknown verb `bogus`");
    expect(c.err()).toMatch(/^\s+at /m);
    expect(c.err()).not.toContain("(BACKLOG_RANKER_DEBUG=1 for a stack)");
  });

  test("the debug variable from before the rename does nothing", async () => {
    const c = capture({ [["BACKLOG", "DECISIONS", "DEBUG"].join("_")]: "1" });
    expect(await run(["bogus"], c.io)).toBe(1);
    expect(c.err()).not.toMatch(/^\s+at /m);
  });

  test("an empty BACKLOG_RANKER_DEBUG is unset", async () => {
    const c = capture({ BACKLOG_RANKER_DEBUG: "" });
    expect(await run(["bogus"], c.io)).toBe(1);
    expect(c.err()).not.toMatch(/^\s+at /m);
  });
});

describe("unexpected errors", () => {
  test("keep name, message and frames whatever the debug setting", async () => {
    const c = capture();
    const code = await run(["rank"], c.io, {
      verbs: {
        rank: () => {
          throw new TypeError("x is not a function");
        },
      },
    });
    expect(code).toBe(1);
    expect(c.err()).toStartWith("TypeError: x is not a function");
    expect(c.err()).toMatch(/^\s+at /m);
  });

  test("a thrown non-error still renders and exits 1", async () => {
    const c = capture();
    const code = await run(["rank"], c.io, {
      verbs: {
        rank: () => {
          throw "plain string";
        },
      },
    });
    expect(code).toBe(1);
    expect(c.err()).toContain("plain string");
  });
});
