import {spawn} from 'node:child_process';

/**
 * Keep each test process isolated and serial; prepare only the next bundle.
 * @template T
 * @param {{files: string[], compile: (file: string) => Promise<T>, run: (file: string, bundle: T) => Promise<number | null>}} options
 */
export async function runTestFiles({files, compile, run}) {
  if (!files.length) return 0;
  // Attach rejection handling when compilation starts, even while a test runs.
  /** @param {string} file @returns {Promise<{ok: true, bundle: T} | {ok: false, error: unknown}>} */
  const prepare = async file => {
    try { return {ok: true, bundle: await compile(file)}; }
    catch (error) { return {ok: false, error}; }
  };
  /** @type {ReturnType<typeof prepare> | null} */
  let pending = prepare(files[0]);
  let failed = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      if (!pending) throw new Error('Missing compiled test');
      const prepared = await pending;
      pending = null;
      if (!prepared.ok) throw prepared.error;
      if (index + 1 < files.length) pending = prepare(files[index + 1]);
      if (await run(files[index], prepared.bundle) !== 0) failed += 1;
    }
    return failed;
  } finally {
    // Do not remove the temporary directory while esbuild is still writing it.
    // prepare always fulfills, so a secondary error cannot hide the first one.
    await pending;
  }
}

/**
 * The most one test file may run: past it the file is killed and counted as a failure that names it (C4-20261106-2550-C5-151:
 * on #2790 and #2820 the verify job sat 47 minutes in one file with no output until the job's own cancellation, which
 * names nothing). Ten minutes: about six times the slowest file in two full CI verify logs (contract-admission-ack,
 * 53.9 s and 100.8 s), and well under the job's 50 minutes (.github/workflows/product-checks.yml).
 */
export const TEST_FILE_TIMEOUT_MS = 600_000;

/**
 * @param {string} bundle @param {NodeJS.ProcessEnv} env @param {string} [executable]
 * @param {{timeoutMs?: number, label?: string}} [limit] with timeoutMs, a process still running then is killed and counted as failed
 * @returns {Promise<number>}
 */
export function runBundle(bundle, env, executable = process.execPath, limit = {}) {
  return new Promise(resolve => {
    const child = spawn(executable, [bundle], {stdio: 'inherit', env});
    let settled = false;
    /** @param {number} code */
    const finish = code => { if (!settled) { settled = true; clearTimeout(timer); resolve(code); } };
    const timer = limit.timeoutMs === undefined ? undefined : setTimeout(() => {
      console.error(`TIMEOUT: ${limit.label ?? bundle} did not finish in ${limit.timeoutMs / 1000} s; killed and counted as a failure.`);
      child.kill('SIGKILL');
      // Settle on exit, not on close: a process it started may still hold the inherited output open.
      child.once('exit', () => finish(1));
    }, limit.timeoutMs);
    // spawnSync returned a null status on launch errors: count the failure
    // and keep running the other test files, rather than dropping coverage.
    child.once('error', () => finish(1));
    // Wait for stdio to close before the next test's heading, as spawnSync did.
    child.once('close', code => finish(code ?? 1));
  });
}
