/** One backlog item as a tracker reports it, before any state building. */
export interface Ticket {
  key: string;
  title: string;
  body: string;
  labels: string[];
  url: string;
  createdAt: string;
  reactions: number;
  linkedIssues: number;
  duplicates: number;
  /** Open issues this ticket is blocked by. Counted in code for fact
   * gates and never sent to the model; absent counts as 0 (#2). */
  openBlockers?: number;
  /** Open pull requests set to close this ticket, drafts included.
   * Fact gates only, never sent to the model; absent counts as 0 (#2). */
  openClosingPrs?: number;
  /** Users assigned to this ticket. Fact gates only, never sent to the
   * model; absent counts as 0 (#2). */
  assignees?: number;
}

/** The numeric facts a fact gate can test, by their rubric names. */
export const FACT_NAMES = [
  "reactions",
  "linked_issues",
  "duplicates",
  "open_blockers",
  "open_closing_prs",
  "assignees",
] as const;
export type FactName = (typeof FACT_NAMES)[number];
export type TicketFacts = Record<FactName, number>;

/** A ticket's numeric facts, the three fact-gate-only counts as 0 when
 * a tracker leaves them out. */
export function ticketFacts(ticket: Ticket): TicketFacts {
  return {
    reactions: ticket.reactions,
    linked_issues: ticket.linkedIssues,
    duplicates: ticket.duplicates,
    open_blockers: ticket.openBlockers ?? 0,
    open_closing_prs: ticket.openClosingPrs ?? 0,
    assignees: ticket.assignees ?? 0,
  };
}
