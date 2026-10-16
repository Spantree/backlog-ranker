# Re-recording the Jev fixtures

Re-record after changing `src/fixtures/rubric.yaml`, `src/fixtures/github-issues.json`, or anything that changes the state sent (its fields, the age buckets, the prompt budget). It costs real requests: run it only when the user asks.

```bash
OPENROUTER_API_KEY=... mise exec -- bun scripts/capture-fixtures.ts
OPENROUTER_API_KEY=... mise exec -- bun scripts/capture-fixtures.ts --model jev-1.13 --out <dir>
```

- The Linear team's Backlog and Todo issues carry the same tickets as the GitHub page (`src/github-fixture.test.ts` checks it), so both replay the same recordings: change them together.
- The script scores and tie-breaks the top 10 fixture issues against a cold cache in a temporary directory, through OpenRouter, with ages pinned to `FIXTURE_NOW`. It writes each response to `src/fixtures/jev/<hash16>.json` with its `id` removed, and only after the whole run has passed the engine's checks, so a failed run leaves the folder untouched.
- `src/fixtures/jev/` holds the default model's (jev-1.14) recordings only. Recordings are named by state hash alone, so a capture with another `--model` needs an `--out <dir>` elsewhere.

Done when the suite passes on the new recordings and they are committed with the change that required them.
