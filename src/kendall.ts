/**
 * Calibration arithmetic: Kendall's tau
 * between a hand ranking and the tool's ranking of the same tickets.
 * A rubric is TRUSTED at tau >= 0.4 on at least 12 hand-ranked tickets.
 */

export const TRUST_TAU = 0.4;
export const TRUST_MIN_TICKETS = 12;

export interface Calibration {
  n: number;
  concordant: number;
  discordant: number;
  tau: number;
  trusted: boolean;
  /** Pairs the two rankings order differently: the hand puts `above` first. */
  disagreements: { above: string; below: string }[];
}

/**
 * Both arguments list keys best first. Only keys in both count; each list
 * is a strict order, so this is tau-a (no ties to correct for).
 */
export function kendallTau(hand: readonly string[], tool: readonly string[]): Calibration {
  const toolPos = new Map(tool.map((k, i) => [k, i]));
  // The hand's keys the tool also ranked, first occurrence only, with
  // their tool position.
  const shared: { key: string; pos: number }[] = [];
  hand.forEach((key, i) => {
    const pos = toolPos.get(key);
    if (pos !== undefined && hand.indexOf(key) === i) shared.push({ key, pos });
  });
  let concordant = 0;
  let discordant = 0;
  const disagreements: { above: string; below: string }[] = [];
  for (const [i, above] of shared.entries()) {
    for (const below of shared.slice(i + 1)) {
      if (above.pos < below.pos) concordant++;
      else {
        discordant++;
        disagreements.push({ above: above.key, below: below.key });
      }
    }
  }
  const pairs = (shared.length * (shared.length - 1)) / 2;
  const tau = pairs === 0 ? 0 : (concordant - discordant) / pairs;
  return {
    n: shared.length,
    concordant,
    discordant,
    tau,
    trusted: shared.length >= TRUST_MIN_TICKETS && tau >= TRUST_TAU,
    disagreements,
  };
}
