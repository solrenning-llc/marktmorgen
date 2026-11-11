import {AsyncLocalStorage} from 'node:async_hooks';
import {spawn, spawnSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';

/**
 * The most one test file may run, and the most its compilation may take: past it the file is named as a failure
 * (C4-20261106-2550-C5-151: on #2790 and #2820 the verify job sat 47 minutes after one file with no output until the
 * job's own cancellation, which names nothing). Ten minutes: about six times the slowest file in two full CI verify
 * logs (contract-admission-ack, 53.9 s and 100.8 s), and well under the job's 50 minutes
 * (.github/workflows/product-checks.yml).
 */
export const TEST_FILE_TIMEOUT_MS = 600_000;

/**
 * @template T
 * @param {Promise<T>} work @param {number | undefined} ms @param {string} what
 * @returns {Promise<T>}
 */
function within(work, ms, what) {
  if (ms === undefined) return work;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`TIMEOUT: ${what} did not finish in ${ms / 1000} s`)), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * How many test files run at once: TEST_CONCURRENCY, default 1 (one at a time, exactly as before). Anything other than
 * a whole number from 1 to 32 stops the run with an error, so a typo never silently runs serial or unbounded.
 * @param {string | undefined} value
 */
export function testConcurrency(value) {
  const text = (value ?? '').trim();
  if (text === '') return 1;
  const count = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!(count >= 1 && count <= 32)) throw new Error(`TEST_CONCURRENCY must be a whole number from 1 to 32, not ${JSON.stringify(value)}`);
  return count;
}

/**
 * Files that never run beside another one: with a concurrency above 1 they run after all the others, one at a time,
 * their output straight to the terminal as in a serial run. Each holds a wall-clock ceiling (a pattern read "at once",
 * a deadline, a wait that must not run long) that another file's CPU use could push past, or starts heavy processes
 * of its own. tests/test-runner.test.ts holds that every name here is a test file that exists.
 */
export const SERIAL_TEST_FILES = Object.freeze([
  // Wall-clock ceilings on CPU-bound reads (no pattern that goes back over itself).
  'ad-creative-check.test.ts', // < 1,000 ms
  'agreement-templates.test.ts', // < 200 ms
  'answers-terms-numbers.test.ts', // < 250 ms
  'first-name.test.ts', // < 200 ms and < 50 ms
  'lesson-code.test.ts', // < 50 ms
  'sequence-import.test.ts', // < 2,000 ms
  // Wall-clock windows around real timers and deadlines.
  'as1-orders-course-progress.test.ts', // answered in < 300 ms
  'assistant-memory-store.test.ts', // 1,000 to 4,000 ms
  'bot-check.test.ts', // 2,400 to 3,500 ms
  'call-series-rules.test.ts', // < 3,000 ms
  'checkup-disputes.test.ts', // < 2,000 ms
  'checkup.test.ts', // < 1,000 ms and < 2,000 ms
  'erasure-request-timing.test.ts', // two reads, each under half of a 600 ms send (performance.now)
  'safe-fetch-dns-deadline.test.ts', // 180 to 600 ms and 380 to 900 ms
  // Real child processes in groups of their own, ended at 0.4 to 1.2 s limits, under 1.5 s and 5 s guards.
  'test-runner.test.ts',
  // A real Chrome each (playwright-core), with its own renderer and GPU processes.
  'checkout-focus-browser.test.ts',
  'embed-editor-contrast.test.ts',
  'wg14-path-milestone-browser.test.ts',
]);

/** @typedef {(stream: 'out' | 'err', data: string | Uint8Array) => void} Write */

/**
 * The output of the test file running in this async context while files run side by side: each file's output is
 * kept, then printed whole and in file order, so two files never interleave. Outside it (one at a time) nothing is
 * kept and everything goes straight to the terminal, exactly as before.
 * @type {AsyncLocalStorage<{write: Write}>}
 */
const captured = new AsyncLocalStorage();

/** console.log for the runner's own lines (a file's heading), kept with that file's output while files run side by side. @param {string} text */
export function say(text) {
  const sink = captured.getStore();
  if (sink) sink.write('out', `${text}\n`);
  else console.log(text);
}

