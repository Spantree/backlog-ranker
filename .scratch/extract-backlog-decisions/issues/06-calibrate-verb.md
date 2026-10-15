# 06: `calibrate` reports Kendall's tau and gates CI

**What to build:** `backlog-decisions calibrate --rubric <name> --source github:owner/repo --hand owner/repo#12,owner/repo#7,…` scores the named issues, prints the hand order beside the tool order with composites and titles, Kendall's tau with concordant and discordant counts, the trust verdict (tau at least 0.4 on at least 12 tickets), engine and model, and the disagreeing pairs when not trusted. `--json` carries the same. The process exits 2 when the rubric is not trusted so a CI job can fail a rubric edit. Duplicate or fewer-than-two keys, and keys from another repository, refuse.

**Blocked by:** 05 (rank end to end)

**Status:** resolved

- [x] Hand list parsing accepts keys with or without the `#`, normalises case, refuses duplicates and lists shorter than two
- [x] Held rows rank after kept rows in the tool order
- [x] Exit code 2 on NOT TRUSTED, 0 on TRUSTED, 1 on refusal
- [x] Tests over the fixture network: tau report names engine and model, six tickets is NOT TRUSTED and exits 2, `--json` shape, refusals for duplicate and short lists and wrong-repo keys
