/**
 * How a failure reaches stderr. Refusals print their message alone and
 * no frames (the debug hatch restores them); anything else prints
 * `Name: message` and its frames.
 */

import { isRefusal } from "../errors.js";

/** The hint printed when a refusal's frames were withheld: the
 * suppression must read as deliberate, and the hatch discoverable. */
export const DEBUG_HINT = "(BACKLOG_RANKER_DEBUG=1 for a stack)";

/** The debug hatch is any non-empty value. */
export function debugFromEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** `cause` chains are authored shallow; a longer one is a cycle or a
 * bug, and the cap keeps rendering total either way. */
const CAUSE_DEPTH_LIMIT = 8;

/** Read a property that may be a hostile getter: a renderer inside the
 * failure path must never itself throw. */
function safeRead(read: () => unknown): unknown {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `name: message` from the object's PROPERTIES, never from the stack
 * string: Bun materializes that string lazily and it can come back
 * headerless. */
function headerOf(err: object): string {
  const name = asNonEmptyString(safeRead(() => (err as Error).name)) ?? "Error";
  const message = asNonEmptyString(safeRead(() => (err as Error).message));
  return message === undefined ? name : `${name}: ${message}`;
}

/** A refusal's message alone: it is the remediation, and the class
 * name would only bury it. The name stands in for an empty message. */
function refusalHeaderOf(err: object): string {
  return (
    asNonEmptyString(safeRead(() => (err as Error).message)) ??
    asNonEmptyString(safeRead(() => (err as Error).name)) ??
    "Error"
  );
}

/** The stack's FRAME lines only, from the first `at ...` line on. */
function framesOf(err: object): string[] {
  const stack = safeRead(() => (err as Error).stack);
  if (typeof stack !== "string" || stack === "") return [];
  const lines = stack.split("\n");
  const first = lines.findIndex((line) => /^\s+at /.test(line));
  return first === -1 ? [] : lines.slice(first);
}

/**
 * Render one error and its cause chain. Refusals print their message
 * with no `Name: ` prefix and no frames,
 * PER CHAIN LINK: a refusal's message is the whole remediation story
 * and frames would point at the guard instead of the fix, while an
 * unexpected error keeps its frames even as the cause of a refusal. A
 * trailing hint names the debug hatch whenever refusal frames were
 * withheld; the hatch restores them.
 */
export function renderError(err: unknown, options: { debug: boolean }): string {
  const lines: string[] = [];
  let withheld = false;
  let current: unknown = err;
  for (let depth = 0; depth < CAUSE_DEPTH_LIMIT && current !== undefined; depth += 1) {
    const prefix = depth === 0 ? "" : "caused by: ";
    if (typeof current !== "object" || current === null) {
      lines.push(`${prefix}${String(current)}`);
      break;
    }
    const refusal = isRefusal(current);
    lines.push(`${prefix}${refusal ? refusalHeaderOf(current) : headerOf(current)}`);
    if (refusal && !options.debug) withheld = true;
    else lines.push(...framesOf(current));
    current = safeRead(() => (current as Error).cause);
    // A `null` cause is no cause, as `undefined` is: `{ cause: null }` is
    // how some code spells "none". A thrown `null` still prints above.
    if (current === null) break;
  }
  if (withheld) lines.push(DEBUG_HINT);
  return lines.join("\n");
}
