/**
 * The testable parts of scripts/capture-fixtures.ts, which itself only
 * runs live: where a capture may write its recordings.
 */

import { resolve } from "node:path";
import { DEFAULT_JEV_MODEL } from "../jev/backends.js";
import { FIXTURE_DIR } from "./replay.js";

/** Where the suite's recordings live. */
export const FIXTURE_JEV_DIR = resolve(FIXTURE_DIR, "jev");

/** The folder a capture on `model` writes into. The suite's folder holds
 * DEFAULT_JEV_MODEL recordings only, and a state's recording is named by
 * its hash alone, so a capture on another version would overwrite them:
 * it needs an explicit `out` elsewhere. */
export function captureDir(model: string, out: string | undefined): string {
  const dir = out === undefined ? FIXTURE_JEV_DIR : resolve(out);
  if (model !== DEFAULT_JEV_MODEL && dir === FIXTURE_JEV_DIR) {
    throw new Error(
      `--model ${model} would overwrite the ${DEFAULT_JEV_MODEL} recordings in src/fixtures/jev/; ` +
        "pass --out <dir> to record it elsewhere",
    );
  }
  return dir;
}
