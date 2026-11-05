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

/** @param {string} bundle @param {NodeJS.ProcessEnv} env @param {string} [executable] @returns {Promise<number>} */
export function runBundle(bundle, env, executable = process.execPath) {
  return new Promise(resolve => {
    const child = spawn(executable, [bundle], {stdio: 'inherit', env});
    // spawnSync returned a null status on launch errors: count the failure
    // and keep running the other test files, rather than dropping coverage.
    child.once('error', () => resolve(1));
    // Wait for stdio to close before the next test's heading, as spawnSync did.
    child.once('close', code => resolve(code ?? 1));
  });
}
