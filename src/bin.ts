#!/usr/bin/env node
/** The only place that touches the process: streams in, exit code out. */
import { run } from "./cli.js";

/** A reader that closes its end early (`backlog-ranker rank ... | head`)
 * makes the next write fail with EPIPE. That is the reader's choice, not a
 * failure: exit 0 at once, quietly, as a closed reader expects. Any other
 * write error exits 1 with one line, on stderr when stderr still works. */
function onWriteError(name: "stdout" | "stderr") {
  return (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
    if (name === "stdout") {
      try {
        process.stderr.write(`backlog-ranker: cannot write to stdout (${error.code ?? error.message})\n`);
      } catch {
        // stderr is gone too; the exit code still says it failed.
      }
    }
    process.exit(1);
  };
}

process.stdout.on("error", onWriteError("stdout"));
process.stderr.on("error", onWriteError("stderr"));

/** Piped stdout and stderr are written asynchronously on macOS, so a write
 * can still be queued when the run returns. Each stream keeps the promise
 * of its last write's callback, and the process exits only once both have
 * settled: exiting at once would cut piped output short, and waiting for
 * the event loop to empty would let a request still in flight after a
 * failed run hold the process open. */
function writer(stream: NodeJS.WriteStream) {
  let last: Promise<void> = Promise.resolve();
  return {
    write(text: string) {
      last = new Promise((resolve) => {
        stream.write(text, () => resolve());
      });
    },
    drained: () => last,
  };
}

const out = writer(process.stdout);
const err = writer(process.stderr);
const code = await run(
  process.argv.slice(2),
  { stdout: out.write, stderr: err.write, env: process.env },
  { cwd: () => process.cwd() },
);
await Promise.all([out.drained(), err.drained()]);
process.exit(code);
