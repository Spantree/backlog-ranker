import { describe, expect, test } from "bun:test";
import { isRefusal } from "./errors.js";
import { ageBucket, PROMPT_BYTE_BUDGET, PromptBudgetError, stateBytes, stateHash, toState } from "./state.js";
import type { Ticket } from "./ticket.js";

const NOW = new Date("2026-10-13T00:00:00Z");

const ticket = (key: string, body = "a body"): Ticket => ({
  key,
  title: `title ${key}`,
  body,
  labels: ["b", "a"],
  url: "",
  createdAt: "2026-10-03T00:00:00Z",
  reactions: 1,
  linkedIssues: 2,
  duplicates: 0,
});

describe("toState", () => {
  test("sends title, sorted labels, body and computed facts only", () => {
    const { state, truncated } = toState(ticket("K-1"), NOW);
    expect(Object.keys(state).sort()).toEqual(["body", "facts", "labels", "title"]);
    expect(state.labels).toEqual(["a", "b"]);
    expect(state.facts).toEqual({ age: "under a month", reactions: 1, linked_issues: 2, duplicates: 0 });
    expect(truncated).toBe(false);
  });

  test("age is a bucket, so the state hash holds across days", () => {
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    expect(stateHash(toState(ticket("K-1"), later).state)).toBe(stateHash(toState(ticket("K-1"), NOW).state));
    expect(ageBucket("2026-10-12T00:00:00Z", NOW)).toBe("under a week");
    expect(ageBucket("2025-01-01T00:00:00Z", NOW)).toBe("a year or more");
  });

  test("fits the serialized state plus the longest question under the byte budget, dense text included", () => {
    for (const body of [
      "a ".repeat(40_000),
      "漢字".repeat(20_000),
      '"\\'.repeat(20_000),
      "😀".repeat(12_000),
    ]) {
      const { state, truncated } = toState(ticket("K-1", body), NOW, 2_000);
      expect(truncated).toBe(true);
      expect(stateBytes(state) + 2_000).toBeLessThanOrEqual(PROMPT_BYTE_BUDGET);
      expect(state.body).toContain("[body truncated by backlog-decisions");
      expect(state.body).not.toContain("�");
    }
  });

  test("refuses a question too long to leave room for any ticket", () => {
    expect(() => toState(ticket("K-1"), NOW, PROMPT_BYTE_BUDGET)).toThrow(PromptBudgetError);
    let err: unknown;
    try {
      toState(ticket("K-1"), NOW, PROMPT_BYTE_BUDGET);
    } catch (e) {
      err = e;
    }
    expect(isRefusal(err)).toBe(true);
  });
});
