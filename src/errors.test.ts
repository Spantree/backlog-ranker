import { describe, expect, test } from "bun:test";
import {
  HELP_REQUEST_MARKER,
  HelpRequest,
  isHelpRequest,
  isRefusal,
  REFUSAL_MARKER,
  RefusalError,
} from "./errors.js";

describe("refusal brand", () => {
  test("a RefusalError is a refusal whose brand is non-enumerable", () => {
    const err = new RefusalError("no config at .backlog-decisions/config.yaml");
    expect(isRefusal(err)).toBe(true);
    expect(err.name).toBe("RefusalError");
    expect(err.message).toBe("no config at .backlog-decisions/config.yaml");
    expect(Object.propertyIsEnumerable.call(err, REFUSAL_MARKER)).toBe(false);
    expect(JSON.stringify(err)).not.toContain("refusal");
  });

  test("the brand is the registry symbol, so a foreign copy still matches", () => {
    const foreign = Object.defineProperty(new Error("other copy"), Symbol.for("backlog-decisions.refusal"), {
      value: true,
    });
    expect<symbol>(REFUSAL_MARKER).toBe(Symbol.for("backlog-decisions.refusal"));
    expect(isRefusal(foreign)).toBe(true);
  });

  test("plain errors, primitives and hostile objects are not refusals", () => {
    expect(isRefusal(new Error("boom"))).toBe(false);
    expect(isRefusal(null)).toBe(false);
    expect(isRefusal("nope")).toBe(false);
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("trap");
        },
      },
    );
    expect(isRefusal(hostile)).toBe(false);
  });
});

describe("help-request brand", () => {
  test("a HelpRequest carries the help text as its message", () => {
    const help = new HelpRequest("usage: backlog-decisions rank");
    expect(isHelpRequest(help)).toBe(true);
    expect(help.message).toBe("usage: backlog-decisions rank");
    expect<symbol>(HELP_REQUEST_MARKER).toBe(Symbol.for("backlog-decisions.help-request"));
  });

  test("a help request is not a refusal and vice versa", () => {
    expect(isRefusal(new HelpRequest("usage"))).toBe(false);
    expect(isHelpRequest(new RefusalError("no"))).toBe(false);
    expect(isHelpRequest(undefined)).toBe(false);
  });
});
