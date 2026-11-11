import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {pathToFileURL} from 'node:url';
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
  const run = readFileSync('tests/run.mjs', 'utf8');
  // Rule 23 (C4-20261106-2600-C5-152): the compilation of each file is under the same limit, and a timeout's line says
  // whether the next compilation had settled; the per-file limit itself is unchanged.
  assert.match(run, /compileTimeoutMs: TEST_FILE_TIMEOUT_MS/);
  assert.match(run, /runBundle\(bundle, testEnvironment\(process\.env\), process\.execPath, \{timeoutMs: TEST_FILE_TIMEOUT_MS, label: file, diagnose: \(\) => `next compile \$\{next\(\)\}`\}\)/);
});

// C4-20261106-2600-C5-152: in the four CI cases backup-run printed "96 checks, all passing." and the next file's heading
// never came, so either the child hung inside its exit (a) or the runner did not move on: the next compilation never
// settled, or the child was never reaped (b). The limit must catch both, and say which before it kills anything.
test('a timeout first prints what /proc and the runner say: the file, whether exit came, the process state, each thread\'s wchan and the next compilation', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-timeout-'));
  const worker = join(directory, 'never.cjs'), pidFile = join(directory, 'pid');
  writeFileSync(worker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const lines: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    let procReadable = false;
    const watch = setInterval(() => {
      try { procReadable ||= existsSync(`/proc/${Number(readFileSync(pidFile, 'utf8'))}/status`); } catch { /* not written yet */ }
    }, 20);
    const status = await Promise.race([
      (runBundle as (...args: unknown[]) => Promise<number>)(worker, process.env, process.execPath, {timeoutMs: 500, label: 'never.test.ts', diagnose: () => 'next compile resolved'}),
      new Promise<'hung'>(done => { guard = setTimeout(() => done('hung'), 5000); }),
    ]);
    clearInterval(watch);
    assert.equal(status, 1);
    const line = lines.find(text => text.includes('TIMEOUT')) ?? '';
    assert.match(line, /never\.test\.ts/);
    assert.match(line, /exit not seen/);
    // Rule 23 (Codex G on #2826, 5805110853): where /proc shows the process (Linux CI) the line has its State and each
    // thread's wchan; where the child's /proc entry cannot be read (G's sandbox: ENOENT while /proc/self exists) the
    // line says exactly proc=unreadable. Which one is decided by what this environment showed while the file ran.
    if (procReadable) {
      assert.match(line, /state=[A-Z]/, 'State from /proc/<pid>/status');
      assert.match(line, /wchan=\d+:/, 'each thread\'s wchan from /proc/<pid>/task/*/wchan');
    } else assert.match(line, /proc=unreadable/);
    assert.match(line, /next compile resolved/);
  } finally {
    console.error = write;
    clearTimeout(guard);
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a next compilation that never settles fails naming the file at the limit, and the runner does not hang on it', async () => {
  const never = new Promise<string>(() => {});
  let guard: ReturnType<typeof setTimeout> | undefined;
  const runs: string[] = [];
  const outcome = await Promise.race([
    (runTestFiles as (options: unknown) => Promise<number>)({files: ['a.test.ts', 'b.test.ts'], compileTimeoutMs: 300,
      compile: async (file: string) => file === 'b.test.ts' ? never : file,
      run: async (file: string) => { runs.push(file); return 0; },
    }).then(() => 'resolved', (error: Error) => error.message),
    new Promise<string>(done => { guard = setTimeout(() => done('hung'), 5000); }),
  ]);
  clearTimeout(guard);
  assert.deepEqual(runs, ['a.test.ts']);
  assert.match(outcome, /b\.test\.ts/, 'names the file whose compilation did not finish');
  assert.match(outcome, /TIMEOUT/);
});

test('a run is told whether the next file\'s compilation has settled, and that there is none after the last', async () => {
  const seen: string[] = [];
  await (runTestFiles as (options: unknown) => Promise<number>)({files: ['a', 'b'],
    compile: async (file: string) => file,
    run: async (file: string, _bundle: string, next: () => string) => { await setImmediate(); seen.push(file + ':' + next()); return 0; },
  });
  assert.deepEqual(seen, ['a:resolved', 'b:none']);
});

