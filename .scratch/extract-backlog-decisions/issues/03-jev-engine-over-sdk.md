# 03: Jev engine answers through the official TypeSafe SDK

**What to build:** Given a backend name (typesafe or openrouter), an API key and an optional pinned model, the package builds a decision engine that sends one request per state carrying every question, maps the SDK's answers onto the engine-neutral answer shape, refuses any served model version other than the pinned one (a dated snapshot suffix is accepted), and refuses a score or choice answer whose distribution is missing a key or does not sum to one within rounding. Errors name the backend and HTTP status, never the key or the state.

**Blocked by:** 01 (package skeleton)

**Status:** ready-for-agent

- [ ] Backend table: TypeSafe direct and OpenRouter, each with base URL, key variable name and model spelling; no custom base URL
- [ ] Pinned Jev versions list with `jev-1.14` default; an unknown version refuses before any client is built
- [ ] Engine adapter over the SDK client: engine id `typesafe`, model pinned, question and answer mapping both ways
- [ ] Validation: served-model check, exact-keys and sums-to-one checks for score and choice, type mismatch refused
- [ ] Retry behaviour for rate-limit and overload statuses relies on the SDK where it provides it; delays configurable for tests
- [ ] Tests replay the recorded responses from both backends (ported from evie-kit's typesafe fixtures) with the SDK's transport mocked, no network; the SDK's real surface is verified at install and any difference is absorbed in the adapter and noted in the ticket's comments

## Comments

- 2026-10-15, exploration: `@typesafe-ai/sdk` 0.7.0 fails on Bun 1.4.3 with "Body already used" because its response buffering takes a reader on the original body and then calls `text()`. Verified workaround: wrap the `fetch` option so the returned Response has its `body` property overridden to `null` (via `Object.defineProperty`); the SDK then reads the clone only. Returning a plain object fails (`response.clone is not a function`); returning a fresh `Response` fails the same way as baseline. Ship the wrapper in the adapter for both real and injected fetch, add a test that a canned response parses under `bun test`, and leave a comment pointing at the upstream repo `typesafe-ai/typesafe-sdk-js` so the shim can go once fixed. Full notes with quoted SDK source: scratchpad `notes/sdk-surface.md`.
- The SDK's `fetch` option is `(input: string, init?: RequestInit) => Promise<Response>`; retries are `retry: { maxRetries, ... }`; `compression: false` is advisable for OpenRouter and in tests; the model id is sent verbatim, so `jev-1.14` works on both backends with `baseURL` `https://api.typesafe.ai` or `https://openrouter.ai/api`.
- 2026-10-15, implementation: the installed SDK (0.7.0) matches the surface notes; no adaptation needed beyond the Bun body shim (confirmed load-bearing: without it the replay test fails under `bun test`). Choices worth knowing: the recorded OpenRouter fixtures came from the old alpha decisions endpoint, which reported `typesafe/jev-1.14-20261014`; the SDK now posts to `/api/v1/systemone` with the model verbatim, so the served-model check accepts per backend `jev-1.14` or `jev-1.14.0` (typesafe) and `jev-1.14` or `typesafe/jev-1.14` (openrouter), each optionally with a `-YYYYMMDD` suffix, and refuses other patches. Live OpenRouter spelling over the SDK path is unverified. Retries use the SDK defaults (408, 429, 5xx), broader than evie-kit's per-backend lists. An empty API key refuses naming the key variable, because the SDK would otherwise fall back to `TYPESAFE_API_KEY` even for OpenRouter. SDK logging is off and the per-attempt timeout defaults to 60 s (SDK default is 10 s). Node 22 check: one `decide` over a fake fetch against the tsc-built `dist/index.js`.