/** console.error for the runner's own lines (a timeout's diagnostic). @param {string} text */
function sayError(text) {
  const sink = captured.getStore();
  if (sink) sink.write('err', `${text}\n`);
  else console.error(text);
}

/**
 * Runs the test files: one at a time with concurrency 1 (the default, exactly as before), or up to `concurrency` at
 * once, each still in its own process and process group under the same limit, diagnostics and cleanup (runBundle),
 * its output kept and printed whole in file order; then the files of `serial`, one at a time, after all the others.
 * Failed files are counted the same way in both. A compilation that fails or a run that throws stops new files from
 * starting; the files already running finish and print, then the error of the first such file is thrown.
 * @template T
 * @param {{files: string[], compile: (file: string) => Promise<T>, run: (file: string, bundle: T, next: () => string) => Promise<number | null>, compileTimeoutMs?: number, concurrency?: number, serial?: readonly string[], write?: Write}} options
 */
export async function runTestFiles(options) {
  const concurrency = options.concurrency ?? 1;
  if (concurrency <= 1) return runSerially(options);
  const alone = new Set(options.serial ?? []);
  const failed = await runSideBySide({...options, concurrency, files: options.files.filter(file => !alone.has(file))});
  return failed + await runSerially({...options, files: options.files.filter(file => alone.has(file))});
}

/**
 * @template T
 * @param {{files: string[], compile: (file: string) => Promise<T>, run: (file: string, bundle: T, next: () => string) => Promise<number | null>, compileTimeoutMs?: number, concurrency: number, write?: Write}} options
 */
async function runSideBySide({files, compile, run, compileTimeoutMs, concurrency, write}) {
  if (!files.length) return 0;
  /** @type {Write} */
  const put = write ?? ((stream, data) => { (stream === 'out' ? process.stdout : process.stderr).write(data); });
  /** @type {Array<Promise<{ok: true, bundle: T} | {ok: false, error: unknown}> | undefined>} */
  const compiled = [];
  /** @type {boolean[]} */
  const settled = [];
  /** @param {number} index */
  const prepare = index => {
    if (index >= files.length || compiled[index]) return;
    // Rejection is handled from the start, even while the file waits for a free slot.
    compiled[index] = (async () => {
      try { return {ok: /** @type {const} */ (true), bundle: await compile(files[index])}; }
      catch (error) { return {ok: /** @type {const} */ (false), error}; }
      finally { settled[index] = true; }
    })();
  };
  /** @type {Array<Array<[('out' | 'err'), (string | Uint8Array)]> | undefined>} */
  const outputs = [];
  /** @type {boolean[]} */
  const finished = [];
  let printed = 0;
  // Prints, in file order, every finished file whose earlier files have all printed; at the end (all), a file that
  // never started because the run stopped is passed over.
  const flush = (all = false) => {
    while (printed < files.length && (finished[printed] || (all && !outputs[printed]))) {
      for (const [stream, data] of outputs[printed] ?? []) put(stream, data);
      outputs[printed] = undefined;
      printed += 1;
    }
  };
  let taken = 0, failed = 0;
  /** @type {{index: number, error: unknown} | null} */
  let stop = null;
  const slot = async () => {
    while (!stop && taken < files.length) {
      const index = taken;
      taken += 1;
      // As many compilations ready ahead as there are slots, so a slot that frees up rarely waits for esbuild.
      for (let ahead = 0; ahead <= concurrency; ahead += 1) prepare(index + ahead);
      /** @type {Array<[('out' | 'err'), (string | Uint8Array)]>} */
      const chunks = [];
      outputs[index] = chunks;
      try {
        const prepared = await within(/** @type {NonNullable<(typeof compiled)[number]>} */ (compiled[index]), compileTimeoutMs, `compiling ${files[index]}`);
        if (!prepared.ok) throw prepared.error;
        const next = () => index + 1 >= files.length ? 'none' : settled[index + 1] ? 'resolved' : 'pending';
        const status = await captured.run({write: (stream, data) => { chunks.push([stream, data]); }}, () => run(files[index], prepared.bundle, next));
        if (status !== 0) failed += 1;
      } catch (error) {
        if (!stop || index < stop.index) stop = {index, error};
      } finally {
        finished[index] = true;
        flush();
      }
    }
  };
  try {
    await Promise.all(Array.from({length: Math.min(concurrency, files.length)}, slot));
    flush(true);
    if (stop) throw stop.error;
    return failed;
  } finally {
    // Do not remove the temporary directory while esbuild is still writing it; each wait is under its own limit.
    await Promise.all(compiled.map(work => work && within(work, compileTimeoutMs, 'a compilation started ahead').catch(() => undefined)));
  }
}

