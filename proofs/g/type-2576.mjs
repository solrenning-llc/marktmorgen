import ts from 'typescript';
import {resolve} from 'node:path';
const root=process.cwd();const raw=ts.readConfigFile(resolve(root,'tsconfig.json'),ts.sys.readFile);if(raw.error)throw Error(ts.flattenDiagnosticMessageText(raw.error.messageText,' '));
const parsed=ts.parseJsonConfigFileContent(raw.config,ts.sys,root);
const opts={...parsed.options,incremental:false,types:['node']};
const roots=['tests/g2576-launch-entry-shape.proof.ts','tests/waitlist-launch-unknown.test.ts','lib/person-erasure.ts'].map(p=>resolve(root,p));
const p=ts.createProgram(roots,opts);const d=ts.getPreEmitDiagnostics(p);console.log('G2576_TYPES',JSON.stringify({roots:roots.length,sourceFiles:p.getSourceFiles().length,target:ts.ScriptTarget[opts.target],diagnostics:d.length}));console.log(ts.formatDiagnosticsWithColorAndContext(d,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>root,getNewLine:()=>'\n'}));process.exitCode=d.length?1:0;
