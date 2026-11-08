import ts from 'typescript';
const roots=['app/api/store/file/route.ts','app/api/store/image/upload/route.ts','lib/session-id.ts','lib/auth.ts','lib/segments.ts','tests/upload-hand-back-signed-out.test.ts','tests/upload-hand-back-cost.test.ts','tests/pricing-usage-proposal.test.ts','tests/limits-proposal.test.ts','tests/pricing-optimization.test.ts','docs/reviews/z-3171-financial-focal/g-original-10.proof.ts','docs/reviews/z-3171-financial-focal/virtual-http.ts'];
const read=ts.readConfigFile('tsconfig.json',ts.sys.readFile),config=ts.parseJsonConfigFileContent(read.config,ts.sys,process.cwd()),options={...config.options,noEmit:true,incremental:false};
const program=ts.createProgram(roots,options),diagnostics=ts.getPreEmitDiagnostics(program);
console.log(JSON.stringify({roots:roots.length,sources:program.getSourceFiles().length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],diagnostics:diagnostics.length}));
if(diagnostics.length)console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
process.exitCode=diagnostics.length?1:0;
