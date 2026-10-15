# 07: `explain` shows one ticket's reasoning

**What to build:** `backlog-decisions explain --rubric <name> owner/repo#123` derives the source from the key, checks the allowlist, and prints that ticket's composite, each criterion's score, confidence and per-level probability distribution with the level wording, each gate's probability against its threshold and resulting action, flags and whether the body was truncated. After a `rank`, every answer comes from the cache and no request is sent; cold, exactly one request is sent. `--json` carries the same data. An explain facade is exported for library callers.

**Blocked by:** 05 (rank end to end)

**Status:** resolved

- [x] Verb accepts one positional key; refuses a key that does not parse or whose repository is not on the allowlist
- [x] Output lists levels with their probabilities so the score is readable as a distribution
- [x] Explain facade exported from the package root
- [x] Tests over the fixture network: after rank, explain sends zero requests; cold, one request; `--json` shape; unlisted repository refuses with zero requests
