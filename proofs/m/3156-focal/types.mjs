import fs from 'node:fs';import path from 'node:path';import ts from 'typescript';import{execFileSync}from'node:child_process';import{createHash}from'node:crypto';
const root=process.cwd(),head='2884a97de14473a5a930b6260c7d0e926b757d84';
if(execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim()!==head)throw Error('Wrong subject');
const roots=['lib/closed-store-data.ts','lib/path-atomic.ts','lib/path.ts','lib/team.ts','lib/api-keys.ts','lib/email-sync.ts','lib/webhooks.ts','lib/phone-alerts.ts','lib/redis-memory.ts','tests/erase-lock-fence.test.ts','tests/m-3156-expired-delete-observed.test.ts','tests/m-reactivation-during-check.proof.ts','tests/m-erasure-concurrent.proof.ts'];
const config=ts.readConfigFile('tsconfig.json',ts.sys.readFile);if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,root);if(parsed.errors.length)throw Error('Invalid project config');
const program=ts.createProgram(roots,{...parsed.options,incremental:false,noEmit:true});
const blob=b=>createHash('sha1').update('blob '+b.length).update(Buffer.from([0])).update(b).digest('hex');const pins={};
for(const line of execFileSync('git',['ls-tree','-rz',head]).toString().split('\0')){if(line){const[m,p]=line.split('\t');if(m.split(' ')[1]==='blob')pins[p]=m.split(' ')[2];}}
const own=Object.fromEntries(roots.filter(p=>!pins[p]).map(p=>[p,blob(fs.readFileSync(p))]));let pinned=0;
for(const source of program.getSourceFiles()){const p=path.relative(root,source.fileName);if(p.startsWith('node_modules/')||!p||p.startsWith('../'))continue;if(blob(fs.readFileSync(source.fileName))!==(pins[p]??own[p]))throw Error('M_TYPE_SOURCE_PIN '+p);pinned++;}
const diagnostics=ts.getPreEmitDiagnostics(program);for(const d of diagnostics){console.log((d.file?d.file.fileName+':'+(d.file.getLineAndCharacterOfPosition(d.start||0).line+1)+': ':'')+'TS'+d.code+' '+ts.flattenDiagnosticMessageText(d.messageText,'\n'));}
console.log(JSON.stringify({roots,allSourceFiles:program.getSourceFiles().length,pinned,diagnostics:diagnostics.length,filtered:0}));process.exitCode=diagnostics.length?1:0;
