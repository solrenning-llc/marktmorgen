import {build} from 'esbuild';
import {spawnSync,execFileSync} from 'node:child_process';
import {resolve,dirname} from 'node:path';
import {testAliases,testEnvironment} from '../../tests/test-config.mjs';
const mode=process.argv[2];
for(const file of process.argv.slice(3)){
 const plugins=mode==='red'?[{name:'exact-author-red',setup(b){b.onLoad({filter:/\/lib\/plan-refund\.ts$/},a=>({contents:execFileSync('git',['show','ccce1856aa04cdacbb063f574fb9ee2526f4852b:lib/plan-refund.ts'],{encoding:'utf8'}),loader:'ts',resolveDir:dirname(a.path)}));}}]:[];
 const bundle=await build({entryPoints:['tests/'+file],bundle:true,platform:'node',format:'cjs',write:false,alias:testAliases(file,process.cwd(),resolve('tests')),plugins,logLevel:'error'});
 const r=spawnSync(process.execPath,['-'],{input:bundle.outputFiles[0].text,encoding:'utf8',env:testEnvironment(process.env),maxBuffer:3000000});
 console.log(mode+' '+file+' exit='+r.status+'\n'+r.stdout);if(r.status){console.error(r.stderr);process.exitCode=1;}
}
