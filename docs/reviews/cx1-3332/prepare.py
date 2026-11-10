from pathlib import Path
p = Path('.git/cx1-run.mjs')
s = p.read_text()
code = """globalThis.fetch=__cx1deny;let __cx1fetch=__cx1deny;Object.defineProperty(globalThis,'fetch',{configurable:false,get(){return __cx1fetch},set(fn){__cx1fetch=(...args)=>{const f=require('node:fs'),p=process.env.CX1_LEDGER;const v=JSON.parse(f.readFileSync(p,'utf8'));if(v.http>=100)throw new Error('CX1 aggregate HTTP cap');v.http++;f.writeFileSync(p,JSON.stringify(v));return fn(...args)}}});"""
s = s.replace('globalThis.fetch=__cx1deny;', code)
s = s.replace('const r=spawnSync', "env.CX1_LEDGER=resolve('.git/cx1-3332-ledger.json');\n const r=spawnSync")
Path('.git/cx1-run-capped.mjs').write_text(s)
ledger = Path('.git/cx1-3332-ledger.json')
assert not ledger.exists()
ledger.write_text('{"http":0}')
r = Path('.git/cx1-review-3332')
src = (r/'tests/closed-store-renewals-exact.test.ts').read_text()
end = src.index('  part("Pages followed to the end;')
src = src[:end] + '  done();\n}\nmain().catch(e=>{console.error(e);process.exitCode=1});\n'
(r/'tests/cx1-renewals-author-prefix.proof.ts').write_text(src)
