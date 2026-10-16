/**
 * The testable parts of scripts/capture-fixtures.ts, which itself only
 * runs live: where a capture may write its recordings, and the recording
 * transport that holds them until the run has succeeded.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_JEV_MODEL } from "../jev/backends.js";
import type { JevFetch } from "../jev/engine.js";
import { FIXTURE_DIR, jevFixtureName } from "./replay.js";

export interface Recorder {
  /** The engine's transport: forwards to the live fetch and keeps each
   * successful response in memory, writing nothing. */
  fetch: JevFetch;
  /** Writes every kept response to `dir`, named by its state's hash and
   * with its `id` removed; returns how many. Called once the whole run
   * has succeeded, so a response the engine refused, or any failure later
   * in the run, never replaces a recording on disk. */
  save(dir: string): number;
}

export function recorder(live: JevFetch): Recorder {
  const kept = new Map<string, string>();
  return {
    async fetch(url, init) {
      const { state } = JSON.parse(String(init?.body)) as { state: unknown };
      const res = await live(url, init);
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = JSON.parse(text) as Record<string, unknown>;
      delete body.id;
      kept.set(jevFixtureName(state), `${JSON.stringify(body, null, 2)}\n`);
      return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
    },
    save(dir) {
      mkdirSync(dir, { recursive: true });
      for (const [name, text] of kept) writeFileSync(join(dir, name), text);
      return kept.size;
    },
  };
}

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
