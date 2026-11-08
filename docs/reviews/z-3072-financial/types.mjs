import ts from 'typescript';
const roots=['lib/delivery.ts','app/api/cron/usage/route.ts','tests/usage-told-sent-only.test.ts','tests/z-3072-author19.proof.ts','tests/z-3072-owner-text.proof.ts'];
const read=ts.readConfigFile('tsconfig.json',ts.sys.readFile),config=ts.parseJsonConfigFileContent(read.config,ts.sys,process.cwd()),options={...config.options,noEmit:true,incremental:false};
const program=ts.createProgram(roots,options),diagnostics=ts.getPreEmitDiagnostics(program);
console.log(JSON.stringify({roots:roots.length,sources:program.getSourceFiles().length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],diagnostics:diagnostics.length}));
if(diagnostics.length)console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
process.exitCode=diagnostics.length?1:0;
