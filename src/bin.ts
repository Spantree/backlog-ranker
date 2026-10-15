#!/usr/bin/env node
/** The only place that touches the process: streams in, exit code out. */
import { run } from "./cli.js";

const code = await run(process.argv.slice(2), {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
  env: process.env,
});
process.exit(code);
