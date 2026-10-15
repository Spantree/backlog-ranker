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
