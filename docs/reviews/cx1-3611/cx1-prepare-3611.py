from pathlib import Path
import json,subprocess
b=Path(__file__).resolve().parent;r=b/'cx1-review-3611';p=b/'cx1-3611-ledger.json';assert not p.exists()
p.write_text(json.dumps({'http':0,'redisCommands':0,'httpLimit':0,'redisLimit':0}))
s=(b/'cx1-run-3590.mjs').read_text().replace('cx1-3590-ledger.json','cx1-3611-ledger.json')
s=s.replace('globalThis.fetch=__cx1deny;', '''globalThis.fetch=__cx1deny;if(process.env.CX1_ABSENT_TRUST){const f=require('node:fs'),e=f.existsSync;f.existsSync=(p)=>String(p)==='app/help/trust-and-safety/page.tsx'?false:e(p);}''')
s=s.replace("env.CX1_LEDGER=", "env.CX1_ABSENT_TRUST=process.env.CX1_ABSENT_TRUST||'';\n env.CX1_LEDGER=")
(b/'cx1-run-3611.mjs').write_text(s)
old=subprocess.check_output(['git','show','332567c8d:tests/gd1-trust-page.test.ts'],cwd=r)
(r/'tests/cx1-author-red-trust-page.proof.ts').write_bytes(old)
(r/'tests/cx1-trust-ssr.proof.tsx').write_text('''import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import TrustPage from "../app/help/trust-and-safety/page";
import HelpPage from "../app/help/page";
import {done,is,part} from "./check";
const guide=renderToStaticMarkup(createElement(TrustPage));
const help=renderToStaticMarkup(createElement(HelpPage));
part("Actual public components rendered with real network denied");
for(const [name,html] of [["guide",guide],["help",help]]) {
 is(name+": one main",(html.match(/<main\\b/g)||[]).length,1);
 is(name+": one H1",(html.match(/<h1\\b/g)||[]).length,1);
 is(name+": shared main focus target survives JSX runtime",/<main(?=[^>]*id="content")(?=[^>]*tabindex="-1")/.test(html),true);
}
is("guidance does not display a false effective date",/Effective (?:August|November)/.test(guide),false);
for(const path of ["/report","/copyright","/terms","/help/buyers"]){
 is("guide has named link "+path,new RegExp('<a[^>]*href="'+path+'"[^>]*>[^<]+</a>').test(guide),true);
}
is("help has exactly one named direct safety link",(help.match(/href="\\/help\\/trust-and-safety"/g)||[]).length,1);
const hash=(text:string)=>({bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
writeFileSync('.cx1-evidence/ssr-manifest.json',JSON.stringify({guide:hash(guide),help:hash(help)},null,2));
done();
''',encoding='utf8')
print('prepared zero-I/O runner and SSR proof; RED author file is unchanged bytes')
