/**
 * The ranked table. The engine returns no reasoning text, so the
 * per-criterion breakdown IS the explanation: every row shows each
 * criterion's score with its confidence, each gate's probability against
 * its threshold, and why a row is pinned, held or flagged.
 */

import type { RankedRow, Ranking } from "./compose.js";
import type { Rubric } from "./rubric.js";
import type { ScoreStats } from "./score.js";
import type { TiebreakStats } from "./tiebreak.js";

export interface RunHeader {
  rubricPath: string;
  rubricHash: string;
  configPath: string;
  source: string;
  engine: string;
  model: string;
  backend: string;
}

const TITLE_WIDTH = 64;

function clip(text: string, width: number): string {
  return text.length <= width ? text : `${text.slice(0, width - 1)}…`;
}

function cell(rubric: Rubric, row: RankedRow, id: string): string {
  const a = row.answers[id];
  if (a === undefined) return "-";
  if (a.kind === "noul") {
    const gate = rubric.gates.find((g) => g.id === id);
    if (gate === undefined) return a.probability.toFixed(2);
    // The same comparison composition makes: at or above pins, under holds.
    const sign = a.probability >= gate.threshold ? "≥" : "<";
    return `${a.probability.toFixed(2)}${sign}${gate.threshold.toFixed(2)}`;
  }
  if (a.kind === "score") {
    const low = a.confidence < rubric.confidence_floor ? "?" : "";
    return `${a.value.toFixed(2)} c${a.confidence.toFixed(2)}${low}`;
  }
  return a.choice;
}

function flags(row: RankedRow): string {
  const out = [
    ...row.pinnedBy.map((g) => `pinned:${g}`),
    ...row.heldBy.map((g) => `held:${g}`),
    ...row.lowConfidence.map((c) => `low-confidence:${c}`),
    ...(row.truncated ? ["truncated"] : []),
  ];
  return out.length === 0 ? "-" : out.join(" ");
}

function grid(rows: string[][]): string[] {
  const widths = (rows[0] ?? []).map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) =>
    r
      .map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i] ?? 0)))
      .join("  ")
      .trimEnd(),
  );
}

export function renderTable(opts: {
  rubric: Rubric;
  header: RunHeader;
  ranking: Ranking;
  stats: ScoreStats;
  tiebreak?: TiebreakStats & { top: number };
}): string {
  const { rubric, header, ranking, stats } = opts;
  const ids = [...rubric.criteria.map((c) => c.id), ...rubric.gates.map((g) => g.id)];
  const weights = rubric.criteria
    .map((c) => `${c.id}=${c.weight}${c.direction === "cost" ? " (cost)" : ""}`)
    .join(", ");
  const lines = [
    `backlog-decisions rank: rubric ${rubric.name} (${header.rubricPath}) (sha ${header.rubricHash}), source ${header.source}`,
    `engine ${header.engine}/${header.model} via ${header.backend} (config ${header.configPath}); compose ${rubric.compose}; weights ${weights}; confidence floor ${rubric.confidence_floor.toFixed(2)}`,
    "",
  ];
  const head = ["#", "key", "composite", ...ids, "flags", "title"];
  const toRow = (row: RankedRow, position: string): string[] => [
    position,
    row.key,
    row.composite.toFixed(3),
    ...ids.map((id) => cell(rubric, row, id)),
    flags(row),
    clip(row.title, TITLE_WIDTH),
  ];
  lines.push(...grid([head, ...ranking.ranked.map((row, i) => toRow(row, String(i + 1)))]));

  if (ranking.held.length > 0) {
    lines.push(
      "",
      `Held for a human (a flag_if_below gate answered under its threshold): ${ranking.held.length}`,
    );
    lines.push(...grid([head, ...ranking.held.map((row) => toRow(row, "-"))]));
  }

  const pinned = ranking.ranked.filter((r) => r.pinnedBy.length > 0).length;
  const low = [...ranking.ranked, ...ranking.held].filter((r) => r.lowConfidence.length > 0).length;
  lines.push(
    "",
    `Scores are probability-weighted level indexes (0 = the first level) with their confidence; ? marks confidence under ${rubric.confidence_floor.toFixed(2)}. Gates show probability against threshold.`,
    `Pinned: ${pinned}. Held: ${ranking.held.length}. Low-confidence rows: ${low}. Truncated bodies: ${
      stats.truncated.length === 0 ? "none" : stats.truncated.join(", ")
    }.`,
    `Engine: ${stats.tickets} tickets, ${stats.requests} requests; answers from cache ${stats.cachedAnswers}, asked ${stats.askedAnswers}.`,
  );
  if (opts.tiebreak !== undefined) {
    const t = opts.tiebreak;
    lines.push(
      `Tie-break over the top ${t.top}: ${t.pairs} pairs, ${t.requests} requests, ${t.cacheHits} pairs from cache, ` +
        `${t.truncatedPairs} pairs cut to share the prompt.`,
    );
  }
  return lines.join("\n");
}
