/** Local reviewer loader: no source edits, Node's own TypeScript erasure. */
import {registerHooks,stripTypeScriptTypes} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {resolve as pathResolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=process.env.G_REVIEW_ROOT||process.cwd();
registerHooks({resolve(specifier,context,next){
 let p;
 if(specifier.startsWith('@/'))p=pathResolve(root,specifier.slice(2));
 else if(specifier.startsWith('.')&&context.parentURL?.startsWith('file:'))p=pathResolve(fileURLToPath(new URL('.',context.parentURL)),specifier);
 if(p){for(const candidate of [p,p+'.ts',p+'.mjs'])if(existsSync(candidate))return {url:pathToFileURL(candidate).href,shortCircuit:true};}
 return next(specifier,context);
},load(url,context,next){if(url.endsWith('.ts'))return {format:'module',source:stripTypeScriptTypes(readFileSync(fileURLToPath(url),'utf8'),{mode:'transform',sourceUrl:url}),shortCircuit:true};return next(url,context);}});
