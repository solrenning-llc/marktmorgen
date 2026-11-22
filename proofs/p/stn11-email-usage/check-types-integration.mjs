import ts from '/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/typescript/lib/typescript.js';
const root=process.cwd();
const types='/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/@types';
const program=ts.createProgram(['components/email-usage-summary.tsx','components/usage-meter.tsx','tests/email-usage-summary.test.ts','app/studio/email/page.tsx','components/email-studio.tsx','tests/email-usage-page.test.ts'],{noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true,typeRoots:[types],types:['node','react','react-dom'],baseUrl:root,paths:{'@/*':[root+'/*'],'react':[types+'/react/index.d.ts'],'react/jsx-runtime':[types+'/react/jsx-runtime.d.ts'],'react-dom/server':[types+'/react-dom/server.d.ts'],'*':['/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/*',types+'/*']}});
const diagnostics=ts.getPreEmitDiagnostics(program);
for(const d of diagnostics)console.log((d.file?.fileName??'config')+':'+(d.start??0)+': '+ts.flattenDiagnosticMessageText(d.messageText,'\n'));
console.log('Scoped semantic diagnostics:',diagnostics.length);
process.exitCode=diagnostics.length?1:0;
