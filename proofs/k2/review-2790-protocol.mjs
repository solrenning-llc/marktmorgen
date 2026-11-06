/** Review-only protocol probe: real canonical matchers and installed Playwright matching. */
import {createRequire} from 'node:module';
import {join,dirname,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import assert from 'node:assert/strict';
const root=resolve(process.argv[2]||process.cwd()),req=createRequire(join(root,'package.json'));
const {urlMatches}=req(join(dirname(req.resolve('playwright-core/package.json')),'lib/utils/isomorphic/urlMatch.js'));
const dir=mkdtempSync(join(root,'.k2-2790-protocol-'));
let checks=0;
try{
 for(const rev of ['68285760c4b4b219b19f1f651247404522f8cf07','368d4fa2141302881e268977735e6b5da7a240ad']){
  const source=execFileSync('git',['show',rev+':tests/e2e/shrink-tone.mjs'],{cwd:root,encoding:'utf8'});
  const path=join(dir,rev+'.mjs');writeFileSync(path,source);
  const {checkShrinkTone}=await import(pathToFileURL(path));
  let matcher;const sentinel=Error('matcher capture');
  try{await checkShrinkTone({root,is(){},browser:{async newContext(){return{async route(m){matcher=m;throw sentinel;}}}}});}catch(error){if(error!==sentinel)throw error;}
  const old=rev.startsWith('682');
  for(const [url,wanted]of [['https://example.com/a',true],['http://example.com/a',true],['blob:https://example.com/synthetic',old],['data:image/png;base64,AAAA',old],['about:blank',false]]){
   assert.equal(urlMatches(undefined,url,matcher),wanted);checks++;console.log(rev.slice(0,8),url.split(':')[0],wanted);
  }
 }
 console.log('Protocol matcher checks',checks);
}finally{rmSync(dir,{recursive:true,force:true});}
