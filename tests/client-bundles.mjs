import { realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

async function files(dir) {
 const result=[];
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const name=join(dir,entry.name);
  if(entry.isDirectory())result.push(...await files(name));
  else if(/\.tsx?$/.test(entry.name))result.push(name);
 }
 return result;
}
/** Bundle actual client graphs without server stubs or Node polyfills. */
export async function checkClientBundles(root) {
 const entries=[];
 for(const file of [...await files(join(root,'app')),...await files(join(root,'components'))]){
  if(/^\s*["']use client["'];/m.test(await readFile(file,'utf8')))entries.push(file);
 }
 const failures=[];let next=0;
 await Promise.all(Array.from({length:4},async()=>{
  while(next<entries.length){const file=entries[next++];
   try{await build({entryPoints:[file],bundle:true,write:false,platform:'browser',format:'esm',nodePaths:[join(root,'node_modules')],external:['react','react/*','next/*'],tsconfig:join(root,'tsconfig.json'),logLevel:'silent'});}
   catch(error){failures.push({file:relative(root,file),errors:error.errors?.map(item=>item.text)??[String(error)]});}
  }
 }));
 failures.push(...await checkKeptOut(root));
 failures.push(...await checkServerReach(root));
 return {total:entries.length,failed:failures.length,failures};
}
/** Server-sized data a buyer's page must never carry: the store assistant's chat only reads two constants of its rules, never the look-alike table (lib/confusables-latin.ts). */
/* The public menu gets the plans' state from the server (components/site-nav-server.tsx): lib/opening.ts reaches every gate and margin review, about 90 KB a visitor never needs. */
const KEPT_OUT=[{entry:'components/store-assistant.tsx',module:'lib/confusables-latin.ts'},{entry:'components/site-nav.tsx',module:'lib/opening.ts'}];
export async function checkKeptOut(root) {
 const failures=[];
 for(const {entry,module} of KEPT_OUT){
  const result=await build({entryPoints:[join(root,entry)],absWorkingDir:root,bundle:true,write:false,metafile:true,platform:'browser',format:'esm',nodePaths:[join(root,'node_modules')],external:['react','react/*','next/*'],tsconfig:join(root,'tsconfig.json'),logLevel:'silent'});
  const bytes=Object.values(result.metafile.outputs).reduce((sum,output)=>sum+(output.inputs[module]?.bytesInOutput??0),0);
  if(bytes)failures.push({file:entry,errors:[`carries ${bytes} bytes of ${module}`]});
 }
 return failures;
}
/**
 * The client components a server page reaches, through any server module, are all shipped to its visitor, used
 * or not. The home page once reached the store's cart and checkout boxes through lib/demo-seed.ts and an email
 * helper (lib/product-pill.ts now holds that helper): about 27 KB compressed on every first visit.
 */
const SERVER_REACH=[{entry:'app/page.tsx',clients:['components/home-claim.tsx','components/home-examples.tsx']}];
const USE_CLIENT=/^\s*(\/\*[\s\S]*?\*\/\s*|\/\/.*\n\s*)*["']use client["']/;
export async function checkServerReach(root) {
 const failures=[];
 for(const {entry,clients} of SERVER_REACH){
  const result=await build({entryPoints:[join(root,entry)],absWorkingDir:root,bundle:true,write:false,metafile:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},jsx:'automatic',tsconfig:join(root,'tsconfig.json'),logLevel:'silent'});
  const inputs=result.metafile.inputs,queue=[entry],seen=new Set(queue),reached=[];
  while(queue.length){
   const file=queue.shift();
   if(file!==entry&&USE_CLIENT.test(await readFile(join(root,file),'utf8'))){reached.push(file);continue;}
   for(const item of inputs[file]?.imports??[])if(!item.external&&inputs[item.path]&&!seen.has(item.path)){seen.add(item.path);queue.push(item.path);}
  }
  const extra=reached.filter(file=>!clients.includes(file)),missing=clients.filter(file=>!reached.includes(file));
  if(extra.length||missing.length)failures.push({file:entry,errors:[`reaches client components ${JSON.stringify(reached.sort())}, expected ${JSON.stringify(clients)}`]});
 }
 return failures;
}
/** Whether node was asked to run this file: compared as real paths, so a link matches and an import does not. */
function isProgram(){
 try{return typeof process!=='undefined'&&Boolean(process.argv[1])&&realpathSync(fileURLToPath(import.meta.url))===realpathSync(process.argv[1]);}
 catch{return false;}
}
if(isProgram()){
 const result=await checkClientBundles(resolve(dirname(fileURLToPath(import.meta.url)),'..'));
 console.log(JSON.stringify(result,null,2));
 if(result.failed)process.exitCode=1;
}
