
import {createRequire} from 'node:module';
import {resolve,dirname} from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {testAliases,testEnvironment} from './tests/test-config.mjs';
const root=process.cwd(),req=createRequire(resolve('package.json'));
const {build}=req('esbuild'),ts=req('typescript');
const get=(ref,path)=>execFileSync('git',['show',ref+':'+path],{encoding:'utf8'});
const inputs={final:{'lib/plan-refund.ts':get('bbde49fe4752d482cda069e858a88de47280588b','lib/plan-refund.ts'),'tests/plan-refund-read.test.ts':get('bbde49fe4752d482cda069e858a88de47280588b','tests/plan-refund-read.test.ts')},red:get('3fa6667246006a741f5318412c1b5b37b68e3b8a','lib/plan-refund.ts')};
const files=['d2-review-2742-rows.proof.ts','plan-refund-read.test.ts','plan-refund-rules.test.ts','plan-refund-flow.test.ts','plan-refund-route.test.ts','plan-refund-page.test.ts','plan-refund-write.test.ts'];
let failed=false;
const original=readFileSync('lib/plan-refund.ts','utf8');
async function check(mode,file,source){
 const map={...inputs.final,'lib/plan-refund.ts':source};const loaded=[];
 const b=await build({entryPoints:['tests/'+file],bundle:true,platform:'node',format:'cjs',write:false,alias:testAliases(file,root,resolve('tests')),plugins:[{name:'exact-review-snapshot',setup(b){b.onLoad({filter:/.*/},a=>{const key=a.path.slice(root.length+1);if(key in map)loaded.push(key);return key in map?{contents:map[key],loader:a.path.endsWith('.tsx')?'tsx':'ts',resolveDir:dirname(a.path)}:undefined;});}}],logLevel:'error'});
 if(file==='d2-review-2742-rows.proof.ts'&&!loaded.includes('lib/plan-refund.ts'))throw Error('Product overlay was not loaded');if(file==='plan-refund-read.test.ts'&&!loaded.includes('tests/plan-refund-read.test.ts'))throw Error('Reader overlay was not loaded');
 const r=spawnSync(process.execPath,['-'],{input:b.outputFiles[0].text,encoding:'utf8',env:testEnvironment(process.env),maxBuffer:3000000});
 const summary=r.stdout.split(String.fromCharCode(10)).find(line=>line.includes(' checks, '))??r.stdout.slice(-150);
 console.log(JSON.stringify({mode,file,exit:r.status,summary,overlays:loaded}));
 if(mode==='final'&&r.status!==0){failed=true;console.log(r.stdout+r.stderr);}
 if(mode!=='final'&&r.status!==1){failed=true;console.log(r.stdout+r.stderr);}
}
await check('original','d2-review-2742-rows.proof.ts',original);
await check('author-red','plan-refund-read.test.ts',inputs.red);
for(const file of files)await check('final',file,inputs.final['lib/plan-refund.ts']);
const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile);
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);
const host=ts.createCompilerHost({...parsed.options,incremental:false,noEmit:true});
const oldRead=host.readFile.bind(host);
host.readFile=path=>{const key=resolve(path).slice(root.length+1);return key in inputs.final?inputs.final[key]:oldRead(path);};
const p=ts.createProgram(files.map(f=>resolve('tests/'+f)),{...parsed.options,incremental:false,tsBuildInfoFile:undefined,noEmit:true},host);
const diagnostics=ts.getPreEmitDiagnostics(p);
console.log(JSON.stringify({typeFiles:p.getSourceFiles().length,typeDiagnostics:diagnostics.length}));
if(diagnostics.length){failed=true;console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCurrentDirectory:()=>root,getCanonicalFileName:x=>x,getNewLine:()=> '\\n'}));}
const {ESLint}=req('eslint'),lint=new ESLint({cwd:root});
const lr=await lint.lintText(inputs.final['lib/plan-refund.ts'],{filePath:resolve('lib/plan-refund.ts')});
const lt=await lint.lintText(inputs.final['tests/plan-refund-read.test.ts'],{filePath:resolve('tests/plan-refund-read.test.ts')});
const errors=[...lr,...lt].reduce((n,x)=>n+x.errorCount,0);
console.log(JSON.stringify({lintErrors:errors,lintWarnings:[...lr,...lt].reduce((n,x)=>n+x.warningCount,0)}));
if(errors){failed=true;console.log(JSON.stringify([...lr,...lt]));}
process.exitCode=failed?1:0;
