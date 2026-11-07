import ts from 'typescript';
import {writeFileSync} from 'node:fs';
const root=process.cwd();
const options={noEmit:true,strict:true,skipLibCheck:true,target:ts.ScriptTarget.ES2017,module:ts.ModuleKind.ESNext,moduleResolution:ts.ModuleResolutionKind.Bundler,jsx:ts.JsxEmit.Preserve,esModuleInterop:true,resolveJsonModule:true,allowJs:true,lib:['lib.dom.d.ts','lib.dom.iterable.d.ts','lib.esnext.d.ts'],baseUrl:root,paths:{'@/*':['./*']},types:['node'],typeRoots:[root+'/node_modules/@types']};
const roots=['components/tax-editor.tsx','tests/wg15-tax-link.test.ts','tests/n-3056-store-pin.proof.tsx'].map(x=>root+'/'+x);
const p=ts.createProgram(roots,options);const out=ts.getPreEmitDiagnostics(p).map(d=>({file:d.file?.fileName,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}));
writeFileSync('n-focal-type-sources.json',JSON.stringify(p.getSourceFiles().map(f=>f.fileName)));writeFileSync('n-focal-type-diagnostics.json',JSON.stringify(out));console.log(JSON.stringify({roots:roots.length,sources:p.getSourceFiles().length,diagnostics:out.length,first:out.slice(0,6)}));process.exitCode=out.length?1:0;
