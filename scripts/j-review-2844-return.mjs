import { build } from 'esbuild';
import { testAliases, testEnvironment } from '../tests/test-config.mjs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const root=process.cwd(),out=mkdtempSync(join(tmpdir(),'j-2844-return-'));
const require=createRequire(import.meta.url),offline=join(out,'offline.cjs');
writeFileSync(offline,`
const {MockAgent,setGlobalDispatcher,fetch}=require(${JSON.stringify(require.resolve('undici'))});
const net=require('node:net'),tls=require('node:tls'),dgram=require('node:dgram'),dns=require('node:dns');
const deny=()=>{const e=new Error('Review socket/network disabled');e.code='REVIEW_NETWORK_DISABLED';throw e;};
net.Socket.prototype.connect=deny;tls.connect=deny;dgram.Socket.prototype.send=deny;dgram.Socket.prototype.connect=deny;
for(const name of ['lookup','resolve','resolve4','resolve6','resolveAny','resolveCname','resolveMx','resolveNs','resolveTxt','reverse']){
 if(typeof dns[name]==='function')dns[name]=deny;if(typeof dns.promises[name]==='function')dns.promises[name]=async()=>deny();
}
const mock=new MockAgent();mock.disableNetConnect();setGlobalDispatcher(mock);
globalThis.fetch=async()=>deny();
(async()=>{
 if(net.Socket.prototype.connect!==deny)throw new Error('Socket guard not installed');
 let socketCode='';try{new net.Socket().connect({host:'127.0.0.1',port:1});}catch(e){socketCode=e.code;}
 if(socketCode!=='REVIEW_NETWORK_DISABLED')throw new Error('Socket control failed');
 const code=await fetch('https://j-review-no-network.invalid/never').then(()=>'',e=>e.cause?.code);
 if(code!=='UND_MOCK_ERR_MOCK_NOT_MATCHED')throw new Error('SDK dispatcher control failed');
 console.log('OFFLINE_CONTROLS socket=blocked dispatcher=blocked; product graph starts now');
 require(process.argv[2]);
})().catch(e=>{console.error(e.message);process.exit(2);});
`);
let failed=0;
const files=process.argv.length>2?process.argv.slice(2):['original:j-2844-settlement.proof.ts','original:j-2844-payday.proof.ts','j-2844-return.proof.ts'];
try{
 for(const entry of files){
  const original=entry.startsWith('original:'),file=original?entry.slice(9):entry,bundle=join(out,'current.cjs');
  const source=original?execFileSync('git',['show','a1e08f4bb630d6d3fa1e1a01aab5a84583b82c82:tests/'+file],{encoding:'utf8'}):null;
  console.log('TEST '+entry);
  await build({...(original?{stdin:{contents:source,resolveDir:join(root,'tests'),sourcefile:file,loader:'ts'}}:{entryPoints:[join(root,'tests',file)]}),bundle:true,platform:'node',format:'cjs',outfile:bundle,logLevel:'error',alias:testAliases(file,root,join(root,'tests'))});
  const result=spawnSync(process.execPath,[offline,bundle],{stdio:'inherit',env:testEnvironment(process.env)});
  console.log('GROUP_EXIT '+entry+' '+result.status);if(result.status!==0)failed++;
  rmSync(bundle,{force:true});
 }
 console.log('FAILED_GROUPS '+failed);process.exitCode=failed?1:0;
}finally{rmSync(out,{recursive:true,force:true});}
