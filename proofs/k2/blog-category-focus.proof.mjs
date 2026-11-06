import {createRequire} from 'node:module';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import {writeFileSync,mkdtempSync,rmSync} from 'node:fs';
const root=resolve(fileURLToPath(new URL('../..',import.meta.url))),require=createRequire(join(root,'package.json'));
const {build}=require('esbuild');
const built=await build({stdin:{contents:`import {createElement} from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {BlogBrowser} from './components/blog-browser';import {BLOG_CATEGORIES,postsSorted} from './lib/blog';import {readFileSync} from 'node:fs';import {compile} from '@tailwindcss/node';(async()=>{const html=renderToStaticMarkup(createElement('section',{className:'container-page py-14 sm:py-20'},createElement('div',{className:'mt-8'},createElement(BlogBrowser,{posts:postsSorted(),categories:[...BLOG_CATEGORIES]}))));const classes=[...html.matchAll(/class="([^"]*)"/g)].flatMap(m=>m[1].split(/\\s+/));const compiler=await compile(readFileSync('app/globals.css','utf8'),{base:process.cwd(),onDependency(){}});console.log(JSON.stringify({html,css:compiler.build(classes)}));})();`,resolveDir:root,loader:'ts'},bundle:true,platform:'node',format:'cjs',packages:'external',alias:{'@':root},write:false,logLevel:'error'});
const temp=mkdtempSync(join(tmpdir(),'k2-blog-focus-')),entry=join(temp,'render.cjs');
writeFileSync(entry,built.outputFiles[0].text);
const rendered=spawnSync(process.execPath,[entry],{cwd:root,env:{...process.env,NODE_PATH:join(root,'node_modules')},encoding:'utf8',maxBuffer:8000000});
rmSync(temp,{recursive:true,force:true});
if(rendered.status!==0)throw Error(String(rendered.error??rendered.stderr));
const {html,css}=JSON.parse(rendered.stdout);
const browser=await require('playwright-core').chromium.launch({headless:true});
console.log('CHROMIUM_VERSION:'+browser.version());
try {for(const width of [320]){
 const context=await browser.newContext({viewport:{width,height:900}});let foreign=0;
 await context.route('**/*',route=>{foreign++;return route.abort();});
 const page=await context.newPage();
 await page.setContent('<!doctype html><html><head><style>'+css+'</style></head><body>'+html+'</body></html>');
 const targets=page.locator('button[aria-pressed]');
 const sizes=await targets.evaluateAll(nodes=>nodes.map(n=>{let r=n.getBoundingClientRect();return{name:n.textContent,height:r.height,width:r.width}}));
 if(sizes.length!==9||sizes.some(s=>s.height<=0||s.width<=0))throw Error(JSON.stringify(sizes));
 console.log(JSON.stringify({width,heights:[...new Set(sizes.map(s=>s.height))],names:sizes.map(s=>s.name)}));for(let i=0;i<9;i++) {await page.keyboard.press('Tab');await page.waitForFunction(()=>{const n=document.activeElement,r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return n.matches('button[aria-pressed]')&&n.matches(':focus-visible')&&(n===hit||n.contains(hit));},undefined,{timeout:3000}).catch(async e=>{console.log(JSON.stringify(await page.evaluate(()=>{const n=document.activeElement,r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {name:n.textContent,rect:r.toJSON(),hit:hit?.outerHTML.slice(0,250),parents:[n.parentElement,n.parentElement.parentElement,document.body].map(p=>({html:p.outerHTML.slice(0,150),rect:p.getBoundingClientRect().toJSON(),scroll:p.scrollLeft,client:p.clientWidth,width:p.scrollWidth,overflow:getComputedStyle(p).overflowX}))};})));throw e;});const state=await page.evaluate(()=>{const n=document.activeElement,r=n.getBoundingClientRect(),hit=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);return {name:n.textContent,button:n.matches('button[aria-pressed]'),visible:n.matches(':focus-visible'),hit:n===hit||n.contains(hit)}});if(!state.button||!state.visible||!state.hit)throw Error(JSON.stringify({width,i,state}));}
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
 if(overflow||foreign)throw Error(JSON.stringify({overflow,foreign}));
 console.log(JSON.stringify({scope:'isolated real SSR and repository CSS; no hydration or Next route',width,targets:sizes.length,minWidth:Math.min(...sizes.map(s=>s.width)),heights:[...new Set(sizes.map(s=>s.height))],nativeTabFocus:9,overflow,foreign}));
 await context.close();
 }}finally {await browser.close();}
