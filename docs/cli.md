# CLI

```text
usage: backlog-ranker <verb> [options]

verbs:
  rank       Rank a source's pending tickets against a rubric
  calibrate  Compare the tool's ranking with a hand ranking
  explain    Show one ticket's scores, gates and flags

Run `backlog-ranker <verb> --help` for a verb's options.
```

Every verb reads `.backlog-ranker/config.yaml` from the project root and checks the source against its allowlist before anything else (see [config.md](config.md)). Unknown flags, stray arguments and malformed values are refused by name. Short aliases: `-r` rubric, `-s` source, `-w` weight, `-t` tiebreak, `-j` json, `-h` help.

## rank

```text
usage: backlog-ranker rank --rubric <name|path> --source <spec> [options]

  -r, --rubric <name>     Rubric under .backlog-ranker/rubrics/, or a YAML file path
                          (a relative path resolves against the project root)
  -s, --source <spec>     github:owner/repo or linear:TEAM
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -t, --tiebreak <n>      Pairwise tie-break depth
      --concurrency <n>   Parallel engine requests
  -j, --json              Machine-readable output
      --allow-once        Admit this source for one run, never persisted
      --backend <name>    With --allow-once and no config: typesafe or openrouter
  -h, --help              This text

github:owner/repo ranks the repository's open issues, keyed owner/repo#123.
linear:TEAM ranks the team's issues in the states linear.states names (Backlog
and Todo by default), keyed TEAM-123, with the key in LINEAR_API_KEY by default.
```

Ranks every pending issue of the source and prints a table: one row per issue with its composite, each criterion's score and confidence, each gate's probability against its threshold, and its flags. Rows are pinned, then normal, then sunk, each by composite. Issues held by a `flag_if_below` gate or a `hold` fact gate are listed below the ranking.

