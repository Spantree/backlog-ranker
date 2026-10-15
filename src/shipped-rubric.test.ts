import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRubric } from "./rubric.js";

const SHIPPED = join(import.meta.dirname, "..", "rubrics", "impact-roi.yaml");

test("the shipped impact-roi rubric parses with the package's parser", () => {
  const rubric = parseRubric(readFileSync(SHIPPED, "utf8"), "rubrics/impact-roi.yaml");
  expect(rubric.name).toBe("impact-roi");
  expect(rubric.compose).toBe("roi");
  expect(rubric.criteria.map((c) => [c.id, c.direction])).toEqual([
    ["impact", "benefit"],
    ["effort", "cost"],
  ]);
  expect(rubric.gates.map((g) => [g.id, g.action])).toEqual([
    ["security", "pin_top"],
    ["judgeable", "flag_if_below"],
  ]);
  // Optional fact gates: only the blocked sink. Tickets with an open closing
  // pull request or an assignee stay ranked; holding them is a team's choice.
  expect(rubric.fact_gates).toEqual([{ id: "blocked", fact: "open_blockers", at_least: 1, action: "sink" }]);
  expect(rubric.tiebreak_question).toBeString();
});
