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
async function gone(pid: number, ms = 3000): Promise<boolean> {
  const until = Date.now() + ms;
  while (running(pid) && Date.now() < until) await new Promise(done => setTimeout(done, 10));
  return !running(pid);
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
