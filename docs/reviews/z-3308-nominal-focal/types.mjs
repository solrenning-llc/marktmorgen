import ts from 'typescript';
const roots=['lib/erasure-index.ts', 'lib/redis-memory.ts', 'tests/erasure-forget-atomic.test.ts', 'docs/reviews/z-3308-nominal-focal/z-3296-erasure-read-race.proof.ts', 'docs/reviews/z-3308-nominal-focal/z-3308-batch-receipt.proof.ts', 'docs/reviews/z-3308-nominal-focal/z-3308-batch-bound.proof.ts','docs/reviews/z-3308-nominal-focal/z-3308-tail.proof.ts','docs/reviews/z-3308-nominal-focal/z-3308-type-guard.proof.ts'];
const read=ts.readConfigFile('tsconfig.json',ts.sys.readFile),config=ts.parseJsonConfigFileContent(read.config,ts.sys,process.cwd()),options={...config.options,noEmit:true,incremental:false};
const program=ts.createProgram(roots,options),diagnostics=ts.getPreEmitDiagnostics(program);
console.log(JSON.stringify({roots:roots.length,sources:program.getSourceFiles().length,target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution],diagnostics:diagnostics.length}));
if(diagnostics.length)console.log(ts.formatDiagnosticsWithColorAndContext(diagnostics,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));
process.exitCode=diagnostics.length?1:0;