/**
 * Keep each test process isolated and serial; prepare only the next bundle.
 * A run is told, by its third argument, whether the next file's compilation has settled ("resolved", "pending",
 * or "none" after the last file), for a timeout's diagnostic line. With compileTimeoutMs, a compilation that has
 * not settled by then fails naming its file, instead of leaving the runner waiting (C4-20261106-2600-C5-152).
 * @template T
 * @param {{files: string[], compile: (file: string) => Promise<T>, run: (file: string, bundle: T, next: () => string) => Promise<number | null>, compileTimeoutMs?: number}} options
 */
async function runSerially({files, compile, run, compileTimeoutMs}) {
  if (!files.length) return 0;
  /** @type {"resolved" | "pending" | "none"} */
  let nextState = 'none';
  // Attach rejection handling when compilation starts, even while a test runs.
  /** @param {string} file @returns {Promise<{ok: true, bundle: T} | {ok: false, error: unknown}>} */
  const prepare = async file => {
    try { return {ok: true, bundle: await compile(file)}; }
    catch (error) { return {ok: false, error}; }
    finally { nextState = 'resolved'; }
  };
  /** @type {ReturnType<typeof prepare> | null} */
  let pending = prepare(files[0]);
  let failed = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      if (!pending) throw new Error('Missing compiled test');
      const prepared = await within(pending, compileTimeoutMs, `compiling ${files[index]}`);
      pending = null;
      if (!prepared.ok) throw prepared.error;
      nextState = 'none';
      if (index + 1 < files.length) { nextState = 'pending'; pending = prepare(files[index + 1]); }
      if (await run(files[index], prepared.bundle, () => nextState) !== 0) failed += 1;
    }
    return failed;
  } finally {
    // Do not remove the temporary directory while esbuild is still writing it.
    // prepare always fulfills, so a secondary error cannot hide the first one; a compilation that never settles is
    // waited for no longer than its limit.
    if (pending) await within(pending, compileTimeoutMs, 'the last compilation').catch(() => undefined);
  }
}

/**
 * What /proc says of a process, for a timeout's diagnostic line: its State and each thread's wchan (what it waits in).
 * Only reads; "proc=unreadable" where /proc is not there or the process is gone.
 * @param {number} pid
 */
export function procState(pid) {
  try {
    const state = readFileSync(`/proc/${pid}/status`, 'utf8').match(/^State:\s*(.+)$/m)?.[1]?.trim() ?? '?';
    const threads = readdirSync(`/proc/${pid}/task`).map(task => {
      let wchan = '?';
      try { wchan = readFileSync(`/proc/${pid}/task/${task}/wchan`, 'utf8').trim() || '0'; } catch { /* unreadable */ }
      return `${task}:${wchan}`;
    });
    return `state=${state} wchan=${threads.join(',')}`;
  } catch { return 'proc=unreadable'; }
}

/** Where each test file runs in a process group of its own, so that group can be ended (POSIX). */
const OWN_GROUP = process.platform !== 'win32';
/** The groups of the files running now, ended if the runner itself is stopped (they no longer share its terminal group). */
const active = new Set();
let hooked = false;

