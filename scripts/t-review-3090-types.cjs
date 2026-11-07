const ts=require('typescript');
const root=process.cwd();
const raw=ts.readConfigFile('tsconfig.json',ts.sys.readFile);if(raw.error)throw Error('config');
const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,root);
const roots=['lib/membership-pause.ts','tests/membership-resume-once.test.ts','tests/membership-pause.test.ts','tests/t-3090-lease.proof.ts','tests/store-data-registry.ts'].map(x=>root+'/'+x);
const options={...parsed.options,incremental:false,noEmit:true};delete options.tsBuildInfoFile;
const host=ts.createCompilerHost(options);
if(process.argv[2]==='old'){
const old=require('node:child_process').execFileSync('git',['show','1d7cbe8dda5d35d049c699def9919b89a6376ef5:lib/membership-pause.ts'],{encoding:'utf8'});
const read=host.readFile;host.readFile=(name)=>name===root+'/lib/membership-pause.ts'?old:read(name);
}
const p=ts.createProgram(roots,options,host), ds=ts.getPreEmitDiagnostics(p);
console.log(JSON.stringify({roots:roots.length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],sourceClosure:p.getSourceFiles().filter(x=>!x.isDeclarationFile).length,diagnostics:ds.map(x=>({code:x.code,file:x.file?.fileName,line:x.file&&x.start!=null?x.file.getLineAndCharacterOfPosition(x.start).line+1:undefined,text:ts.flattenDiagnosticMessageText(x.messageText,' ')})),emit:0}));process.exitCode=ds.length?1:0;
