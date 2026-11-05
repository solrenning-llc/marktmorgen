/** Owned runner: standard test aliases plus only the Next request-context fixture and automatic JSX. */
import {build} from 'esbuild';import{spawnSync}from'node:child_process';import{mkdirSync}from'node:fs';import{resolve}from'node:path';import{testAliases,testEnvironment}from'../tests/test-config.mjs';
const root=process.cwd(),name='review-g2-collection-page-cost.test.ts';mkdirSync('.review-output',{recursive:true});const aliases=testAliases(name,root,resolve('tests'));aliases['next/headers']=resolve('tests/review-g2-collection-page-world.ts');
await build({entryPoints:[resolve('tests',name)],bundle:true,platform:'node',format:'cjs',jsx:'automatic',outfile:resolve('.review-output',name+'.cjs'),alias:aliases,logLevel:'warning'});
const result=spawnSync(process.execPath,[resolve('.review-output',name+'.cjs')],{env:testEnvironment(process.env),stdio:'inherit'});process.exit(result.status??1);
