
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
const root=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const arg=(name)=>{const i=process.argv.indexOf(name);if(i<0||!process.argv[i+1])throw Error("Required "+name);return resolve(process.argv[i+1]);};
const snapshots=arg("--snapshots"),dependencies=arg("--dependencies");
const pins={"head":{"tests/deals-board-remount-ready.test.ts":"3f415216afc4a4dc6a56d39bf01857696ad8e45c","tests/e2e/deals-board-focus.mjs":"20301a0bbe22ac46ae159cad9f1a76ed5129bbc2","tests/e2e/deals-board-harness.tsx":"bd72207df5c9f5dd60d9d4928445cebc04f49b92"},"red":{"tests/deals-board-remount-ready.test.ts":"14f33b14714b6b3b9615f12d77c03444438cd8a1","tests/e2e/deals-board-focus.mjs":"20301a0bbe22ac46ae159cad9f1a76ed5129bbc2","tests/e2e/deals-board-harness.tsx":"2d3bb423d097c6c7543fd52d97bcbf0c4f87ffcd"}};
const canonicalConfig="{\n  \"compilerOptions\": {\n    \"target\": \"ES2017\",\n    \"lib\": [\"dom\", \"dom.iterable\", \"esnext\"],\n    \"allowJs\": true,\n    \"skipLibCheck\": true,\n    \"strict\": true,\n    \"noEmit\": true,\n    \"esModuleInterop\": true,\n    \"module\": \"esnext\",\n    \"moduleResolution\": \"bundler\",\n    \"resolveJsonModule\": true,\n    \"isolatedModules\": true,\n    \"jsx\": \"react-jsx\",\n    \"jsxImportSource\": \"@/lib/content-jsx\",\n    \"incremental\": true,\n    \"plugins\": [\n      {\n        \"name\": \"next\"\n      }\n    ],\n    \"paths\": {\n      \"@/*\": [\"./*\"]\n    }\n  },\n  \"include\": [\n    \"next-env.d.ts\",\n    \"**/*.ts\",\n    \"**/*.tsx\",\n    \".next/types/**/*.ts\",\n    \".next/dev/types/**/*.ts\",\n    \"**/*.mts\"\n  ],\n  \"exclude\": [\"node_modules\"]\n}\n";
const maxLog=128*1024,maxSource=256*1024,minFree=768*1024*1024;
let logBytes=0,sourceBytes=0;
const log=(s)=>{s=String(s);const n=Buffer.byteLength(s);if(logBytes+n>maxLog)throw Error("Log cap before output");logBytes+=n;process.stdout.write(s);};
function admission(){
 const values=["memory.max","memory.current"].map(p=>readFileSync("/sys/fs/cgroup/"+p,"utf8").trim());
 if(!/^[1-9]\d*$/.test(values[0])||!/^\d+$/.test(values[1]))throw Error("Finite cgroup memory required");
 const [limit,current]=values.map(Number);
 if(!Number.isSafeInteger(limit)||!Number.isSafeInteger(current)||current>limit||limit-current<minFree)throw Error("Insufficient measured cgroup headroom");
 return {limit,current,free:limit-current};
}
const sources={};
for(const kind of ["head","red"]){sources[kind]={};for(const [path,sha] of Object.entries(pins[kind])){
 const b=readFileSync(join(snapshots,kind,path));if(sourceBytes+b.length>maxSource)throw Error("Source cap before accepting file");sourceBytes+=b.length;
 if(createHash("sha1").update(Buffer.from("blob "+b.length+"\0")).update(b).digest("hex")!==sha)throw Error("Source SHA mismatch "+kind+" "+path);
 sources[kind][path]=b.toString("utf8");
}}
const require=createRequire(join(dependencies,"package.json"));const esbuild=require("esbuild");
const proof=readFileSync(join(root,"tests/m-2973-deals-board-remount.proof.ts"),"utf8");
const guard='globalThis.fetch=()=>{throw Error("Network forbidden by M review");};';
const temporary=mkdtempSync(join(root,".m-2973-"));const receipts=[];
try{
 symlinkSync(dependencies,join(temporary,"node_modules"),"dir");
 writeFileSync(join(temporary,"network.cjs"),guard);
 for(const mode of ["author","own"]){
  const entry=mode==="author"?sources.head["tests/deals-board-remount-ready.test.ts"]:proof;
  admission();
  const built=esbuild.transformSync(entry,{loader:"ts",format:"cjs",target:"es2017",tsconfigRaw:canonicalConfig,sourcefile:mode+".ts",logLevel:"error"}).code;
  writeFileSync(join(temporary,mode+".cjs"),built);
  for(const kind of ["red","head"]){
   const view=join(temporary,mode+"-"+kind);mkdirSync(join(view,"tests/e2e"),{recursive:true});
   for(const p of ["tests/e2e/deals-board-harness.tsx","tests/e2e/deals-board-focus.mjs"])writeFileSync(join(view,p),sources[kind][p]);
   const memory=admission();
   const child=spawnSync(process.execPath,["--max-old-space-size=256","--require",join(temporary,"network.cjs"),join(temporary,mode+".cjs"),view],{cwd:view,env:{PATH:"/usr/bin:/bin",TZ:"UTC",NODE_OPTIONS:"--max-old-space-size=256"},encoding:"utf8",timeout:20000,maxBuffer:maxLog-logBytes});
   if(child.error||child.signal)throw Error("Child harness failed "+String(child.error??child.signal));
   log("CASE "+mode+" "+kind+"\n"+child.stdout+child.stderr);
   const receipt={mode,kind,status:child.status,memory,logBytes:Buffer.byteLength(child.stdout+child.stderr)};receipts.push(receipt);
   const complete=mode==="author"?/10 checks complete\./.test(child.stdout):/"checks":8/.test(child.stdout);
   if(!complete||child.status!==(kind==="red"?1:0))throw Error("Unexpected bounded-case outcome "+JSON.stringify(receipt));
  }
 }
 log("RESULT "+JSON.stringify({receipts,sourceBytes,logBytes,scope:"source assertions and instrumented test-harness protocol; no browser, React commit, product IO or CI"})+"\n");
}finally{rmSync(temporary,{recursive:true,force:true});}