// Codex G on #2826 (5805110853, MEDIUM; proofs 285f70bb and 43c69845, kept here): killing only the direct worker left a
// process it had started alive, still holding the inherited output, overlapping the next test and keeping whoever reads
// the runner's pipes waiting after the runner itself had finished. A timed-out file's whole process tree goes.
// Running: signal 0 reaches it and it is not a zombie. A process that died after its parent is reparented to PID 1,
// which may never reap it (this container's init does not): dead, holding nothing open, yet signal 0 still reaches it.
const running = (pid: number) => {
  try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; }
  try { return !/^State:\s*Z/m.test(readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return true; }
};
async function gone(pid: number, ms = 3000, isRunning: (pid: number) => boolean = running): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!isRunning(pid)) return true;
    await new Promise(done => setTimeout(done, 10));
  }
  return !isRunning(pid);
}

test('a timed-out file\'s descendants in its process group go with it, a throwing diagnose still counts the failure, and the next file runs', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-tree-'));
  const owned: number[] = [];
  try {
    const grand = join(directory, 'grand.cjs'), parent = join(directory, 'parent.cjs'), grandPid = join(directory, 'grand.pid'), parentPid = join(directory, 'parent.pid');
    writeFileSync(grand, `require('node:fs').writeFileSync(${JSON.stringify(grandPid)}, String(process.pid)); setInterval(() => {}, 1000); if (process.send) process.send('ready');`);
    writeFileSync(parent, `require('node:fs').writeFileSync(${JSON.stringify(parentPid)}, String(process.pid)); require('node:child_process').fork(${JSON.stringify(grand)}, [], {stdio: ['inherit', 'inherit', 'inherit', 'ipc']}); setInterval(() => {}, 1000);`);
    const write = console.error;
    console.error = () => {};
    let status: number;
    try {
      // The descendant is up before the limit: the parent's interval keeps it waiting, and the grandchild writes its pid.
      status = await (runBundle as (...args: unknown[]) => Promise<number>)(parent, process.env, process.execPath, {timeoutMs: 1200, label: 'descendant-stuck.test.ts', diagnose: () => { throw new Error('synthetic diagnostic failure'); }});
    } finally { console.error = write; }
    const pp = Number(readFileSync(parentPid, 'utf8')), gp = Number(readFileSync(grandPid, 'utf8'));
    owned.push(pp, gp);
    assert.equal(status, 1, 'a timeout stays a failure even when diagnose throws');
    assert.equal(await gone(pp), true, 'the direct worker is gone');
    assert.equal(await gone(gp, 500), true, 'no descendant of the timed-out file survives');
    const quick = join(directory, 'quick.cjs');
    writeFileSync(quick, 'process.exitCode = 0;');
    assert.equal(await (runBundle as (...args: unknown[]) => Promise<number>)(quick, process.env, process.execPath, {timeoutMs: 1200, label: 'quick.test.ts'}), 0);
  } finally {
    for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a confirmed terminal observation is retained instead of probing the numeric PID again', async () => {
  let observations = 0;
  assert.equal(await gone(123456, 500, () => {
    observations += 1;
    // A confirmed zombie/absent PID can be followed by an unreadable /proc entry or a reused PID.
    return observations > 1;
  }), true, 'the original descendant was confirmed gone');
  assert.equal(observations, 1, 'no second observation can reverse a confirmed terminal state');
});

test('an unconfirmed live or unreadable process is not reported gone at the deadline', async () => {
  // running() deliberately returns true when /proc cannot be read. Keep that conservative result.
  assert.equal(await gone(123456, 0, () => true), false);
});

