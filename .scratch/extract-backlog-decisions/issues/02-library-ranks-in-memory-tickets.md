# 02: Library ranks and calibrates in-memory tickets with a stub engine

**What to build:** A developer imports the package, hands the rank facade a rubric object, a list of tickets, a stub engine, a temp cache and a clock, and gets back a ranking with per-criterion answers, pins, holds, low-confidence flags, composite scores and engine stats. A second call with changed weights sends nothing because every answer comes from the cache. The calibrate facade returns Kendall's tau, the trust verdict and the disagreeing pairs against a hand ranking. Everything the facades need is ported from evie-kit with the same behaviour.

**Blocked by:** 01 (package skeleton)

**Status:** ready-for-agent

- [ ] Rubric schema and parser ported, YAML read with the `yaml` package, a short content hash of the rubric text available on load, local file replaces committed file outright, weight overrides validated
- [ ] State building and hashing ported: title, sorted labels, body, facts; 30,000-byte prompt budget; body clipping on character boundaries with the truncation note naming `backlog-decisions`; canonical JSON; SHA-256
- [ ] Cache ported: one file per engine and model, keyed by state hash and question hash, merge on flush, schema tag, model isolation
- [ ] Composition (weighted_sum and roi), scoring pool with concurrency bound and fail-fast settle, tie-break in both orders within pinned and unpinned groups, Kendall's tau ported
- [ ] Rank facade and calibrate facade exported from the package root, taking rubric object or path, engine, tracker or ticket list, cache, clock, optional weights, tie-break depth, concurrency
- [ ] Unit suites ported and green: rubric, state, cache, compose, score, tiebreak, kendall
- [ ] Facade test: hand-built tickets through a stub engine rank as expected; a re-weighted call records zero engine calls
