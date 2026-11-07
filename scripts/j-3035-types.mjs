import ts from 'typescript';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const raw=ts.readConfigFile(path.join(root,'tsconfig.json'),ts.sys.readFile);
if(raw.error)throw raw.error;
const config=ts.parseJsonConfigFileContent(raw.config,ts.sys,root);
const options={...config.options,incremental:false,plugins:[],types:['node'],typeRoots:[path.join(root,'node_modules/@types')]};
const roots=['lib/student-bulk.ts','lib/student-bulk-rules.ts','app/api/store/students/route.ts','tests/h3-4-bulk-students.test.ts','tests/j-review-3035-bulk-students.proof.ts','tests/p-review-3035-access-admission.test.ts'];
const program=ts.createProgram(roots.map(p=>path.join(root,p)),options);
let diagnostics=[...program.getOptionsDiagnostics(),...program.getGlobalDiagnostics()];
for(const p of roots){const f=program.getSourceFile(path.join(root,p));if(!f)throw Error('missing root '+p);diagnostics.push(...program.getSyntacticDiagnostics(f),...program.getSemanticDiagnostics(f));}
console.log(JSON.stringify({scope:'direct roots plus imported types; imported dependency bodies not separately checked',roots,sources:program.getSourceFiles().length,options:{target:ts.ScriptTarget[options.target],strict:options.strict,moduleResolution:ts.ModuleResolutionKind[options.moduleResolution]},diagnostics:diagnostics.map(d=>({file:d.file?.fileName,code:d.code,message:ts.flattenDiagnosticMessageText(d.messageText,' ')}))},null,2));
process.exitCode=diagnostics.length?2:0;
