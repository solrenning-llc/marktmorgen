from pathlib import Path
import json
r=Path('.git/cx1-review-2692')
ledger=Path('.git/cx1-2692-ledger.json')
assert not ledger.exists()
ledger.write_text(json.dumps({'http':0,'redisCommands':0,'httpLimit':2000,'redisLimit':20000}))
s=Path('.git/cx1-run.mjs').read_text()
code="""globalThis.fetch=__cx1deny;const __cx1fs=require('node:fs');const __cx1spend=(kind,n)=>{const p=process.env.CX1_LEDGER,v=JSON.parse(__cx1fs.readFileSync(p,'utf8'));if(v[kind]+n>v[kind==='http'?'httpLimit':'redisLimit'])throw new Error('CX1 aggregate '+kind+' cap');v[kind]+=n;__cx1fs.writeFileSync(p,JSON.stringify(v));};globalThis.__cx1spend=__cx1spend;const __cx1als=new(require('node:async_hooks').AsyncLocalStorage)();let __cx1fetch=__cx1deny;Object.defineProperty(globalThis,'fetch',{configurable:false,get(){return __cx1fetch},set(fn){__cx1fetch=(...args)=>{if(__cx1als.getStore())return fn(...args);__cx1spend('http',1);return __cx1als.run(true,()=>fn(...args));}}});"""
s=s.replace('globalThis.fetch=__cx1deny;',code)
s=s.replace('const r=spawnSync',"env.CX1_LEDGER=resolve('.git/cx1-2692-ledger.json');\n const r=spawnSync")
# Instrument the memory adapter's run entry, which remains underneath tests' pipeline replacements.
needle="const plugins=(old||sourceDir)?"
s=s.replace(needle,"const plugins=(true)?")
needle="const path=relative(root,args.path).replaceAll('\\\\','/');"
replacement=needle+"if(path==='lib/redis-memory.ts'){let source=readFileSync(args.path,'utf8');const tag='  run(';const pos=source.indexOf(tag);if(pos<0)throw new Error('memory run hook missing');const body=source.indexOf('{',pos);source=source.slice(0,body+1)+\" (globalThis as any).__cx1spend('redisCommands',1); \"+source.slice(body+1);return{contents:source,loader:'ts'};}"
assert needle in s
s=s.replace(needle,replacement)
Path('.git/cx1-run-2692.mjs').write_text(s)
