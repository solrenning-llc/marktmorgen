import {build} from '/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/esbuild/lib/main.js';
import {testAliases} from '../../../tests/test-config.mjs';
import {resolve} from 'node:path';
const file=process.argv[2]??'email-usage-summary.test.ts';
await build({entryPoints:['tests/'+file],bundle:true,platform:'node',format:'cjs',outfile:'proofs/p/stn11-email-usage/current.cjs',alias:testAliases(file,process.cwd(),resolve('tests')),external:['react','react/jsx-runtime','react-dom/server'],nodePaths:['/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules'],jsx:'automatic',logLevel:'error'});
