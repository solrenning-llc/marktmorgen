/**
 * D2 #2874 exact-head evidence runner. CWD: exact e46c snapshot or D2 evidence branch.
 * node proofs/d2/review-2874.mjs proof|validation
 * Existing dependencies only; P-256/real local POST, MemoryRedis, no external provider.
 */
import {execFileSync,spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {createRequire} from "node:module";
import {createHash} from "node:crypto";
import {pathToFileURL} from "node:url";
const root=process.cwd(), require=createRequire(resolve("package.json")), {build}=require("esbuild");
const {testAliases,testEnvironment}=await import(pathToFileURL(resolve("tests/test-config.mjs")).href);
const head="e46c69c51628ca97db9e3c302e9abd715ae9cee7",old="8b4ceab6d9165974bee03e6732172e8819264630";
const own=new Set(["tests/d2-2874.proof.ts","proofs/d2/review-2874.mjs","docs/reviews/d2-2874-passkey-drop.md"]);
const git=(...args)=>execFileSync("git",args,{encoding:"utf8",maxBuffer:4000000}).trimEnd();
if(git("diff","--name-only",head).split(String.fromCharCode(10)).filter(Boolean).some(p=>!own.has(p)))throw Error("Use exact reviewed product snapshot");
const proof=execFileSync("git",["show","5b87461a1a9931918accf925a1f0b9ccfacd7189:tests/d2-2874.proof.ts"],{encoding:"utf8"});
const proofSha=createHash("sha1").update("blob "+Buffer.byteLength(proof)+"\0").update(proof).digest("hex");
if(proofSha!=="a9fec307e54dfe6c943f65d2b0bc3b29d34ddce2")throw Error("Immutable proof mismatch");
const red=Object.fromEntries(["lib/passkeys.ts","app/api/auth/passkey/signin/route.ts"].map(p=>[p,execFileSync("git",["show",old+":"+p],{encoding:"utf8",maxBuffer:4000000})]));
async function run(file,preimage=false,independent=false){
 const built=await build({...(independent?{stdin:{contents:proof,resolveDir:resolve("tests"),sourcefile:"tests/d2-2874.proof.ts",loader:"ts"}}:{entryPoints:["tests/"+file]}),bundle:true,platform:"node",format:"cjs",write:false,alias:testAliases(file,root,resolve("tests")),plugins:[{name:"pinned-preimage",setup(b){if(preimage)b.onLoad({filter:/\.tsx?$/},a=>{const p=a.path.slice(root.length+1);if(Object.hasOwn(red,p))return {contents:red[p],loader:"ts"};});}}],logLevel:"error"});
 const r=spawnSync(process.execPath,["-"],{input:built.outputFiles[0].text,encoding:"utf8",env:testEnvironment(process.env),maxBuffer:4000000,timeout:60000});
 console.log(JSON.stringify({file,preimage,independent,status:r.status,signal:r.signal,error:r.error?.message}));
 process.stdout.write(r.stdout??"");if(r.stderr)process.stderr.write(r.stderr);
 return r;
}
const mode=process.argv[2]??"proof";
if(mode==="proof"){
 const a=await run("d2-2874.proof.ts",true,true),b=await run("d2-2874.proof.ts",false,true);
 if(!/11 checks, 3 failing/.test(a.stdout))throw Error("Pinned preimage must reproduce11/3");
 process.exitCode=b.status??1;
}else if(mode==="validation"){
 const a=await run("passkey-drop-exact.test.ts",true);
 if(!/97 checks, 51 failing/.test(a.stdout))throw Error("Canonical RED must reproduce97/51");
 const names=["passkey-drop-exact","api-key-second-step","l10b-passkey-claim","l10b-passkey-list-bound","l10b-passkey-move","locked-deletes","reset-notices","review-2556-delta2","review-2556-sessions","second-step-gate","security-faq","security-page","sg2-unknown-replies","sign-in-history-rules","team-two-step-session","two-step"];
 for(const name of names){const r=await run(name+".test.ts");if(r.status||r.error)throw Error("Linked test failed: "+name);}
}else throw Error("Choose proof or validation");
