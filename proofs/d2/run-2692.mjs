import { build } from 'esbuild';
import { spawnSync, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { testAliases, testEnvironment } from '../../tests/test-config.mjs';

const mode = process.argv[2] ?? 'final';
const files = process.argv.slice(3);
if (!files.length) throw Error('Pass test filenames after final or red');
for (const file of files) {
  const root = process.cwd();
  const red = mode === 'red';
  const plugins = red ? [{ name: 'exact-red-library-sources', setup(build) {
    build.onLoad({ filter: /\/lib\/(store-allowance|plan-refund-flow)\.ts$/ }, args => ({
      contents: execFileSync('git', ['show', '6f7eb8f4a6860ca1c90e908ee18d4b174e646638:' + args.path.slice(root.length + 1)], { encoding: 'utf8' }),
      loader: 'ts', resolveDir: resolve(args.path, '..'),
    }));
  } }] : [];
  const b = await build({ entryPoints: ['tests/' + file], bundle: true, platform: 'node', format: 'cjs', write: false,
    alias: testAliases(file, root, resolve('tests')), plugins, logLevel: 'error' });
  const run = spawnSync(process.execPath, ['-'], { input: b.outputFiles[0].text, encoding: 'utf8', env: testEnvironment(process.env), maxBuffer: 3_000_000 });
  console.log(mode + ' ' + file + ' exit=' + run.status);
  console.log(run.stdout);
  if (run.error) throw run.error;
  if (run.status !== 0) { console.error(run.stderr.slice(-12_000)); process.exitCode = 1; }
}
