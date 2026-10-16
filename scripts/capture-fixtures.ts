#!/usr/bin/env bun
/**
 * Re-record the Jev answers the test suite replays. Run by hand after
 * editing src/fixtures/rubric.yaml or the fixture issue page; the suite
 * itself never calls a live endpoint.
 *
 *   OPENROUTER_API_KEY=... bun scripts/capture-fixtures.ts [--model jev-1.13 --out <dir>]
 *
 * `--model` records on that Jev version; absent means DEFAULT_JEV_MODEL,
 * the version the suite's cache-file assertions expect. Recordings are
 * named by state hash alone, so a capture on another version refuses to
 * write into src/fixtures/jev/ and needs an explicit `--out <dir>`.
 *
 * It runs the real rank flow (scoring, then the tie-break over the top
 * ten) over the fixture issues, with the age facts pinned to FIXTURE_NOW,
 * against a cold cache in a temporary folder, and writes each raw
 * response under src/fixtures/jev/ (or `--out`), named by its state's
 * hash, with the response `id` removed.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openCache } from "../src/cache.js";
import { rank } from "../src/compose.js";
import { captureDir } from "../src/fixtures/capture.js";
import { FIXTURE_DIR, FIXTURE_NOW, jevFixtureName } from "../src/fixtures/replay.js";
import { DEFAULT_JEV_MODEL, isJevModel, JEV_MODELS } from "../src/jev/backends.js";
import { createJevEngine, type JevFetch } from "../src/jev/engine.js";
import { DEFAULT_KEY_VARS } from "../src/keys.js";
import { parseRubric } from "../src/rubric.js";
import { scoreTickets } from "../src/score.js";
import { MAX_TIEBREAK, tiebreak } from "../src/tiebreak.js";
import { githubTracker } from "../src/trackers/github.js";

const { values } = parseArgs({ options: { model: { type: "string" }, out: { type: "string" } } });
const model = values.model ?? DEFAULT_JEV_MODEL;
if (!isJevModel(model)) throw new Error(`--model is "${model}", not one of ${JEV_MODELS.join(", ")}`);
const outDir = captureDir(model, values.out);
mkdirSync(outDir, { recursive: true });

const apiKey = process.env[DEFAULT_KEY_VARS.openrouter];
if (apiKey === undefined || apiKey === "") throw new Error(`${DEFAULT_KEY_VARS.openrouter} is not set`);

const rubric = parseRubric(readFileSync(join(FIXTURE_DIR, "rubric.yaml"), "utf8"), "rubric.yaml");
const page = readFileSync(join(FIXTURE_DIR, "github-issues.json"), "utf8");
// The GitHub side is the recorded page; only Jev is called live. The
// state hash excludes the ticket key, so the repository name is free.
const pageFetch = (async () =>
  new Response(page, { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
const tracker = githubTracker({ owner: "kit", repo: "kit", token: "unused", fetch: pageFetch });

const recording: JevFetch = async (url, init) => {
  const { state } = JSON.parse(String(init?.body)) as { state: unknown };
  const res = await fetch(url, init);
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = JSON.parse(text) as Record<string, unknown>;
  delete body.id;
  writeFileSync(join(outDir, jevFixtureName(state)), `${JSON.stringify(body, null, 2)}\n`);
  return new Response(text, { status: res.status, headers: { "content-type": "application/json" } });
};

const engine = createJevEngine({ backend: "openrouter", apiKey, model, fetch: recording });
const cache = openCache(mkdtempSync(join(tmpdir(), "backlog-capture-")), engine.id, engine.model);
const { scored, states, stats } = await scoreTickets({
  tickets: await tracker.pending(),
  rubric,
  engine,
  cache,
  now: FIXTURE_NOW,
});
const ranking = rank(rubric, scored);
const tb = await tiebreak({ rubric, rows: ranking.ranked, states, top: MAX_TIEBREAK, engine, cache });
console.log(
  `recorded on ${model} into ${outDir}: ${stats.requests} ticket responses and ${tb.stats.requests} tie-break responses`,
);
