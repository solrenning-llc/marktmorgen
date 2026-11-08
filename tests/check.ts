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