test('once the runner has finished, nothing it started holds its output open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'runner-output-'));
  const pidFile = join(root, 'grand.pid');
  let owned = 0;
  let executor: ReturnType<typeof spawn> | undefined;
  let guard: ReturnType<typeof setTimeout> | undefined;
  try {
    const grand = join(root, 'grand.cjs'), worker = join(root, 'worker.cjs'), driver = join(root, 'driver.mjs');
    writeFileSync(grand, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000); process.send('ready');`);
    writeFileSync(worker, `require('node:child_process').fork(${JSON.stringify(grand)}, [], {stdio: ['inherit', 'inherit', 'inherit', 'ipc']}); setInterval(() => {}, 1000);`);
    writeFileSync(driver, `import {runBundle} from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'tests/test-runner.mjs')).href)}; const status = await runBundle(${JSON.stringify(worker)}, process.env, process.execPath, {timeoutMs: 1200, label: 'worker.test.ts'}); console.log('DRIVER_FINISHED', status); process.exit(status === 1 ? 0 : 2);`);
    executor = spawn(process.execPath, [driver], {stdio: ['ignore', 'pipe', 'pipe']});
    executor.stdout?.resume();
    executor.stderr?.resume();
    const closed = new Promise<'closed'>(done => executor!.once('close', () => done('closed')));
    const exit = await Promise.race([
      new Promise<{code: number | null, signal: NodeJS.Signals | null}>(done => executor!.once('exit', (code, signal) => done({code, signal}))),
      new Promise<'guard'>(done => { guard = setTimeout(() => done('guard'), 8000); }),
    ]);
    clearTimeout(guard);
    try { owned = Number(readFileSync(pidFile, 'utf8')); } catch { /* never started */ }
    assert.deepEqual(exit, {code: 0, signal: null}, 'the runner counted the timeout and finished');
    const released = await Promise.race([closed, new Promise<'open'>(done => { guard = setTimeout(() => done('open'), 1500); })]);
    clearTimeout(guard);
    assert.equal(released, 'closed', 'its output closes: no descendant holds it');
    if (owned) assert.equal(running(owned), false, 'and the descendant is gone');
  } finally {
    clearTimeout(guard);
    if (owned) { try { process.kill(owned, 'SIGKILL'); } catch { /* already gone */ } }
    if (executor && executor.exitCode === null) { try { executor.kill('SIGKILL'); } catch { /* already gone */ } }
    rmSync(root, {recursive: true, force: true});
  }
});

// Codex G on #2826 (5805374280, LOW): the runner reaches a test file's own process group, not a process the file starts
// in a group of its own (detached: true, or setsid), which only the system's own tools could follow. It says so, and it
// holds what it says: no test file it runs starts one.
test('a timeout says the file\'s process group was ended, and no test file starts a process outside its group', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-group-'));
  const worker = join(directory, 'never.cjs'), pidFile = join(directory, 'pid');
  writeFileSync(worker, `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`);
  const lines: string[] = [];
  const write = console.error;
  console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
  try {
    assert.equal(await (runBundle as (...args: unknown[]) => Promise<number>)(worker, process.env, process.execPath, {timeoutMs: 400, label: 'never.test.ts'}), 1);
  } finally {
    console.error = write;
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    rmSync(directory, {recursive: true, force: true});
  }
  const line = lines.find(text => text.includes('TIMEOUT')) ?? '';
  assert.match(line, /killed with its process group/);
  assert.doesNotMatch(line, /process tree/);
  const files = readdirSync('tests').filter(name => name.endsWith('.test.ts') && name !== 'test-runner.test.ts');
  const starting = files.filter(name => /detached\s*:\s*true|\bsetsid\b/.test(readFileSync(join('tests', name), 'utf8')));
  assert.deepEqual(starting, [], 'no test file starts a process in a group of its own');
});

// Claude 7 (CI team): the verify job's "Behavior regressions" step ran ~2,100 files one at a time (about 1,161 s on a
// 4-vCPU runner). TEST_CONCURRENCY=N runs N at once, each file still alone in its own process and process group,
// under the same limit, diagnostics and cleanup; its output is kept and printed whole, in file order; the files of
// SERIAL_TEST_FILES run after, one at a time. Unset, the run is exactly the serial one above.
type Write = (stream: 'out' | 'err', data: string | Uint8Array) => void;
type Options = {files: string[], compile: (file: string) => Promise<unknown>, run: (file: string, bundle: string, next: () => string) => Promise<number | null>,
  compileTimeoutMs?: number, concurrency?: number, serial?: readonly string[], write?: Write};
const runFiles = runTestFiles as unknown as (options: Options) => Promise<number>;
const say = (runner as unknown as {say: (text: string) => void}).say;
const text = (chunks: Array<[string, string | Uint8Array]>) => chunks.map(([stream, data]) => `${stream}:${typeof data === 'string' ? data : Buffer.from(data).toString('utf8')}`).join('');

test('TEST_CONCURRENCY: unset or empty is 1, a whole number from 1 to 32 is taken, anything else stops the run', () => {
  const parse = (runner as unknown as {testConcurrency: (value: string | undefined) => number}).testConcurrency;
  assert.equal(parse(undefined), 1);
  assert.equal(parse(''), 1);
  assert.equal(parse(' 3 '), 3);
  assert.equal(parse('1'), 1);
  assert.equal(parse('32'), 32);
  for (const wrong of ['0', '33', '2.5', '-1', 'four', '4x', '1e1', '0x4', 'Infinity']) assert.throws(() => parse(wrong), /TEST_CONCURRENCY/, wrong);
});

test('side by side: never more than N files at once, every file runs once, every failure counts, and the files to run alone run after, alone', async () => {
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const status: Record<string, number | null> = {a: 0, b: 7, c: 0, d: null, e: 0, f: 0, g: 1, h: 0};
  let active = 0, most = 0;
  const started: string[] = [];
  const failed = await runFiles({files, concurrency: 3, serial: ['c', 'g', 'not-in-files'], write: () => {},
    compile: async file => `${file}.cjs`,
    run: async (file, bundle) => {
      assert.equal(bundle, `${file}.cjs`);
      active += 1; most = Math.max(most, active);
      started.push(file);
      if (file === 'c' || file === 'g') assert.equal(active, 1, `${file} runs alone`);
      // Uneven lengths, so later files finish before earlier ones.
      await new Promise(done => setTimeout(done, (files.length - files.indexOf(file)) * 5));
      active -= 1;
      return status[file];
    }});
  assert.equal(failed, 3, 'b (7), d (null) and g (1)');
  assert.equal(most, 3);
  assert.deepEqual([...started].sort(), files);
  assert.deepEqual(started.slice(-2), ['c', 'g'], 'the files to run alone come last, in file order');
});

test('side by side: each file\'s output is printed whole and in file order, whichever finishes first', async () => {
  const files = ['a', 'b', 'c', 'd'];
  const out: Array<[string, string | Uint8Array]> = [];
  const gates = Object.fromEntries(files.map(file => [file, deferred<void>()]));
  const result = runFiles({files, concurrency: 4, write: (stream, data) => { out.push([stream, data]); },
    compile: async file => file,
    run: async file => {
      say(`=== ${file} ===`);
      await gates[file].promise;
      say(`${file} done`);
      return 0;
    }});
  await setImmediate();
  for (const file of ['d', 'c', 'b']) { gates[file].resolve(); await setImmediate(); }
  assert.deepEqual(out, [], 'nothing printed while the first file still runs');
  gates.a.resolve();
  assert.equal(await result, 0);
  assert.equal(text(out), files.map(file => `out:=== ${file} ===\nout:${file} done\n`).join(''));
});

test('side by side, real processes: stdout and stderr kept per file, nonzero exits counted, and a descendant left holding the output does not hold the run', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-side-'));
  const owned: number[] = [];
  try {
    const grandPid = join(directory, 'grand.pid');
    const grand = join(directory, 'grand.cjs');
    writeFileSync(grand, `require('node:fs').writeFileSync(${JSON.stringify(grandPid)}, String(process.pid)); setInterval(() => {}, 1000); process.send('ready');`);
    const workers: Record<string, string> = {
      // Writes on both streams, several times, with waits between, so the files really overlap.
      'one.test.ts': `let n = 0; const t = setInterval(() => { console.log('one out ' + n); console.error('one err ' + n); if (++n === 3) clearInterval(t); }, 20);`,
      'two.test.ts': `console.log('two out'); setTimeout(() => { console.error('two err'); process.exitCode = 5; }, 30);`,
      // Leaves a process of its group holding the inherited pipes, then ends: the runner must not wait for it.
      'three.test.ts': `const c = require('node:child_process').fork(${JSON.stringify(grand)}, [], {stdio: ['inherit', 'inherit', 'inherit', 'ipc']}); c.once('message', () => { console.log('three out'); c.disconnect(); c.unref(); });`,
    };
    for (const [file, code] of Object.entries(workers)) writeFileSync(join(directory, file + '.cjs'), code);
    const out: Array<[string, string | Uint8Array]> = [];
    const started = Date.now();
    const failed = await runFiles({files: Object.keys(workers), concurrency: 3, write: (stream, data) => { out.push([stream, data]); },
      compile: async file => join(directory, file + '.cjs'),
      run: async (file, bundle, next) => {
        say(`=== ${file} ===`);
        return (runBundle as (...args: unknown[]) => Promise<number>)(bundle, process.env, process.execPath, {timeoutMs: 20_000, label: file, diagnose: () => `next compile ${next()}`});
      }});
    try { owned.push(Number(readFileSync(grandPid, 'utf8'))); } catch { /* never started */ }
    assert.equal(failed, 1, 'two exited with 5');
    assert.ok(Date.now() - started < 15_000, 'the descendant left behind did not hold the run to its limit');
    const all = text(out);
    const one = all.indexOf('out:=== one.test.ts'), two = all.indexOf('out:=== two.test.ts'), three = all.indexOf('out:=== three.test.ts');
    assert.ok(one === 0 && one < two && two < three, all);
    const oneText = all.slice(one, two);
    for (let n = 0; n < 3; n += 1) { assert.match(oneText, new RegExp(`out:one out ${n}\\n`)); assert.match(oneText, new RegExp(`err:one err ${n}\\n`)); }
    assert.match(all.slice(two, three), /out:two out\n[\s\S]*err:two err\n/);
    assert.match(all.slice(three), /out:three out\n/);
    if (owned[0]) assert.equal(await gone(owned[0], 2000), true, 'the descendant ended with its file');
  } finally {
    for (const pid of owned) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
    rmSync(directory, {recursive: true, force: true});
  }
});

test('side by side: a timeout is said inside that file\'s own output, ends its group and counts as a failure; the others still pass', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'runner-side-timeout-'));
  const pidFile = join(directory, 'pid');
  try {
    writeFileSync(join(directory, 'never.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); console.log('never started'); setInterval(() => {}, 1000);`);
    writeFileSync(join(directory, 'quick.cjs'), `console.log('quick done');`);
    const out: Array<[string, string | Uint8Array]> = [];
    const lines: string[] = [];
    const write = console.error;
    console.error = (...args: unknown[]) => { lines.push(args.map(String).join(' ')); };
    let failed: number;
    try {
      failed = await runFiles({files: ['never.test.ts', 'quick.test.ts'], concurrency: 2, write: (stream, data) => { out.push([stream, data]); },
        compile: async file => join(directory, file.replace('.test.ts', '.cjs')),
        run: async (file, bundle, next) => (runBundle as (...args: unknown[]) => Promise<number>)(bundle, process.env, process.execPath, {timeoutMs: 600, label: file, diagnose: () => `next compile ${next()}`})});
    } finally { console.error = write; }
    assert.equal(failed, 1);
    assert.deepEqual(lines, [], 'nothing goes around the kept output');
    assert.match(text(out), /^out:never started\nerr:TIMEOUT: never\.test\.ts did not finish in 0\.6 s; exit not seen; [^\n]*next compile resolved; killed with its process group and counted as a failure\.\nout:quick done\n$/);
    assert.equal(await gone(Number(readFileSync(pidFile, 'utf8'))), true);
  } finally {
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    rmSync(directory, {recursive: true, force: true});
  }
});

