import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
const repo=process.env.H2_REVIEW_REPO??process.cwd();
const head=process.env.H2_REVIEW_HEAD??'dc431848ca23c8fee8394fa1e0427d755a638d51';
const proofRef='de9485e92ca8fe604990874644291f7b8d68c864';
const files=new Map();
function source(path,ref=head){const k=ref+':'+path;if(!files.has(k))files.set(k,execFileSync('git',['show',k],{cwd:repo,encoding:'utf8',timeout:20000,maxBuffer:1048576}));return files.get(k);}
const fixtures={
 'lib/store.ts':`const s={statsId:'fixture-blog',posts:1,handle:'metadataproof',name:'Synthetic blog',bio:'',language:'en',suspended:false}; export async function claimHandle(){return true} export async function ensureStatsId(){} export async function setPostCount(){} export async function storeForEmail(){return s} export async function storeForPage(){return s} export const normaliseHandle=x=>x.replace(/^@/,'');`,
 'lib/store-data.ts':`export async function needData(){} export async function giveData(){}`,
 'lib/store-data-rules.ts':`export const dataBytes=()=>0;`,
 'lib/product-about.ts':`export const cleanAbout=x=>x; export const aboutExcerpt=(x,n)=>x.slice(0,n); export const aboutBlocks=()=>[];`,
 'lib/buyer-words.ts':`export const speech=()=>({w:{blogOf:x=>x}});`,
 'lib/site-url.ts':`export const SITE_URL='https://example.test';`,
 'lib/buyer-words/blog-reading.ts':`export const blogReadingWords=()=>({unavailable:'Unavailable'});`,
};
let commands=0;
registerHooks({resolve(s,c,next){if(s.startsWith('node:'))return next(s,c);let path;if(s==='@/lib/redis')path='tests/redis-stub.ts';else if(s.startsWith('@/'))path=s.slice(2);else if(s.startsWith('.')&&c.parentURL?.startsWith('git:///'))path=posix.normalize(posix.join(posix.dirname(c.parentURL.slice(7)),s));else return next(s,c);if(!posix.extname(path))path+='.ts';return{url:'git:///'+path,shortCircuit:true};},load(url,c,next){if(!url.startsWith('git:///'))return next(url,c);const path=url.slice(7);let text=fixtures[path]??source(path,path==='tests/h2-2695-metadata.proof.ts'?proofRef:head);if(path==='tests/redis-stub.ts')text+=`\nconst orig=store.pipeline.bind(store);store.pipeline=async cs=>{globalThis.h2Commands(cs.length);return orig(cs)};`;return{format:'module',source:path.endsWith('.ts')?stripTypeScriptTypes(text,{mode:'strip'}):text,shortCircuit:true};}});
globalThis.h2Commands=n=>{commands+=n;if(commands>200)throw Error('synthetic command ceiling');};
globalThis.fetch=async()=>{throw Error('external fetch forbidden');};
process.on('exit',()=>console.log(JSON.stringify({head,commands,loadedGitFiles:files.size,storeAndRoom:'synthetic; not exercised',compiler:'not run'})));
await import('git:///tests/h2-2695-metadata.proof.ts');
