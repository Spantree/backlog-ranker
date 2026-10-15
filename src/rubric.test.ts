import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRefusal } from "./errors.js";
import { loadRubric, parseRubric, RUBRIC_DIR, rubricHash, withWeights } from "./rubric.js";

const FIXTURE = readFileSync(join(import.meta.dirname, "fixtures", "rubric.yaml"), "utf8");

const minimal = (extra = ""): string => `name: t
compose: weighted_sum
criteria:
  - id: impact
    direction: benefit
    question: How much?
    levels: [low, high]
${extra}`;

describe("parseRubric", () => {
  test("parses the fixture rubric with its defaults", () => {
    const r = parseRubric(FIXTURE, "fixture");
    expect(r.criteria.map((c) => c.id)).toEqual(["impact", "effort"]);
    expect(r.gates.map((g) => [g.id, g.action, g.threshold])).toEqual([
      ["security", "pin_top", 0.5],
      ["judgeable", "flag_if_below", 0.5],
    ]);
    expect(parseRubric(minimal(), "m").criteria[0]?.weight).toBe(1);
    expect(parseRubric(minimal(), "m").confidence_floor).toBe(0.5);
  });

  test("names every invalid field and stays a refusal", () => {
    let err: unknown;
    try {
      parseRubric(
        "name: t\ncompose: median\ncriteria:\n  - id: Bad-Id\n    direction: up\n    question: q\n    levels: [one]\n",
        "bad.yaml",
      );
    } catch (e) {
      err = e;
    }
    expect(isRefusal(err)).toBe(true);
    const msg = (err as Error).message;
    expect(msg).toContain("bad.yaml is not a valid rubric");
    for (const path of ["compose", "criteria.0.id", "criteria.0.direction", "criteria.0.levels"])
      expect(msg).toContain(path);
  });

  test("refuses more than ten levels, Jev's Score bound", () => {
    const levels = Array.from({ length: 11 }, (_, i) => `l${i}`).join(", ");
    expect(() => parseRubric(minimal().replace("[low, high]", `[${levels}]`), "m")).toThrow(
      "criteria.0.levels",
    );
  });

  test("refuses duplicate ids across criteria and gates", () => {
    const text = minimal("gates:\n  - id: impact\n    question: q?\n    action: pin_top\n");
    expect(() => parseRubric(text, "m")).toThrow('duplicate id "impact"');
  });

  test("roi needs both a weighted benefit and a weighted cost", () => {
    expect(() => parseRubric(minimal().replace("weighted_sum", "roi"), "m")).toThrow(
      "roi needs at least one weighted cost criterion",
    );
  });

  test("refuses bad YAML with the file named", () => {
    expect(() => parseRubric("name: [unclosed", "x.yaml")).toThrow("x.yaml is not valid YAML");
  });
});

describe("loadRubric", () => {
  const project = (): string => {
    const root = mkdtempSync(join(tmpdir(), "backlog-rubric-"));
    mkdirSync(join(root, RUBRIC_DIR), { recursive: true });
    return root;
  };

  test("the local file wins over the committed one, and the run says which it read", () => {
    const root = project();
    writeFileSync(join(root, RUBRIC_DIR, "r.yaml"), minimal().replace("name: t", "name: shared"));
    expect(loadRubric(root, "r")).toMatchObject({ path: join(RUBRIC_DIR, "r.yaml"), local: false });
    writeFileSync(join(root, RUBRIC_DIR, "r.local.yaml"), minimal().replace("name: t", "name: mine"));
    const loaded = loadRubric(root, "r");
    expect(loaded).toMatchObject({ path: join(RUBRIC_DIR, "r.local.yaml"), local: true });
    expect(loaded.rubric.name).toBe("mine");
    expect(loaded.hash).toBe(rubricHash(minimal().replace("name: t", "name: mine")));
  });

  test("refuses a missing rubric naming both paths, and a path-shaped name", () => {
    const root = project();
    expect(() => loadRubric(root, "nope")).toThrow("nope.local.yaml exists");
    expect(() => loadRubric(root, "../secrets")).toThrow("--rubric takes a rubric name");
  });

  test("reads rubrics from .backlog-ranker/rubrics", () => {
    expect(RUBRIC_DIR).toBe(join(".backlog-ranker", "rubrics"));
  });
});

describe("rubricHash", () => {
  test("is the first 12 hex digits of the SHA-256 of the rubric text", () => {
    // sha256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
    expect(rubricHash("abc")).toBe("ba7816bf8f01");
    expect(rubricHash(FIXTURE)).toMatch(/^[0-9a-f]{12}$/);
    expect(rubricHash(`${FIXTURE}\n`)).not.toBe(rubricHash(FIXTURE));
  });
});

describe("withWeights", () => {
  test("overrides weights without touching questions", () => {
    const r = parseRubric(FIXTURE, "f");
    const w = withWeights(r, { impact: 3 });
    expect(w.criteria[0]?.weight).toBe(3);
    expect(w.criteria[0]?.question).toBe(r.criteria[0]?.question);
    expect(r.criteria[0]?.weight).toBe(1);
  });

  test("a criterion named like an Object property is not overridden by inheritance", () => {
    const r = parseRubric(minimal().replace("id: impact", "id: constructor"), "m");
    expect(withWeights(r, {}).criteria[0]?.weight).toBe(1);
    expect(() => withWeights(r, { toString: 2 } as Record<string, number>)).toThrow("not a criterion");
  });

  test("refuses an unknown criterion and an override that zeroes roi's cost side", () => {
    const r = parseRubric(FIXTURE, "f");
    expect(() => withWeights(r, { security: 2 })).toThrow('"security", which is not a criterion');
    expect(() => withWeights(r, { effort: 0 })).toThrow("invalid rubric");
  });
});
