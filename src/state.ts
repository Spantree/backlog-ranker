/**
 * The `state` the ranker sends about a ticket a tracker returned.
 *
 * Only the title, the body and the labels leave the tracker. Comments
 * and linked-issue text never do. The facts are numbers code computed
 * itself (an age bucket, reactions, link and duplicate counts).
 */

import { createHash } from "node:crypto";
import { RefusalError } from "./errors.js";
import type { Ticket } from "./ticket.js";

export interface TicketState {
  title: string;
  labels: string[];
  body: string;
  facts: { age: AgeBucket; reactions: number; linked_issues: number; duplicates: number };
}

/** Age is bucketed, not counted in days: the state is hashed into the
 * answer cache, and a day count would expire every cached answer at each
 * day boundary. A bucket changes a few times in a ticket's life. */
export const AGE_BUCKETS = [
  [7, "under a week"],
  [30, "under a month"],
  [91, "under a quarter"],
  [365, "under a year"],
] as const;
export type AgeBucket = (typeof AGE_BUCKETS)[number][1] | "a year or more";

export function ageBucket(createdAt: string, now: Date): AgeBucket {
  const days = (now.getTime() - new Date(createdAt).getTime()) / 86_400_000;
  for (const [limit, label] of AGE_BUCKETS) if (days < limit) return label;
  return "a year or more";
}

/** Jev's cap is 32k tokens for the state plus the longest question. A
 * byte-level tokenizer never spends more than one token per byte, so a
 * BYTE budget on what is serialized bounds the tokens whatever the text
 * (dense Unicode, code, base64). 2k of the 32k are left for framing. */
export const PROMPT_TOKEN_CAP = 32_000;
export const PROMPT_BYTE_BUDGET = 30_000;
export const TRUNCATION_NOTE =
  "\n\n[body truncated by backlog-decisions: the rest exceeded the model's prompt cap]";

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

/** The longest prefix of `text` whose UTF-8 form is at most `maxBytes`,
 * never splitting a character. */
export function clipToBytes(text: string, maxBytes: number): string {
  if (utf8Bytes(text) <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8Bytes(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  // Never end on the high half of a surrogate pair: on the cut string a
  // lone high half reads back as itself.
  const head = text.slice(0, lo);
  const last = head.codePointAt(head.length - 1) ?? 0;
  return last >= 0xd800 && last <= 0xdbff ? head.slice(0, -1) : head;
}

/** Bytes the serialized state takes, as the request carries it. */
export function stateBytes(state: unknown): number {
  return utf8Bytes(JSON.stringify(state));
}

/** Bodies, as `toState` built them, cut so the whole serialized state
 * plus `reservedBytes` (the longest question) fits the budget. Returns
 * null when even empty bodies cannot fit: the question is too long. */
export function fitBodies(
  bodies: readonly string[],
  shellBytes: number,
  reservedBytes: number,
): { bodies: string[]; clipped: boolean[] } | null {
  const room = PROMPT_BYTE_BUDGET - reservedBytes - shellBytes;
  const sizes = bodies.map((b) => utf8Bytes(JSON.stringify(b)) - 2);
  if (sizes.reduce((a, b) => a + b, 0) <= room)
    return { bodies: [...bodies], clipped: bodies.map(() => false) };
  const noteBytes = utf8Bytes(JSON.stringify(TRUNCATION_NOTE)) - 2;
  const perBody = Math.floor(room / bodies.length) - noteBytes;
  if (perBody < 0) return null;
  // JSON escaping can grow a byte up to six; budget the escaped form.
  const clipped = sizes.map((size) => size > perBody);
  const out = bodies.map((b, i) => {
    if (!clipped[i]) return b;
    let cut = clipToBytes(b, perBody);
    while (utf8Bytes(JSON.stringify(cut)) - 2 > perBody)
      cut = clipToBytes(cut, Math.floor(utf8Bytes(cut) * 0.9));
    return cut + TRUNCATION_NOTE;
  });
  return { bodies: out, clipped };
}

export function toState(
  ticket: Ticket,
  now: Date,
  reservedBytes = 0,
): { state: TicketState; truncated: boolean } {
  const state: TicketState = {
    title: ticket.title,
    labels: [...ticket.labels].sort(byCodePoint),
    body: "",
    facts: {
      age: ageBucket(ticket.createdAt, now),
      reactions: ticket.reactions,
      linked_issues: ticket.linkedIssues,
      duplicates: ticket.duplicates,
    },
  };
  const fitted = fitBodies([ticket.body], stateBytes(state), reservedBytes);
  if (fitted === null) throw new PromptBudgetError(ticket.key, reservedBytes);
  state.body = fitted.bodies[0]!;
  return { state, truncated: fitted.clipped[0]! };
}

export class PromptBudgetError extends RefusalError {
  constructor(key: string, reservedBytes: number) {
    super(
      `${key}: the longest rubric question takes ${reservedBytes} bytes, leaving no room for the ticket inside ` +
        `the model's ${PROMPT_TOKEN_CAP}-token prompt cap; shorten that question or its levels`,
    );
    this.name = "PromptBudgetError";
  }
}

/** Code-point order, the same on every machine and locale. */
export function byCodePoint(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** A stable JSON spelling: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => byCodePoint(a, b));
    const members = entries.map(([k, v]) => JSON.stringify(k) + ":" + canonicalJson(v));
    return "{" + members.join(",") + "}";
  }
  return JSON.stringify(value);
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The content hash of a state AS SENT (after truncation, facts
 * included), so a change to either invalidates the cached answers. */
export function stateHash(state: unknown): string {
  return sha256(canonicalJson(state));
}