/**
 * Ends a test file's process group, not only the process it started (Codex G on #2826, 5805110853: a descendant left
 * alive kept the inherited output open after the runner finished and overlapped the next file). POSIX: the file's own
 * process group; Windows: taskkill /T, the tree it can find. A process the file starts in a group of its own
 * (detached: true, or setsid) leaves the group and is not reached; only the system's own tools could follow it, and no
 * test file starts one (tests/test-runner.test.ts holds that; Codex G, 5805374280). Never throws.
 * @param {number} pid
 */
function endTree(pid) {
  try {
    if (OWN_GROUP) process.kill(-pid, 'SIGKILL');
    else spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {stdio: 'ignore'});
  } catch { /* nothing left in the group */ }
}

function hookRunnerStop() {
  if (hooked || !OWN_GROUP) return;
  hooked = true;
  const sweep = () => { for (const pid of active) endTree(/** @type {number} */ (pid)); };
  process.once('exit', sweep);
  for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
    process.once(signal, () => { sweep(); process.kill(process.pid, signal); });
  }
}

/**
 * @param {string} bundle @param {NodeJS.ProcessEnv} env @param {string} [executable]
 * @param {{timeoutMs?: number, label?: string, diagnose?: () => string}} [limit] with timeoutMs, a process still
 *   running then is described (whether exit came, /proc, and what diagnose adds), its process group ended and counted as failed
 * @returns {Promise<number>}
 */
export function runBundle(bundle, env, executable = process.execPath, limit = {}) {
  return new Promise(resolve => {
    hookRunnerStop();
    // While files run side by side (runTestFiles with a concurrency above 1), the output is kept for printing whole.
    const sink = captured.getStore();
    const child = spawn(executable, [bundle], {stdio: sink ? ['inherit', 'pipe', 'pipe'] : 'inherit', env, detached: OWN_GROUP});
    if (sink) {
      child.stdout?.on('data', data => sink.write('out', data));
      child.stderr?.on('data', data => sink.write('err', data));
    }
    const pid = child.pid;
    if (pid !== undefined && OWN_GROUP) active.add(pid);
    let settled = false;
    /** @type {{code: number | null, signal: NodeJS.Signals | null} | null} */
    let exited = null;
    /** @param {number} code */
    const finish = code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Whatever the file started and left running goes with it, so nothing overlaps the next file or holds the output.
      if (pid !== undefined) { endTree(pid); active.delete(pid); }
      resolve(code);
    };
    child.once('exit', (code, signal) => {
      exited = {code, signal};
      // With inherited output, close follows exit at once and the group is ended then; with kept output, a descendant
      // still holding the pipes would delay close, so the group is ended at exit, as soon as the inherited case does.
      // What the file wrote before it exited stays in the pipes and is still read to the end.
      if (sink && pid !== undefined) endTree(pid);
    });
    const timer = limit.timeoutMs === undefined ? undefined : setTimeout(() => {
      const seen = exited ? `exit seen (code ${exited.code}, signal ${exited.signal})` : 'exit not seen';
      const proc = pid === undefined ? 'pid=none' : procState(pid);
      let extra = '';
      try { extra = limit.diagnose ? `; ${limit.diagnose()}` : ''; } catch { /* the line goes out without it */ }
      sayError(`TIMEOUT: ${limit.label ?? bundle} did not finish in ${(limit.timeoutMs ?? 0) / 1000} s; ${seen}; ${proc}${extra}; killed with its process group and counted as a failure.`);
      // Already gone (close never came): its process group is ended and it fails now.
      if (exited) return finish(1);
      if (pid !== undefined) endTree(pid);
      else child.kill('SIGKILL');
      // Kept output is read to its end (close, which follows the group's end) before the file's output is printed.
      child.once(sink ? 'close' : 'exit', () => finish(1));
      // Should no exit follow the kill (a process never reaped), the file still fails, and the run goes on.
      setTimeout(() => finish(1), 5_000).unref();
    }, limit.timeoutMs);
    // spawnSync returned a null status on launch errors: count the failure
    // and keep running the other test files, rather than dropping coverage.
    child.once('error', () => finish(1));
    // Wait for stdio to close before the next test's heading, as spawnSync did.
    child.once('close', code => finish(code ?? 1));
  });
}
