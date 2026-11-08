import ts from 'typescript';
const roots=['lib/community-files.ts', 'lib/form-opportunity.ts', 'app/api/store/community/upload/route.ts', 'tests/community-upload-door-exact.test.ts', 'tests/form-opportunity-room-exact.test.ts', 'docs/reviews/z-3305-nominal-focal/z-3305-live-image.proof.ts', 'docs/reviews/z-3305-nominal-focal/z-3305-room-size-captured.proof.ts','docs/reviews/z-3305-nominal-focal/z-3305-read-envelope.proof.ts'];
const read=ts.readConfigFile('tsconfig.json',ts.sys.readFile),config=ts.parseJsonConfigFileContent(read.config,ts.sys,process.cwd()),options={...config.options,noEmit:true,incremental:false};
const program=ts.createProgram(roots,options),diagnostics=ts.getPreEmitDiagnostics(program);
console.log(JSON.stringify({roots:roots.length,sources:program.getSourceFiles().length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],diagnostics:diagnostics.length}));
if(diagnostics.length)console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
process.exitCode=diagnostics.length?1:0;
