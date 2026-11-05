import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
const root=process.env.TASK_REPO_ROOT??process.cwd();
const sha=process.env.TASK_SOURCE_SHA??'1a855ddfdf73c6571633003a18571790ad92745b';
const read=path=>execFileSync('git',['show',sha+':'+path],{cwd:root,encoding:'utf8'});
const code=read('scripts/reservation-check.mjs');
const {conflicts}=await import('data:text/javascript;base64,'+Buffer.from(code).toString('base64'));
const text=read('docs/reservations.md');
const held=read('docs/reservations/codex.md');
const branch='claude3/i2-read-only-reservation-probe';
const check=(file,own=held)=>conflicts({text,branch,changed:[file],agentFiles:[{path:'docs/reservations/codex.md',text:own}]}).found;
test('positive control: the first real reserved path is protected',()=>{
 assert.equal(check('tests/mail-revenue-proto.test.ts').some(r=>r.file==='tests/mail-revenue-proto.test.ts'),true);
});
test('a later real reservation must also block a foreign agent',()=>{
 assert.match(held,/`lib\/learn\.ts`/);
 assert.equal(check('lib/learn.ts').some(r=>r.file==='lib/learn.ts'),true);
});
test('isolated input control: remove only table-internal blank lines and the same later reservation blocks',()=>{
 const compact=held.replace(/(\|[^\n]*\n)\s*\n(?=\|)/g,'$1');
 assert.equal(check('lib/learn.ts',compact).some(r=>r.file==='lib/learn.ts'),true);
});