test('side by side: a failed compilation starts no further file, lets the running ones finish and print in order, then is thrown', async () => {
  const broken = new Error('synthetic compilation failure');
  const out: Array<[string, string | Uint8Array]> = [];
  const runs: string[] = [];
  const slow = deferred<number>();
  const result = runFiles({files: ['a', 'b', 'c', 'd', 'e', 'f'], concurrency: 2, serial: ['f'], write: (stream, data) => { out.push([stream, data]); },
    compile: async file => { if (file === 'c') throw broken; return file; },
    run: async file => { runs.push(file); say(`ran ${file}`); return file === 'a' ? slow.promise : 0; }});
  const rejected = assert.rejects(result, error => error === broken);
  await setImmediate();
  await setImmediate();
  assert.deepEqual(out, [], 'a still runs, so nothing is printed yet');
  slow.resolve(0);
  await rejected;
  assert.deepEqual(runs, ['a', 'b'], 'nothing after the failed file starts, the files to run alone included');
  assert.equal(text(out), 'out:ran a\nout:ran b\n');
});

test('side by side: a compilation that never settles fails naming the file at the limit', async () => {
  const outcome = await runFiles({files: ['a.test.ts', 'b.test.ts'], concurrency: 2, compileTimeoutMs: 300, write: () => {},
    compile: async file => file === 'b.test.ts' ? new Promise(() => {}) : file,
    run: async () => 0}).then(() => 'resolved', (error: Error) => error.message);
  assert.match(outcome, /TIMEOUT: compiling b\.test\.ts/);
});

test('tests/run.mjs reads TEST_CONCURRENCY, prints each heading with the file\'s output, and every file to run alone exists', () => {
  const run = readFileSync('tests/run.mjs', 'utf8');
  assert.match(run, /const concurrency = testConcurrency\(process\.env\.TEST_CONCURRENCY\);/);
  assert.match(run, /runTestFiles\(\{files, concurrency, serial: SERIAL_TEST_FILES, compileTimeoutMs: TEST_FILE_TIMEOUT_MS,/);
  assert.match(run, /say\(`\\n=== \$\{file\} ===`\);/);
  assert.doesNotMatch(run, /console\.log\(`\\n=== /);
  const serial = (runner as unknown as {SERIAL_TEST_FILES: readonly string[]}).SERIAL_TEST_FILES;
  assert.ok(Object.isFrozen(serial));
  const present = new Set(readdirSync('tests'));
  assert.deepEqual(serial.filter(file => !file.endsWith('.test.ts') || !present.has(file)), [], 'no stale name');
  assert.equal(new Set(serial).size, serial.length);
  // The runner's own file always runs alone: its children and guards are timed.
  assert.ok(serial.includes('test-runner.test.ts'));
});
