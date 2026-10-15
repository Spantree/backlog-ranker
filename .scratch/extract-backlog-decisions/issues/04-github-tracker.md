# 04: GitHub tracker lists a repository's open issues

**What to build:** Given `github:owner/repo` and a token, the tracker returns every open issue (pull requests excluded) as tickets keyed `owner/repo#123`, paginating through large repositories, with title, body, labels, url, createdAt and the code-computed facts: reactions total, linked issues (cross-referenced and connected timeline items plus sub-issues and parent), duplicates (marked-as-duplicate timeline items). Looking up named keys for calibrate and explain refuses keys from another repository. The source grammar accepts both spellings and refuses `linear:` as a planned adapter.

**Blocked by:** 01 (package skeleton)

**Status:** resolved

- [x] Source parser and allowlist check ported; `github:owner/repo` served, `linear:TEAM` parses and refuses naming it a planned adapter
- [x] Tracker over octokit's GraphQL client with an injectable fetch for tests; one paginated query for pending issues, one lookup per key
- [x] Errors are value-free: operation and HTTP status only; auth failures name the token variable and the gh commands that mint one
- [x] Fixture: the evie-kit Linear fixture page reshaped into a GitHub GraphQL response carrying exactly the same titles, bodies, labels, createdAt and fact counts (so the recorded Jev answers hash-match in ticket 05); keys become `kit/kit#N`
- [x] Tests over a fake fetch: pagination, PR exclusion, facts mapping, key format, wrong-repo refusal, value-free errors
