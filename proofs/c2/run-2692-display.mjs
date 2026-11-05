import {build} from 'esbuild';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const root=process.cwd(),here=join(root,'tests');
const result=await build({stdin:{contents:readFileSync(join(here,'c2-2692-allowance-display.proof.ts'),'utf8'),resolveDir:here,loader:'ts'},bundle:true,platform:'node',format:'cjs',write:false,alias:testAliases('store-allowance-ack.test.ts',root,here),logLevel:'silent'});
const run=spawnSync(process.execPath,['-'],{input:result.outputFiles[0].text,cwd:root,env:testEnvironment(process.env),encoding:'utf8',maxBuffer:3000000});
process.stdout.write(run.stdout);if(run.status)process.stderr.write(run.stderr);if(run.error)throw run.error;process.exitCode=run.status??1;
