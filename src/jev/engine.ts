/**
 * TypeSafe's Jev as a `DecisionEngine`, over the official SDK. The engine
 * id and model are the same whichever backend serves Jev, so a cache
 * filled through OpenRouter answers a run that goes to TypeSafe directly,
 * and the reverse.
 *
 * Errors are value-free: they name the backend, the HTTP status and the
 * question ids, never the API key or the request body (the state is a
 * tracker's ticket text).
 */

import {
  APIConnectionError,
  APIError,
  APITimeoutError,
  type EntryType,
  type Fetch,
  type Question,
  type RetryPolicy,
  TypeSafeClient,
} from "@typesafe-ai/sdk";
import type { DecisionAnswer, DecisionEngine, DecisionQuestion } from "../engine.js";
import { RefusalError } from "../errors.js";
import { DEFAULT_KEY_VARS } from "../keys.js";
import {
  BACKENDS,
  type Backend,
  type BackendName,
  DEFAULT_JEV_MODEL,
  isJevModel,
  JEV_MODELS,
} from "./backends.js";
import { answerProblem, type JevAnswer, jevResultSchema, servesPinnedModel } from "./validate.js";

export const JEV_ENGINE_ID = "typesafe";

/** The SDK's transport shape: `input` is always a URL string. */
export type JevFetch = Fetch;
export type JevRetryPolicy = Partial<RetryPolicy>;

export interface JevEngineOptions {
  backend: BackendName;
  apiKey: string;
  /** The environment variable the key came from, named in refusals;
   * the backend's default variable when absent. */
  apiKeyVar?: string;
  /** The Jev version to pin; `DEFAULT_JEV_MODEL` when absent. A string,
   * not `JevModel`, because it usually comes from config: an unknown
   * version refuses here, before any client is built. */
  model?: string;
  /** Transport; the global `fetch` when absent. Tests pass a fake. */
  fetch?: JevFetch;
  /** The SDK's retry policy, partially overridden. By default it retries
   * 408, 429 and 5xx twice with backoff; tests pass tiny delays. */
  retry?: JevRetryPolicy;
  /** Per-attempt timeout in milliseconds. */
  timeoutMs?: number;
}

