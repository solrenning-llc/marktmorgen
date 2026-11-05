import {build} from 'esbuild';
import {spawnSync,execFileSync} from 'node:child_process';
import {dirname,resolve} from 'node:path';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const mode=process.argv[2];
for(const file of process.argv.slice(3)){
 const plugins=mode==='red'?[{name:'exact-red-source',setup(b){b.onLoad({filter:/\/lib\/company-owner-report\.ts$/},a=>({contents:execFileSync('git',['show','4e77e73c07ee1accdc76d22b29459c4df4378fce:lib/company-owner-report.ts'],{encoding:'utf8'}),loader:'ts',resolveDir:dirname(a.path)}));}}]:[];
 const b=await build({entryPoints:['tests/'+file],bundle:true,platform:'node',format:'cjs',write:false,alias:testAliases(file,process.cwd(),resolve('tests')),plugins,logLevel:'error'});
 const r=spawnSync(process.execPath,['-'],{input:b.outputFiles[0].text,encoding:'utf8',env:testEnvironment(process.env),maxBuffer:3000000});console.log(file+' exit='+r.status+'\n'+r.stdout);if(r.status){console.error(r.stderr);process.exitCode=1;}
}
