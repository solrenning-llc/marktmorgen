import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=process.env.TASK_TEST_ROOT;
const before='e32332853c8edd8bd72da6c27486d549fdd71cb7';
const after='2f466e124f09f633982b02b8914060a92a62fcd9';
const path='tests/tx4-singapore-gst-evidence.test.ts';
const git=(...args)=>execFileSync('git',args,{cwd:root,encoding:'utf8'});
assert.equal(git('show',before+':'+path),git('show',after+':'+path));
assert.notEqual(spawnSync('git',['cat-file','-e',before+':docs/tx4-singapore-gst-evidence.md'],{cwd:root}).status,0);
assert.equal(git('diff','--name-only',before,after).trim(),'docs/tx4-singapore-gst-evidence.md');
const {build}=await import(root+'/node_modules/esbuild/lib/main.js');
const {testAliases,testEnvironment}=await import(root+'/tests/test-config.mjs');
const out=mkdtempSync(tmpdir()+'/i2-singapore-red-');
try {
 await build({entryPoints:[root+'/'+path],bundle:true,platform:'node',format:'cjs',outfile:out+'/test.cjs',logLevel:'error',alias:testAliases(path.slice(6),root,root+'/tests')});
 const result=spawnSync(process.execPath,["--test-reporter=tap",out+'/test.cjs'],{cwd:out,env:testEnvironment(process.env),encoding:'utf8'});
 const log=result.stdout+result.stderr; process.stdout.write(log);
 assert.equal(result.status,1); assert.match(log,/# fail 4/); assert.equal((log.match(/code: 'ENOENT'/g)||[]).length,4);
 console.log('Verified identical RED test with the predecessor missing-document input: four ENOENT failures.');
} finally {rmSync(out,{recursive:true,force:true});}
