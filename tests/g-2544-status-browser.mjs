/** Independent G: unmodified production e2e assertions on real React components.
 * Synthetic local shell, no Next session/storage/provider/CSS certification.
 */
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import {checkShipmentAcknowledgment} from './e2e/shipment-acknowledgment.mjs';
const root=resolve(process.argv[2]||'.');
const componentRef=process.argv[3];
const plugins=componentRef?[{name:'exact-previous-component',setup(build){build.onLoad({filter:/[\\/]components[\\/]mark-shipped\.tsx$/},()=>({contents:execFileSync('git',['show',`${componentRef}:components/mark-shipped.tsx`],{cwd:root,encoding:'utf8'}),loader:'tsx',resolveDir:resolve(root,'components')}));}}]:[];
const require=createRequire(resolve('node_modules/../package.json'));
const {build}=require('esbuild');const {chromium}=require('playwright-core');
const temp=await mkdtemp(join(tmpdir(),'g-2544-status-'));
let browser,server,checks=0;
try {
 await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {MarkShipped} from '@/components/mark-shipped';import {Toaster} from '@/components/toast';createRoot(document.getElementById('root')).render(<><section id="sales"><p>Synthetic shipment</p><MarkShipped session="cs_test_GShipmentBrowser000001" to={null} shipped={null}/></section><Toaster/></>);`,resolveDir:root,loader:'tsx'},plugins,bundle:true,platform:'browser',format:'iife',jsx:'automatic',alias:{'@':root},nodePaths:[resolve('node_modules')],outfile:join(temp,'app.js'),logLevel:'error'});
 const bundle=await readFile(join(temp,'app.js'));
 const html='<!doctype html><html lang="en"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:8px}form{display:flex;flex-wrap:wrap;gap:8px}label{min-width:192px;flex:1}input{max-width:100%}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style><div id="root"></div><script src="/app.js"></script></html>';
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/app.js'?'application/javascript':'text/html');res.end(req.url==='/app.js'?bundle:html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const LOCAL=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true});
 await checkShipmentAcknowledgment({browser,LOCAL,fixture:{session:'synthetic-session',sid:'synthetic-store'},shipment:'cs_test_GShipmentBrowser000001',is:(name,actual,expected)=>{assert.deepEqual(actual,expected,name);checks++;}});
 console.log(JSON.stringify({root,componentRef,checks,engine:'Chromium',result:'pass',productionAssertionsUnchanged:true,scope:'real React MarkShipped/Toaster/NewTab; synthetic shell, intercepted writes; no full Next/CSS/AT certification'}));
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(temp,{recursive:true,force:true});console.log(`completed assertions=${checks}`);}
