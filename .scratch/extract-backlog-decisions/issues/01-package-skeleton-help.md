# 01: Package skeleton runs `--help` on Node and Bun

**What to build:** A user installs the package, runs `backlog-decisions --help` and each verb's `--help` under plain `node` and under `bun`, and sees usage on stdout with exit 0. A bad flag prints a refusal message-first on stderr with exit 1, and a stack trace only when `BACKLOG_DECISIONS_DEBUG` is set. This ticket lays the foundation every later slice builds on: toolchain, the two error brands, and the engine-neutral and tracker interfaces, so tickets 02, 03 and 04 can proceed in parallel.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] `package.json` named `backlog-decisions`, bin of the same name, version 2026.10.15, MIT, `engines.node >= 22`, ESM, `exports` and `bin` pointing at the compiled output, runtime deps `@typesafe-ai/sdk`, `@octokit/graphql`, `yaml`, `zod`
- [ ] tsc emits ESM plus declarations into `dist/`; `bun run build`, `bun run typecheck`, `bun run lint` (biome), `bun run test` scripts exist and pass
- [ ] `.mise.toml` pins Bun 1.4.3 and Node 22.23.3; `.gitignore` covers `dist/`, `node_modules/`, `.backlog-decisions/cache/`, `.backlog-decisions/**/*.local.yaml`
- [ ] Errors module: refusal brand and help-request brand as registry symbols, with property-based guards, exported
- [ ] Engine-neutral decision interface (score, choice, noul questions; typed answers; decide per state), tracker interface and ticket shape exported, ported from evie-kit unchanged in meaning
- [ ] Bin dispatches `rank`, `calibrate`, `explain` (stubs that refuse "not implemented yet" are fine) and renders help and refusals per the spec's CLI section
- [ ] Tests: help is a help request on stdout with exit 0; a refusal is message-first on stderr with exit 1; debug variable restores frames; the built bin runs under `node dist/bin.js --help`
- [ ] LICENSE (MIT, Sebastian Otaegui)
