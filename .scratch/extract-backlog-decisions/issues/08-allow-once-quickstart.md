# 08: `--allow-once` tries a public repository without config

**What to build:** A newcomer with only an OpenRouter or TypeSafe key and a GitHub token runs `backlog-decisions rank --rubric <path-or-name> --source github:owner/repo --allow-once --backend openrouter` in a directory with no config file. The run prints a one-line notice saying the named repository's issue titles, bodies and labels will be sent to the named backend for this run only, then proceeds. Nothing is written to any config file. With a config file present, `--allow-once` admits the one source for the run and `--backend` is optional. Keys come from the default environment variable names.

**Blocked by:** 05 (rank end to end)

**Status:** resolved

- [x] `--allow-once` admits exactly the `--source` given, for this process only; the notice names source and backend
- [x] `--backend` accepted only with `--allow-once`; required when no config file resolves; refused values name the two backends
- [x] With no config file, the cache still lands under `.backlog-decisions/cache/` beneath the project root (or cwd when no root marker exists)
- [x] Tests: no-config run succeeds with the notice and sends requests; the config directory holds only the cache afterwards; `--allow-once` with a config file admits the source without editing the file; `--backend` without `--allow-once` refuses
