import { build } from 'esbuild';
import { testAliases, testEnvironment } from './test-config.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const outputDir = mkdtempSync(join(tmpdir(), 'g2697-cost-'));
try {
  const filename = 'g2697-cost-boundary.proof.ts';
  const output = join(outputDir, 'proof.cjs');
  await build({entryPoints:[resolve(root,'tests',filename)],bundle:true,platform:'node',format:'cjs',outfile:output,logLevel:'error',alias:testAliases('outreach-counter-admission.test.ts',root,resolve(root,'tests'))});
  const result=spawnSync(process.execPath,[output],{cwd:root,env:testEnvironment(process.env),encoding:'utf8',maxBuffer:4*1024*1024});
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if(result.error)throw result.error;
  process.exitCode=result.status ?? 1;
} finally { rmSync(outputDir,{recursive:true,force:true}); }
