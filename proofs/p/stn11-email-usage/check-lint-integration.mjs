import {ESLint} from '/workspace/scratch/77662bfb9bc5/marktmorgen/node_modules/eslint/lib/api.js';
const lint=new ESLint({overrideConfigFile:'/workspace/scratch/77662bfb9bc5/marktmorgen/eslint.config.mjs'});
const results=await lint.lintFiles(['components/email-usage-summary.tsx','tests/email-usage-summary.test.ts','app/studio/email/page.tsx','components/email-studio.tsx','lib/email-usage-summary.ts','tests/email-usage-page.test.ts','tests/email-usage-page-world.tsx','tests/send-count.test.ts']);
for(const r of results)for(const m of r.messages)console.log(r.filePath+':'+m.line+': '+m.message);
const errors=results.reduce((n,r)=>n+r.errorCount,0),warnings=results.reduce((n,r)=>n+r.warningCount,0);
console.log(JSON.stringify({errors,warnings,files:results.length}));
process.exitCode=errors?1:0;
