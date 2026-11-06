import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {runTestFiles, runBundle} from './test-runner.mjs';
import * as runner from './test-runner.mjs';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
}

test('one next bundle overlaps the running test; every process stays serial and every failure counts', async () => {
  const files = ['a', 'b', 'c', 'd'];
  const builds = files.map(() => deferred<string>());
  const runs = files.map(() => deferred<number | null>());
  const events: string[] = [];
  let active = 0;
  const result = runTestFiles({files,
    compile: (file: string) => { events.push('build:' + file); return builds[files.indexOf(file)].promise; },
    run: async (file: string, bundle: string) => {
      assert.equal(bundle, file + '.cjs');
      assert.equal(++active, 1);
      events.push('run:' + file);
      try { return await runs[files.indexOf(file)].promise; }
      finally { active -= 1; }
    }
  });
  assert.deepEqual(events, ['build:a']);
  try {
    for (let i = 0; i < files.length; i += 1) {
      builds[i].resolve(files[i] + '.cjs');
      await setImmediate();
      assert.equal(events.includes('run:' + files[i]), true);
      if (i + 1 < files.length) assert.equal(events.includes('build:' + files[i + 1]), true);
      if (i + 2 < files.length) assert.equal(events.includes('build:' + files[i + 2]), false);
      assert.equal(events.includes('run:' + files[i + 1]), false);
      runs[i].resolve([0, 7, null, 0][i]);
      await setImmediate();
    }
    assert.equal(await result, 2);
    assert.deepEqual(events.filter(e => e.startsWith('run:')), files.map(f => 'run:' + f));
  } finally {
    // A failed assertion also releases the old serial runner, so RED never hangs.
    for (let i = 0; i < files.length; i += 1) {
      builds[i].resolve(files[i] + '.cjs'); runs[i].resolve(0);
    }
    await result;
  }
});

test('a rejected next build is observed immediately but propagates only after the current process closes', async () => {
  const running = deferred<number>();
  const broken = new Error('synthetic compilation failure');
  const events: string[] = [];
  const result = runTestFiles({files: ['a', 'b', 'c'],
    compile: async (file: string) => { events.push('build:' + file); if (file === 'b') throw broken; return file; },
    run: async (file: string) => { events.push('run:' + file); return running.promise; }
  });
  const rejected = assert.rejects(result, error => error === broken);
  await setImmediate();
  try {
    assert.deepEqual(events, ['build:a', 'build:b', 'run:a']);
  } finally { running.resolve(0); }
  await rejected;
  assert.equal(events.includes('build:c'), false);
  assert.equal(events.includes('run:b'), false);
});

test('a process launch failure drains its in-flight build before cleanup and preserves the original error', async () => {
  const nextBuild = deferred<string>();
  const launchError = new Error('synthetic launch failure');
  let settled = false;
  const events: string[] = [];
  const result = runTestFiles({files: ['a', 'b', 'c'],
    compile: async (file: string) => { events.push('build:' + file); return file === 'b' ? nextBuild.promise : file; },
    run: async (file: string) => { events.push('run:' + file); throw launchError; }
  });
  const rejected = assert.rejects(result, error => error === launchError).then(() => { settled = true; });
  await setImmediate();
  try { assert.equal(settled, false); }
  finally { nextBuild.reject(new Error('secondary build failure')); }
  await rejected;
  assert.deepEqual(events, ['build:a', 'build:b', 'run:a']);
});

test('empty inventory does no work', async () => {
  const unexpected = async () => { throw new Error('unexpected work'); };
  assert.equal(await runTestFiles({files: [], compile: unexpected, run: unexpected}), 0);
});