export class JevError extends RefusalError {
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "JevError";
    this.status = status;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Bun workaround for @typesafe-ai/sdk 0.7.0, which fails every call under
 * Bun with "Body already used": its response buffering takes a reader on
 * the original body and releases it, Bun then treats that body as used
 * (oven-sh/bun#45306), and the SDK's later `text()` throws. Node tolerates
 * it. The wrapper reads the body here and hands the SDK a fresh Response
 * that streams those bytes from JavaScript, which Bun reads correctly; the
 * SDK's own buffering and abort handling run unchanged on it. This is the
 * workaround from the upstream report. Remove it once that issue is fixed:
 * https://github.com/typesafe-ai/typesafe-sdk-js/issues/20
 */
function bunSafeFetch(inner: JevFetch): JevFetch {
  return async (url, init) => {
    const res = await inner(url, init);
    if (res.body === null) return res;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

function toQuestion(q: DecisionQuestion): Question {
  switch (q.kind) {
    case "score": {
      const [first = "", second = "", ...rest] = q.levels;
      return { type: "score", instructions: q.instructions, criteria: [first, second, ...rest] };
    }
    case "choice":
      return {
        type: "choice",
        instructions: q.instructions,
        criteria: Object.fromEntries(q.options.map((o) => [o.name, o.description])),
      };
    case "noul":
      return { type: "noul", instructions: q.instructions };
  }
}

function fromAnswer(a: JevAnswer, q: DecisionQuestion): DecisionAnswer {
  switch (a.type) {
    case "score": {
      const levels = q.kind === "score" ? q.levels.length : 0;
      // Validation refused any answer missing a level, so every key exists.
      const probabilities = Array.from({ length: levels }, (_, i) => a.probabilities[String(i)] ?? 0);
      return { kind: "score", value: a.score, probabilities, confidence: a.confidence };
    }
    case "choice":
      return { kind: "choice", choice: a.choice, probabilities: a.probabilities, confidence: a.confidence };
    case "noul":
      return { kind: "noul", probability: a.noul };
  }
}

/** An SDK failure as a value-free refusal. The SDK's own messages are not
 * reused: an `APIError` message carries the response body. */
function toJevError(err: unknown, backend: Backend, keyVar: string): JevError {
  if (err instanceof JevError) return err;
  if (err instanceof APIError) {
    const cure = err.status === 401 || err.status === 403 ? `; check ${keyVar}` : "";
    return new JevError(`the ${backend.name} backend answered HTTP ${err.status}${cure}`, err.status);
  }
  if (err instanceof APITimeoutError)
    return new JevError(`could not reach the ${backend.name} backend (timed out)`);
  if (err instanceof APIConnectionError) {
    return new JevError(`could not reach the ${backend.name} backend (network error)`);
  }
  const kind = err instanceof Error ? err.name : typeof err;
  return new JevError(`the request to the ${backend.name} backend failed (${kind})`);
}

export function createJevEngine(options: JevEngineOptions): DecisionEngine {
  const backend = BACKENDS[options.backend];
  const model = options.model ?? DEFAULT_JEV_MODEL;
  const keyVar = options.apiKeyVar ?? DEFAULT_KEY_VARS[options.backend];
  if (!isJevModel(model)) {
    throw new JevError(`unknown Jev model "${model}"; pin one of ${JEV_MODELS.join(", ")}`);
  }
  if (options.apiKey.trim() === "") {
    // The SDK would otherwise fall back to TYPESAFE_API_KEY, the wrong key for OpenRouter.
    throw new JevError(`no API key for the ${backend.name} backend; set ${keyVar}`);
  }
  const spellings = backend.servedSpellings(model);
  const client = new TypeSafeClient({
    apiKey: options.apiKey,
    baseURL: backend.baseURL,
    defaultModel: backend.requestSpelling(model),
    fetch: bunSafeFetch(options.fetch ?? ((url, init) => globalThis.fetch(url, init))),
    // OpenRouter is not known to accept zstd request bodies.
    compression: false,
    // SDK logs could carry request details; errors here are the only voice.
    logLevel: "off",
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.retry === undefined ? {} : { retry: options.retry }),
  });

  return {
    id: JEV_ENGINE_ID,
    model,
    async decide(state, questions) {
      const ids = Object.keys(questions);
      if (ids.length === 0) throw new JevError("a decision needs at least one question");
      const wire: Record<string, Question> = {};
      for (const [id, q] of Object.entries(questions)) wire[id] = toQuestion(q);

      let raw: unknown;
      try {
        raw = await client.systemOne({
          model: backend.requestSpelling(model),
          state: state as NonNullable<EntryType>,
          questions: wire,
        });
      } catch (err) {
        throw toJevError(err, backend, keyVar);
      }

      const parsed = jevResultSchema.safeParse(raw);
      if (!parsed.success) {
        const where = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
        throw new JevError(`the ${backend.name} backend returned an unexpected shape (at ${where})`);
      }
      if (!servesPinnedModel(spellings, parsed.data.model)) {
        throw new JevError(
          `the ${backend.name} backend answered with model "${parsed.data.model}", not the pinned ${model}; ` +
            "its answers were discarded",
        );
      }
      const answers: Record<string, DecisionAnswer> = {};
      for (const [id, q] of Object.entries(questions)) {
        const answer = parsed.data.answers[id];
        if (answer === undefined)
          throw new JevError(`the ${backend.name} backend returned no answer for "${id}"`);
        const problem = answerProblem(q, answer);
        if (problem !== null)
          throw new JevError(`the ${backend.name} backend's answer for "${id}" ${problem}`);
        answers[id] = fromAnswer(answer, q);
      }
      return { servedModel: parsed.data.model, answers };
    },
  };
}
