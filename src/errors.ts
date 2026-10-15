/**
 * The two error brands the CLI surface distinguishes. Both are
 * `Symbol.for` registry symbols with property-based guards, NOT
 * instanceof checks: a linked consumer can end up with two live copies
 * of this package (its own symlink chain vs the workspace's resolution),
 * and a registry symbol matches across copies where instanceof silently
 * fails.
 */

/**
 * The refusal brand: errors DESIGNED to stop the user with a loud,
 * actionable message. The CLI renders them message-first, with no
 * stack frames (`BACKLOG_RANKER_DEBUG` restores them).
 */
export const REFUSAL_MARKER = Symbol.for("backlog-ranker.refusal");

/**
 * Base class for refusal-shaped errors. The message IS the remediation
 * story; a stack trace on one is noise pointing at the guard instead of
 * the fix. Subclasses set their own `name` after `super(...)`.
 */
export class RefusalError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RefusalError";
    // Non-enumerable, like a brand should be: it never shows up in
    // serialization or key walks, only in the guard below.
    Object.defineProperty(this, REFUSAL_MARKER, { value: true });
  }
}

/** Property-based refusal guard, see {@link REFUSAL_MARKER} for why
 * this is not `instanceof RefusalError`. Guarded: the caller is a CLI
 * failure path that must never itself throw, and the marker read could
 * hit a hostile getter or Proxy. */
export function isRefusal(err: unknown): boolean {
  try {
    return (
      typeof err === "object" && err !== null && (err as Record<symbol, unknown>)[REFUSAL_MARKER] === true
    );
  } catch {
    return false;
  }
}

/**
 * The help-request brand: a verb asked for `--help` or `-h` throws a
 * {@link HelpRequest} carrying its help text, and the CLI surface
 * prints that text to stdout and exits 0. A thrown signal rather than
 * `process.exit` inside library code, so in-process callers keep their
 * `finally` blocks and help stays testable without a subprocess.
 */
export const HELP_REQUEST_MARKER = Symbol.for("backlog-ranker.help-request");

/** A request for help, not a failure: its message is the help text. */
export class HelpRequest extends Error {
  constructor(helpText: string) {
    super(helpText);
    this.name = "HelpRequest";
    Object.defineProperty(this, HELP_REQUEST_MARKER, { value: true });
  }
}

/** Property-based help-request guard, as failure-path-safe as
 * {@link isRefusal}. */
export function isHelpRequest(err: unknown): err is HelpRequest {
  try {
    return (
      typeof err === "object" &&
      err !== null &&
      (err as Record<symbol, unknown>)[HELP_REQUEST_MARKER] === true
    );
  } catch {
    return false;
  }
}