Flags: `pinned:<gate>`, `held:<gate>` (a `flag_if_below` gate or a `hold` fact gate), `sunk:<fact gate>`, `low-confidence:<criterion>` and `truncated`. See [rubrics.md](rubrics.md#fact-gates) for fact gates and their precedence.

- A `github:<owner>/<repo>` source ranks every open issue of the repository (pull requests are never included); keys look like `acme/app#42`.
- A `linear:<TEAM>` source ranks the team's issues in the workflow states `linear.states` names, Backlog and Todo by default (see [config.md](config.md#linear-states)); keys are Linear identifiers such as `ENG-42`. The team key is case-insensitive and printed uppercase.
- `--rubric` takes a name, resolved as `.backlog-ranker/rubrics/<name>.local.yaml` then `<name>.yaml`, or a file path (contains `/` or ends in `.yaml`/`.yml`). A relative path resolves against the project root (the nearest directory holding `.backlog-ranker/` or `.git`), or the working directory when there is none. `calibrate` and `explain` take `--rubric` the same way.
- `--weight <criterion>=<number>` may repeat; the last value for a criterion wins. It never sends a new request.
- `--tiebreak` takes 1 to 10. Asks pairwise questions over the top rows; see [rubrics.md](rubrics.md#tie-break).
- `--concurrency` takes a whole number of at least 1. Default 8.
- `--allow-once` admits `--source` for this run only and prints what will be sent. `--backend` applies only with it and only when no config file exists, and is required then; with a config file the committed config chooses the backend and `--backend` is refused.

```bash
backlog-ranker rank -r impact-roi -s github:acme/app -w impact=2 -t 5
backlog-ranker rank -r impact-roi -s linear:ENG
```

## calibrate

```text
usage: backlog-ranker calibrate --rubric <name|path> --source <spec> --hand KEY,KEY,... [options]

  -r, --rubric <name>     Rubric under .backlog-ranker/rubrics/, or a YAML file path
                          (a relative path resolves against the project root)
  -s, --source <spec>     github:owner/repo or linear:TEAM
      --hand <keys>       Hand ranking, best first, comma separated: owner/repo#123
                          or TEAM-123 keys, or bare 123 within the source
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -j, --json              Machine-readable output
  -h, --help              This text

Exits 2 when the tool's ranking is not trusted.
```

Scores the hand-ranked issues, orders them as `rank` would (pinned, normal and sunk issues, then held issues after every ranked one) and prints both orders side by side with Kendall's tau. When the rubric is not trusted (tau under 0.4, or fewer than 12 issues), it lists the pairs the rubric orders against the hand ranking and exits 2.

`--hand` keys may be written `owner/repo#N` for a GitHub source or `TEAM-N` for a Linear one, or `#N` or `N`, which expand to the source's repository or team. Keys from another repository or team, a repeated key, or fewer than two keys are refused before any request. The named issues are read in any state, so a calibration set may include issues that have since been closed or moved on.

```bash
backlog-ranker calibrate -r impact-roi -s github:acme/app --hand '#12,#7,#31,#4,#18,#2,#40,#9,#22,#15,#3,#27'
backlog-ranker calibrate -r impact-roi -s linear:ENG --hand ENG-12,ENG-7,31,4,18,2,40,9,22,15,3,27
```

## explain

```text
usage: backlog-ranker explain --rubric <name|path> <owner/repo#123|TEAM-123> [options]

  -r, --rubric <name>     Rubric under .backlog-ranker/rubrics/, or a YAML file path
                          (a relative path resolves against the project root)
  -j, --json              Machine-readable output
  -h, --help              This text

The key names its source: owner/repo#123 is github:owner/repo, TEAM-123 is
linear:TEAM; either must be on the allowlist. Decision-model answers come from
the cache after a rank; one tracker lookup reads the issue, in any state.
```

Prints one issue's composite, its facts (age, reactions, linked_issues, duplicates, open_blockers, open_closing_prs, assignees), each criterion's per-level probabilities, score and confidence, each gate's probability against its threshold and whether it pinned or held the issue, each fact gate's value against its `at_least` and its outcome, and its flags. The source is the key's repository (`acme/app#42` is `github:acme/app`) or Linear team (`ENG-42` is `linear:ENG`), which must be on the allowlist, and the header names it. Decision-model answers come from the cache after a rank; one GitHub or Linear lookup reads the issue. Without cached answers, one decision-model request is sent.

```bash
backlog-ranker explain -r impact-roi acme/app#42
backlog-ranker explain -r impact-roi ENG-42
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, or `--help` (printed on stdout), or the reader closed the output pipe early (`backlog-ranker rank ... \| head`): the run stops quietly at the first write that finds the pipe closed |
| 1 | A refusal or an error: usage, config, allowlist, missing key, GitHub, Linear or backend failure, or any other failure to write the output. Printed on stderr |
| 2 | `calibrate` only: the rubric is not trusted |

## Errors and BACKLOG_RANKER_DEBUG

A refusal (something you can fix: a usage error, a missing config, an unlisted source, an unset key, a failed request) prints just its message (no error class name) and no stack trace, followed by `(BACKLOG_RANKER_DEBUG=1 for a stack)`. Set `BACKLOG_RANKER_DEBUG` to any non-empty value to print the stack frames too. Unexpected errors print `Name: message` and always their frames. Causes are printed after the error, each on a `caused by:` line.

## JSON output

`--json` prints one object on stdout instead of the table.

`rank`:

| Field | Meaning |
| --- | --- |
| `rubric`, `rubricPath`, `rubricHash` | Rubric name, the file read, the first 12 hex digits of its SHA-256 |
| `configPath` | The config file read, or `(no config: --allow-once)` |
| `source`, `engine`, `model`, `backend` | What was ranked and what answered |
| `stats` | `tickets`, `requests`, `cachedAnswers`, `askedAnswers`, `truncated` (keys whose body was cut) |
| `tiebreak` | Present with `--tiebreak`: `pairs`, `requests`, `cacheHits`, `truncatedPairs`, `top` |
| `ranked` | Rows in order |
| `held` | Rows held by a `flag_if_below` gate or a `hold` fact gate |

Each row: `position` (1-based; `null` for held rows), `key`, `title`, `url`, `composite`, `pinnedBy`, `heldBy` (gate and fact gate ids), `sunkBy` (fact gate ids), `lowConfidence` (criterion ids), `truncated`, `facts` (`reactions`, `linked_issues`, `duplicates`, `open_blockers`, `open_closing_prs`, `assignees`), and `answers` keyed by criterion or gate id. A criterion answer is `{ "kind": "score", "value", "probabilities", "confidence" }`, where `value` is the probability-weighted level index and `probabilities` lists one probability per level. A gate answer is `{ "kind": "noul", "probability" }`.

`calibrate`: `rubric`, `rubricHash`, `rubricPath`, `configPath`, `source`, `engine`, `model`, `backend`, `hand` (the expanded keys), `tool` (the tool's order of the same keys), `stats`, and the calibration: `n`, `concordant`, `discordant`, `tau`, `trusted`, `disagreements` (`{ "above", "below" }` pairs, the hand ranking's choice first). The exit code is 2 when `trusted` is false, with or without `--json`.

`explain`: `rubric`, `rubricPath`, `rubricHash`, `configPath`, `source`, `engine`, `model`, `backend`, `key`, `title`, `url`, `composite`, `criteria` (each `id`, `direction`, `weight`, `score`, `confidence`, `lowConfidence`, and `levels` as `{ "index", "text", "probability" }`), `facts` (`age` and the six numeric facts), `gates` (each `id`, `action`, `threshold`, `probability`, `triggered`), `factGates` (each `id`, `fact`, `action`, `atLeast`, `value`, `fired`, and `outcome`: `held`, `sunk` or `none`), `flags` (`pinnedBy`, `heldBy`, `sunkBy`, `lowConfidence`, `truncated`: the body was cut to fit the prompt) and `stats`.
