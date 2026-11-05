import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {runTestFiles} from './test-runner.mjs';

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
