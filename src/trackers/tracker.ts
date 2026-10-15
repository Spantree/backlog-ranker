import type { Ticket } from "../ticket.js";

/** A backlog source. GitHub open issues is the one adapter today;
 * Linear parses and refuses as a planned adapter. */
export interface Tracker {
  /** The canonical `--source` spelling this tracker reads. */
  readonly source: string;
  /** Every pending issue: open and not yet started, done or canceled. */
  pending(): Promise<Ticket[]>;
  /** Named issues, for a calibration set. */
  issues(keys: readonly string[]): Promise<Ticket[]>;
}
