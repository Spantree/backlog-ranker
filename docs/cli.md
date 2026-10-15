# CLI

```text
usage: backlog-decisions <verb> [options]

verbs:
  rank       Rank a source's open tickets against a rubric
  calibrate  Compare the tool's ranking with a hand ranking
  explain    Show one ticket's scores, gates and flags

Run `backlog-decisions <verb> --help` for a verb's options.
```

Every verb reads `.backlog-decisions/config.yaml` from the project root and checks the source against its allowlist before anything else (see [config.md](config.md)). Unknown flags, stray arguments and malformed values are refused by name. Short aliases: `-r` rubric, `-s` source, `-w` weight, `-t` tiebreak, `-j` json, `-h` help.

## rank

```text
usage: backlog-decisions rank --rubric <name|path> --source <spec> [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/, or a YAML file path
  -s, --source <spec>     github:owner/repo (linear:TEAM is planned)
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -t, --tiebreak <n>      Pairwise tie-break depth
      --concurrency <n>   Parallel engine requests
  -j, --json              Machine-readable output
      --allow-once        Admit this source for one run, never persisted
      --backend <name>    With --allow-once and no config: typesafe or openrouter
  -h, --help              This text
```

Ranks every open issue of the source (pull requests are never included) and prints a table: one row per issue with its composite, each criterion's score and confidence, each gate's probability against its threshold, and its flags. Issues held by a `flag_if_below` gate are listed below the ranking.

- `--rubric` takes a name, resolved as `.backlog-decisions/rubrics/<name>.local.yaml` then `<name>.yaml`, or a file path (contains `/` or ends in `.yaml`/`.yml`). A relative path resolves against the project root (the nearest directory holding `.backlog-decisions/` or `.git`), or the working directory when there is none. `calibrate` and `explain` take `--rubric` the same way.
- `--weight <criterion>=<number>` may repeat; the last value for a criterion wins. It never sends a new request.
- `--tiebreak` takes 1 to 10. Asks pairwise questions over the top rows; see [rubrics.md](rubrics.md#tie-break).
- `--concurrency` takes a whole number of at least 1. Default 8.
- `--allow-once` admits `--source` for this run only and prints what will be sent. `--backend` applies only with it and only when no config file exists, and is required then; with a config file the committed config chooses the backend and `--backend` is refused.

```bash
backlog-decisions rank -r impact-roi -s github:acme/app -w impact=2 -t 5
```

## calibrate

```text
usage: backlog-decisions calibrate --rubric <name> --source <spec> --hand KEY,KEY,... [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/
  -s, --source <spec>     github:owner/repo (linear:TEAM is planned)
      --hand <keys>       Hand ranking, best first, comma separated
  -w, --weight <id=n>     Override a criterion weight; repeatable
  -j, --json              Machine-readable output
  -h, --help              This text

Exits 2 when the tool's ranking is not trusted.
```

Scores the hand-ranked issues, orders them as `rank` would (held issues after every kept one) and prints both orders side by side with Kendall's tau. When the rubric is not trusted (tau under 0.4, or fewer than 12 issues), it lists the pairs the rubric orders against the hand ranking and exits 2.

`--hand` keys may be written `owner/repo#N`, `#N` or `N`. Keys from another repository, a repeated key, or fewer than two keys are refused before any request.

```bash
backlog-decisions calibrate -r impact-roi -s github:acme/app --hand '#12,#7,#31,#4,#18,#2,#40,#9,#22,#15,#3,#27'
```

## explain

```text
usage: backlog-decisions explain --rubric <name> <owner/repo#123> [options]

  -r, --rubric <name>     Rubric under .backlog-decisions/rubrics/
  -j, --json              Machine-readable output
  -h, --help              This text
```

Prints one issue's composite, each criterion's per-level probabilities, score and confidence, each gate's probability against its threshold and whether it pinned or held the issue, and its flags. The source is the key's repository, which must be on the allowlist, and the header names it. Decision-model answers come from the cache after a rank; one GitHub lookup reads the issue. Without cached answers, one decision-model request is sent.

```bash
backlog-decisions explain -r impact-roi acme/app#42
```

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success, or `--help` (printed on stdout) |
| 1 | A refusal or an error: usage, config, allowlist, missing key, GitHub or backend failure. Printed on stderr |
| 2 | `calibrate` only: the rubric is not trusted |

## Errors and BACKLOG_DECISIONS_DEBUG

A refusal (something you can fix: a usage error, a missing config, an unlisted source, an unset key, a failed request) prints just its message (no error class name) and no stack trace, followed by `(BACKLOG_DECISIONS_DEBUG=1 for a stack)`. Set `BACKLOG_DECISIONS_DEBUG` to any non-empty value to print the stack frames too. Unexpected errors print `Name: message` and always their frames. Causes are printed after the error, each on a `caused by:` line.

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
| `held` | Rows held by a `flag_if_below` gate |

Each row: `position` (1-based; `null` for held rows), `key`, `title`, `url`, `composite`, `pinnedBy`, `heldBy`, `lowConfidence` (gate or criterion ids), `truncated`, and `answers` keyed by criterion or gate id. A criterion answer is `{ "kind": "score", "value", "probabilities", "confidence" }`, where `value` is the probability-weighted level index and `probabilities` lists one probability per level. A gate answer is `{ "kind": "noul", "probability" }`.

`calibrate`: `rubric`, `rubricHash`, `rubricPath`, `configPath`, `source`, `engine`, `model`, `backend`, `hand` (the expanded keys), `tool` (the tool's order of the same keys), `stats`, and the calibration: `n`, `concordant`, `discordant`, `tau`, `trusted`, `disagreements` (`{ "above", "below" }` pairs, the hand ranking's choice first). The exit code is 2 when `trusted` is false, with or without `--json`.

`explain`: `rubric`, `rubricPath`, `rubricHash`, `configPath`, `source`, `engine`, `model`, `backend`, `key`, `title`, `url`, `composite`, `criteria` (each `id`, `direction`, `weight`, `score`, `confidence`, `lowConfidence`, and `levels` as `{ "index", "text", "probability" }`), `gates` (each `id`, `action`, `threshold`, `probability`, `triggered`), `flags` (`pinnedBy`, `heldBy`, `lowConfidence`, `truncated`: the body was cut to fit the prompt) and `stats`.
