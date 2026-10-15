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
}
