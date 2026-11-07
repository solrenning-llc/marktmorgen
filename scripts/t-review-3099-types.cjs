const ts=require('typescript');
const root=process.cwd();
const raw=ts.readConfigFile('tsconfig.json',ts.sys.readFile);if(raw.error)throw Error('config');
const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,root);
const roots=['tests/closed-store-unknown.test.ts','tests/t-3099-backoff.proof.ts','lib/redis-memory.ts'].map(x=>root+'/'+x);
const options={...parsed.options,incremental:false,noEmit:true};delete options.tsBuildInfoFile;
const p=ts.createProgram(roots,options), ds=ts.getPreEmitDiagnostics(p);
console.log(JSON.stringify({roots:roots.length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],sourceClosure:p.getSourceFiles().filter(x=>!x.isDeclarationFile).length,diagnostics:ds.map(x=>({code:x.code,file:x.file?.fileName,line:x.file&&x.start!=null?x.file.getLineAndCharacterOfPosition(x.start).line+1:undefined,text:ts.flattenDiagnosticMessageText(x.messageText,' ')})),emit:0}));process.exitCode=ds.length?1:0;
