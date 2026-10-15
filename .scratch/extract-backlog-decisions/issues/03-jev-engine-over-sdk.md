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
