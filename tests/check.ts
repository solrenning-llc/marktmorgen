/**
 * The two words every test here is written with.
 *
 * Deliberately not a framework. A test that needs a runner installed is a
 * test that stops being run the first time an install breaks, and what these
 * are for is catching the things that only show up when the code is actually
 * executed — which is where every defect found while building this came from.
 */
let failures = 0;
let checks = 0;
/** Whether the file reached done(): only that ends it with 0. */
let reached = false;

// A file that stops before done(), on a promise that never settles, ends when the event loop empties, with code 0:
// it would pass in CI without a word (Claude 6, 9 November 2026). At its exit it fails instead, with a line that
// says so. A file that reached done(), or that already fails (a check, an error thrown), is left as it is.
process.once("exit", (code) => {
  if (reached || code !== 0) return;
  console.log(`\nThis test file ended without reaching done() (${checks} checks ran): counted as a failure.`);
  process.exitCode = 1;
});

/** Compares by value, prints the line, and remembers a failure. */
export function is(what: string, got: unknown, want: unknown): void {
  checks += 1;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) {
    console.log(`  ok    ${what}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL  ${what}`);
  console.log(`        expected ${JSON.stringify(want)}`);
  console.log(`        got      ${JSON.stringify(got)}`);
}

/** A heading, so a run reads as sections rather than as one long list. */
export function part(name: string): void {
  console.log(`\n${name}`);
}

/** Ends the process with the right code: what makes this usable in CI. */
export function done(): void {
  reached = true;
  console.log(
    failures === 0
      ? `\n${checks} checks, all passing.`
      : `\n${checks} checks, ${failures} failing.`,
  );
  // Ends by its exit code, never process.exit(): Node 24 can deadlock inside process.exit() when a V8 background
  // task waits for a garbage collection only the main thread can run (nodejs/node#64560; 9 CI verify jobs hung
  // 48 min after "96 checks, all passing." on 6 November). A normal end tears the heap down first. Anything a test
  // leaves open still ends the run: the timer below does not hold the process, it only fires if something else does.
  process.exitCode = failures === 0 ? 0 : 1;
  setTimeout(() => process.exit(process.exitCode), 2_000).unref();
}
