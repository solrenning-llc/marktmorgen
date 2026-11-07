const ts=require('typescript');
const root=process.cwd();
const raw=ts.readConfigFile('tsconfig.json',ts.sys.readFile);if(raw.error)throw Error('config');
const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,root);
const roots=['lib/membership-pause.ts','tests/membership-resume-once.test.ts','tests/membership-pause.test.ts','tests/t-3090-lease.proof.ts','tests/store-data-registry.ts','tests/t-3090-idempotent-lease.proof.ts','tests/r24-plan-resume-idempotent.test.ts','lib/data-families.ts'].map(x=>root+'/'+x);
const options={...parsed.options,incremental:false,noEmit:true};delete options.tsBuildInfoFile;
const host=ts.createCompilerHost(options);
const p=ts.createProgram(roots,options,host), ds=ts.getPreEmitDiagnostics(p);
console.log(JSON.stringify({roots:roots.length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],sourceClosure:p.getSourceFiles().filter(x=>!x.isDeclarationFile).length,diagnostics:ds.map(x=>({code:x.code,file:x.file?.fileName,line:x.file&&x.start!=null?x.file.getLineAndCharacterOfPosition(x.start).line+1:undefined,text:ts.flattenDiagnosticMessageText(x.messageText,' ')})),emit:0}));process.exitCode=ds.length?1:0;
