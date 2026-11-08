import ts from 'typescript';import {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';
if(process.argv[2]!=='child'){
 const r=spawnSync(process.execPath,['--max-old-space-size=1024',import.meta.filename,'child'],{timeout:120000,maxBuffer:262144,encoding:'utf8'});const s=(r.stdout??'')+(r.stderr??'');writeFileSync('proofs/v/2633-focal/types.log',s);console.log(s);process.exitCode=r.status??1;
}else{
 const c=ts.readConfigFile('tsconfig.json',ts.sys.readFile),p=ts.parseJsonConfigFileContent(c.config,ts.sys,process.cwd());const roots=['tests/tx4-chile-vat-evidence.test.ts','lib/llc-fixed-costs.ts'];const options={...p.options,incremental:false,noEmit:true};const prog=ts.createProgram(roots,options),ds=ts.getPreEmitDiagnostics(prog);console.log(JSON.stringify({roots,sources:prog.getSourceFiles().length,diagnostics:ds.length,strict:options.strict,target:ts.ScriptTarget[options.target]}));for(const d of ds)console.log(ts.flattenDiagnosticMessageText(d.messageText,'\n'));process.exitCode=ds.length?1:0;
}
