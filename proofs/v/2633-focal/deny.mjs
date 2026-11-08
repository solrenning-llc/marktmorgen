import fs from 'node:fs';
import net from 'node:net';import tls from 'node:tls';import http from 'node:http';import https from 'node:https';
import {syncBuiltinESMExports} from 'node:module';
const before=fs.readFileSync('proofs/v/2633-focal/before.md','utf8'),read=fs.readFileSync;
if(process.env.V2633_OLD==='yes')fs.readFileSync=(path,...args)=>String(path).endsWith('docs/tx4-chile-vat-evidence.md')?before:read(path,...args);
const deny=()=>{throw Error('V2633 external IO denied before graph');};globalThis.fetch=deny;
for(const api of [net,tls,http,https])for(const key of ['connect','createConnection','request','get'])if(typeof api[key]==='function')api[key]=deny;
syncBuiltinESMExports();
