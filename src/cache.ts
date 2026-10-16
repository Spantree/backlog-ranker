/**
 * The answer cache: machine-local JSON under the gitignored
 * `.backlog-ranker/cache/`, no database.
 *
 * One answer per entry, keyed by the content hash of the state as sent,
 * the hash of the question, the engine id and the pinned model id. So a
 * changed weight or formula re-ranks from the cache; a reworded level, a
 * new criterion or an edited ticket asks only what changed; and answers
 * from two engines or two model versions never mix, because each pair
 * keeps its own file.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DecisionAnswer, DecisionQuestion } from "./engine.js";
import { canonicalJson, sha256 } from "./state.js";

export const CACHE_DIR = join(".backlog-ranker", "cache");
const SCHEMA = 2;

interface Entry {
  answer: DecisionAnswer;
  /** The snapshot that answered (`typesafe/jev-1.14-20261014`): the key
   * pins the version, this records which build of it. */
  served: string;
  at: string;
}

interface CacheFile {
  schema: number;
  engine: string;
  model: string;
  entries: Record<string, Entry>;
}

export function questionHash(question: DecisionQuestion): string {
  return sha256(canonicalJson(question));
}

export function entryKey(stateHash: string, question: DecisionQuestion): string {
  return sha256(`${stateHash}\n${questionHash(question)}`);
}

export interface AnswerCache {
  get(stateHash: string, question: DecisionQuestion): DecisionAnswer | undefined;
  put(stateHash: string, question: DecisionQuestion, answer: DecisionAnswer, servedModel: string): void;
  /** Write the file if anything changed. */
  flush(): void;
  readonly path: string;
}

function fileName(engine: string, model: string): string {
  const safe = (s: string): string => s.replaceAll(/[^A-Za-z0-9._-]/g, "_");
  return `${safe(engine)}--${safe(model)}.json`;
}

export function openCache(
  projectRoot: string,
  engine: string,
  model: string,
  now: () => Date = () => new Date(),
): AnswerCache {
  const dir = join(projectRoot, CACHE_DIR);
  const path = join(dir, fileName(engine, model));
  /** The entries on disk now, or none: a file from another schema,
   * engine or model is not ours to read, and a corrupt one is cold. */
  const readEntries = (): Record<string, Entry> => {
    if (!existsSync(path)) return {};
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
      const entriesOk =
        typeof raw.entries === "object" && raw.entries !== null && !Array.isArray(raw.entries);
      return raw.schema === SCHEMA && raw.engine === engine && raw.model === model && entriesOk
        ? raw.entries
        : {};
    } catch {
      return {};
    }
  };
  const file: CacheFile = { schema: SCHEMA, engine, model, entries: readEntries() };
  const added: Record<string, Entry> = {};
  let dirty = false;
  return {
    path,
    get(stateHash, question) {
      return file.entries[entryKey(stateHash, question)]?.answer;
    },
    put(stateHash, question, answer, servedModel) {
      const entry = { answer, served: servedModel, at: now().toISOString() };
      file.entries[entryKey(stateHash, question)] = entry;
      added[entryKey(stateHash, question)] = entry;
      dirty = true;
    },
    flush() {
      if (!dirty) return;
      mkdirSync(dir, { recursive: true });
      // Re-read before writing, so answers another run flushed since this
      // one opened the file survive; this run's own answers win a tie.
      // There is no lock: when two flushes overlap, the later rename can
      // drop the other run's new answers, which are asked again next run.
      const merged: CacheFile = { schema: SCHEMA, engine, model, entries: { ...readEntries(), ...added } };
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(merged)}\n`);
      renameSync(tmp, path);
      dirty = false;
    },
  };
}
