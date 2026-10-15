# 05: `rank` runs end to end from a project directory

**What to build:** From any directory inside a project holding `.backlog-decisions/config.yaml` and `rubrics/<name>.yaml`, `backlog-decisions rank --rubric <name> --source github:owner/repo` prints the ranked table: header with rubric path and hash, source, engine, model and backend; one row per issue with composite, each criterion's score and confidence, each gate's probability against its threshold, flags and title; held rows in their own block; stats lines. `--json` carries the same data. `--weight` re-ranks from the cache with no requests, `--tiebreak n` re-orders the top slice, `--concurrency n` bounds requests. A source not on the committed allowlist refuses before the rubric is read with zero requests sent. A missing config refuses with a minimal example. A missing key variable refuses naming it.

**Blocked by:** 02 (library core), 03 (Jev engine), 04 (GitHub tracker)

**Status:** resolved

- [x] Config schema (sources, backend, model, keys with defaults) parsed strictly from YAML; `config.local.yaml` replaces outright and the run says which file it read
- [x] Project root walk to the nearest `.backlog-decisions/` or `.git`
- [x] Loader: allowlist first, then rubric, then lazy engine and tracker; exported from the package root
- [x] parseArgs-based flags with short aliases `-r -s -w -t -j`; unknown flags and stray arguments refused by name; `--help` per verb
- [x] Table renderer with threshold beside gate probabilities and rubric hash in the header; `--json` shape per the spec
- [x] CLI tests over the fixture network (ported from evie-kit's backlog CLI suite): ranked table with zero live requests, re-weighting asks nothing, unlisted source refuses with zero requests and no cache file, allowlist before rubric, case-insensitive source, `--json`, tie-break reorder from recorded pairwise answers
- [x] Loader tests in temp projects: missing config, local override wins, unset key variable, root walk
- [x] The built bin runs `rank` under `node` against a temp fixture project with an injected fake network
