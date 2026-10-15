/**
 * The ranked table. The engine returns no reasoning text, so the
 * per-criterion breakdown IS the explanation: every row shows each
 * criterion's score with its confidence, each gate's probability against
 * its threshold, and why a row is pinned, held or flagged.
 */

import type { CalibrateResult, ExplainResult } from "./api.js";
import type { RankedRow, Ranking } from "./compose.js";
import { TRUST_MIN_TICKETS, TRUST_TAU } from "./kendall.js";
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

/** Left-aligned columns two spaces apart; the last column is not padded. */
export function grid(rows: string[][]): string[] {
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
    `backlog-ranker rank: rubric ${rubric.name} (${header.rubricPath}) (sha ${header.rubricHash}), source ${header.source}`,
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

/** One ticket's reasoning: each criterion as a distribution over its
 * levels, each gate against its threshold, and the flags they raise. */
export function renderExplain(opts: { header: RunHeader; result: ExplainResult }): string {
  const { header, result } = opts;
  const { rubric } = result;
  const floor = rubric.confidence_floor;
  const lines = [
    `backlog-ranker explain: rubric ${rubric.name} (${header.rubricPath}) (sha ${header.rubricHash}), source ${header.source}`,
    `engine ${header.engine}/${header.model} via ${header.backend} (config ${header.configPath}); compose ${rubric.compose}; confidence floor ${floor.toFixed(2)}`,
    "",
    `${result.key}  ${result.title}`,
    result.url,
    `composite ${result.composite.toFixed(3)}`,
  ];
  for (const c of result.criteria) {
    lines.push(
      "",
      `${c.id} (${c.direction}, weight ${c.weight}): score ${c.score.toFixed(2)}, confidence ${c.confidence.toFixed(2)}${
        c.lowConfidence ? `? (under ${floor.toFixed(2)})` : ""
      }`,
    );
    for (const l of c.levels) lines.push(`  ${l.index}  ${l.probability.toFixed(2)}  ${l.text}`);
  }
  lines.push("");
  for (const g of result.gates) {
    const sign = g.probability >= g.threshold ? "≥" : "<";
    const outcome = !g.triggered ? "no effect" : g.action === "pin_top" ? "pinned" : "held";
    lines.push(
      `gate ${g.id} (${g.action}): ${g.probability.toFixed(2)} ${sign} ${g.threshold.toFixed(2)}: ${outcome}`,
    );
  }
  const f = result.flags;
  const flagList = [
    ...f.pinnedBy.map((g) => `pinned:${g}`),
    ...f.heldBy.map((g) => `held:${g}`),
    ...f.lowConfidence.map((c) => `low-confidence:${c}`),
    ...(f.truncated ? ["truncated"] : []),
  ];
  lines.push(
    "",
    `Flags: ${flagList.length === 0 ? "none" : flagList.join(" ")}.`,
    `Body ${result.flags.truncated ? "truncated to fit the prompt cap" : "sent whole"}.`,
    `Engine: ${result.stats.requests} requests; answers from cache ${result.stats.cachedAnswers}, asked ${result.stats.askedAnswers}.`,
  );
  return lines.join("\n");
}

/** The hand ranking beside the tool's order of the same tickets, tau
 * and the trust verdict, and when not trusted the pairs that disagree. */
export function renderCalibrate(opts: {
  header: RunHeader;
  hand: readonly string[];
  result: CalibrateResult;
}): string {
  const { header, hand, result } = opts;
  const { calibration, tool, stats } = result;
  const rows = new Map([...result.ranking.ranked, ...result.ranking.held].map((r) => [r.key, r]));
  const lines = [
    `backlog-ranker calibrate: rubric ${result.rubric.name} (${header.rubricPath}) (sha ${header.rubricHash}), source ${header.source}, ${calibration.n} tickets`,
    // A tau holds for one model version only: name it beside the number.
    `engine ${header.engine}/${header.model} via ${header.backend} (config ${header.configPath})`,
    "",
    ...grid([
      ["#", "hand", "tool", "tool composite", "title"],
      ...hand.map((k, i) => {
        const row = rows.get(tool[i] ?? "");
        return [String(i + 1), k, row?.key ?? "-", row?.composite.toFixed(3) ?? "-", row?.title ?? ""];
      }),
    ]),
    "",
    `Kendall's tau ${calibration.tau.toFixed(3)} (${calibration.concordant} concordant, ${calibration.discordant} discordant pairs).`,
    calibration.trusted
      ? `TRUSTED: tau >= ${TRUST_TAU} on at least ${TRUST_MIN_TICKETS} tickets.`
      : `NOT TRUSTED: needs tau >= ${TRUST_TAU} on at least ${TRUST_MIN_TICKETS} tickets (have ${calibration.tau.toFixed(3)} on ${calibration.n}).`,
    `Engine: ${stats.tickets} tickets, ${stats.requests} requests; answers from cache ${stats.cachedAnswers}, asked ${stats.askedAnswers}.`,
  ];
  if (!calibration.trusted && calibration.disagreements.length > 0) {
    lines.push("", "Pairs the rubric orders against the hand ranking (hand's choice first):");
    for (const d of calibration.disagreements) lines.push(`  ${d.above} over ${d.below}`);
  }
  return lines.join("\n");
}
