import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { testEnvironment } from './test-config.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const product = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '..');
const world = join(here, 'service-counter-admission-world.ts');
const routeWorld = join(here, 'review-c2-service-financial-world.ts');
const temporary = mkdtempSync(join(tmpdir(), 'c2-service-financial-'));
try {
  const outfile = join(temporary, 'proof.cjs');
  await build({ entryPoints: [join(here, 'review-c2-service-financial.test.ts')], outfile,
    bundle: true, platform: 'node', format: 'cjs', alias: {
      '@': product, '@/lib/redis': world, '@/lib/store-allowance': world, '@/lib/traffic': world,
      '@/lib/store': routeWorld, '@/lib/store-request': routeWorld,
      '@/lib/paypal-payouts': routeWorld, '@/lib/affiliates': routeWorld,
    },
  });
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', outfile], {
    cwd: product, encoding: 'utf8', env: testEnvironment(process.env),
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} finally { rmSync(temporary, { recursive: true }); }
