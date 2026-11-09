import ts from 'typescript';
const roots=["lib/stripe-connect.ts", "app/api/stripe/check/route.ts", "app/api/stripe/return/route.ts", "lib/checkup.ts", "lib/checkup-rules.ts", "tests/stripe-connect-account-exact.test.ts", "docs/reviews/z-3311-nominal-focal/z-3311-shapes.proof.ts", "docs/reviews/z-3311-nominal-focal/z-3311-status-unknown.proof.ts"];
const read=ts.readConfigFile('tsconfig.json',ts.sys.readFile),config=ts.parseJsonConfigFileContent(read.config,ts.sys,process.cwd()),options={...config.options,noEmit:true,incremental:false};
const program=ts.createProgram(roots,options),diagnostics=ts.getPreEmitDiagnostics(program);
console.log(JSON.stringify({roots:roots.length,sources:program.getSourceFiles().length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],diagnostics:diagnostics.length}));
if(diagnostics.length)console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
process.exitCode=diagnostics.length?1:0;
