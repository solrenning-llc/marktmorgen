import {createElement} from "react";
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
 is(name+": one main",(html.match(/<main\b/g)||[]).length,1);
 is(name+": one H1",(html.match(/<h1\b/g)||[]).length,1);
 is(name+": shared main focus target survives JSX runtime",/<main(?=[^>]*id="content")(?=[^>]*tabindex="-1")/.test(html),true);
}
is("guidance does not display a false effective date",/Effective (?:August|November)/.test(guide),false);
for(const path of ["/report","/copyright","/terms","/help/buyers"]){
 is("guide has named link "+path,new RegExp('<a[^>]*href="'+path+'"[^>]*>[^<]+</a>').test(guide),true);
}
is("help has exactly one named direct safety link",(help.match(/href="\/help\/trust-and-safety"/g)||[]).length,1);
const hash=(text:string)=>({bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex')});
writeFileSync('.cx1-evidence/ssr-manifest.json',JSON.stringify({guide:hash(guide),help:hash(help)},null,2));
done();