test('real isolated child processes inherit the supplied environment, flush before advancing and keep nonzero exits', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-proof-'));
  try {
    const worker = join(directory, 'worker.cjs'), log = join(directory, 'events.txt');
    writeFileSync(worker, `require('node:fs').appendFileSync(process.env.RUNNER_PROOF_LOG, process.env.RUNNER_PROOF_LABEL + '\\n'); process.exitCode = Number(process.env.RUNNER_PROOF_STATUS);`);
    const files = ['first', 'second', 'third'];
    const failed = await runTestFiles({files, compile: async () => worker,
      run: async (file: string, bundle: string) => {
        if (file !== 'first') assert.equal(readFileSync(log, 'utf8'), files.slice(0, files.indexOf(file)).join('\n') + '\n');
        return runBundle(bundle, {...process.env, RUNNER_PROOF_LOG: log, RUNNER_PROOF_LABEL: file, RUNNER_PROOF_STATUS: file === 'second' ? '7' : '0'});
      }
    });
    assert.equal(failed, 1);
    assert.equal(readFileSync(log, 'utf8'), 'first\nsecond\nthird\n');
    writeFileSync(worker, `process.kill(process.pid, 'SIGTERM');`);
    assert.equal(await runBundle(worker, process.env), 1);
    writeFileSync(worker, 'process.exit(0);');
    // A process that cannot start counted as failure under spawnSync too;
    // it must not prevent the remaining files from running.
    const missingExecutable = join(directory, 'missing-node');
    assert.equal(await runBundle(worker, process.env, missingExecutable), 1);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

// C4-20261106-2550-C5-151: on #2790 and #2820 the verify job sat 47 minutes in tests/backup-run.test.ts with no output
// until the job's own 50-minute cancellation, which names no file and hides every later result. A test process that
// never ends is now killed at a time limit and counted as a failure that names the file.
test('a test process that never ends is killed at its time limit and counted as a failure that names the file', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-timeout-'));
  const worker = join(directory, 'never.cjs'), pidFile = join(directory, 'pid');
  // Never ends, as a test waiting on something that never settles would: an interval keeps it alive.
  writeFileSync(worker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const lines: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const started = Date.now();
    const status = await Promise.race([
      (runBundle as (...args: unknown[]) => Promise<number>)(worker, process.env, process.execPath, {timeoutMs: 500, label: 'never.test.ts'}),
      new Promise<'hung'>(done => { guard = setTimeout(() => done('hung'), 5000); }),
    ]);
    assert.equal(status, 1, 'killed and counted as a failure, not left running');
    assert.ok(Date.now() - started < 5000);
    assert.ok(lines.some(line => line.includes('never.test.ts') && line.includes('0.5 s')), 'the failure names the file and its limit');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), 'the stuck process is gone');
  } finally {
    console.error = write;
    clearTimeout(guard);
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a test process that ends in time is not touched by the limit', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-timeout-'));
  try {
    const worker = join(directory, 'quick.cjs');
    writeFileSync(worker, 'setTimeout(() => { process.exitCode = 0; }, 50);');
    assert.equal(await (runBundle as (...args: unknown[]) => Promise<number>)(worker, process.env, process.execPath, {timeoutMs: 5000, label: 'quick.test.ts'}), 0);
    writeFileSync(worker, 'process.exitCode = 3;');
    assert.equal(await (runBundle as (...args: unknown[]) => Promise<number>)(worker, process.env, process.execPath, {timeoutMs: 5000, label: 'quick.test.ts'}), 3);
  } finally { rmSync(directory, {recursive: true, force: true}); }
});

test('every file in tests/run.mjs runs under the limit, generous over the slowest file measured in CI and well under the job', () => {
  const limit = (runner as Record<string, unknown>).TEST_FILE_TIMEOUT_MS;
  assert.equal(typeof limit, 'number');
  // Slowest file in two full CI verify logs (#2790 job 127891038519, #2721 job 127943351314): contract-admission-ack,
  // 53.9 s and 100.8 s. The verify job itself is cancelled at 50 minutes (.github/workflows/product-checks.yml).
  assert.ok((limit as number) >= 5 * 100_800, 'at least five times the slowest file measured');
  assert.ok((limit as number) <= 15 * 60_000, 'well under the job\'s 50 minutes, so a stuck file is named, not cancelled');
  const run = readFileSync(join(import.meta.dirname ?? __dirname, 'run.mjs'), 'utf8');
  assert.match(run, /runBundle\(bundle, testEnvironment\(process\.env\), process\.execPath, \{timeoutMs: TEST_FILE_TIMEOUT_MS, label: file\}\)/);
});
