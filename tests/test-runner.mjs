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
 * Keep each test process isolated and serial; prepare only the next bundle.
 * A run is told, by its third argument, whether the next file's compilation has settled ("resolved", "pending",
 * or "none" after the last file), for a timeout's diagnostic line. With compileTimeoutMs, a compilation that has
 * not settled by then fails naming its file, instead of leaving the runner waiting (C4-20261106-2600-C5-152).
 * @template T
 * @param {{files: string[], compile: (file: string) => Promise<T>, run: (file: string, bundle: T, next: () => string) => Promise<number | null>, compileTimeoutMs?: number}} options
 */
export async function runTestFiles({files, compile, run, compileTimeoutMs}) {
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
    const child = spawn(executable, [bundle], {stdio: 'inherit', env, detached: OWN_GROUP});
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
    child.once('exit', (code, signal) => { exited = {code, signal}; });
    const timer = limit.timeoutMs === undefined ? undefined : setTimeout(() => {
      const seen = exited ? `exit seen (code ${exited.code}, signal ${exited.signal})` : 'exit not seen';
      const proc = pid === undefined ? 'pid=none' : procState(pid);
      let extra = '';
      try { extra = limit.diagnose ? `; ${limit.diagnose()}` : ''; } catch { /* the line goes out without it */ }
      console.error(`TIMEOUT: ${limit.label ?? bundle} did not finish in ${(limit.timeoutMs ?? 0) / 1000} s; ${seen}; ${proc}${extra}; killed with its process group and counted as a failure.`);
      // Already gone (close never came): its process group is ended and it fails now.
      if (exited) return finish(1);
      if (pid !== undefined) endTree(pid);
      else child.kill('SIGKILL');
      child.once('exit', () => finish(1));
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
