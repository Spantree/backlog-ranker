import type { Ticket } from "../ticket.js";

/** The fetch a tracker sends its requests through; tests replace it. */
export type FetchFn = typeof globalThis.fetch;

/** A backlog source: a GitHub repository's open issues, or a Linear
 * team's issues in its pending workflow states. */
export interface Tracker {
  /** The canonical `--source` spelling this tracker reads. */
  readonly source: string;
  /** Every pending issue: open on GitHub; in the configured workflow
   * states on Linear (Backlog and Todo by default). */
  pending(): Promise<Ticket[]>;
  /** Named issues, for a calibration set. */
  issues(keys: readonly string[]): Promise<Ticket[]>;
}
