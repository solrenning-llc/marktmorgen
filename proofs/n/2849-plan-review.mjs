import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,dirname} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {spawnSync} from "node:child_process";
const evidenceRoot=resolve(dirname(fileURLToPath(import.meta.url)),"../..");
const sourceRoot=resolve(process.argv[2]||evidenceRoot),here=join(sourceRoot,"tests");
const entry=join(evidenceRoot,"tests/n-2849-plan-recovery.proof.ts");
const {testAliases,testEnvironment}=await import(pathToFileURL(join(here,"test-config.mjs")));
const out=mkdtempSync(join(tmpdir(),"n-kb9-plan-"));
try {
 const bundle=join(out,"proof.cjs");
 await build({entryPoints:[entry],bundle:true,platform:"node",format:"cjs",outfile:bundle,logLevel:"error",alias:testAliases("kb9-plan-withdrawal.test.ts",sourceRoot,here),plugins:[{name:"selected-source-fixtures",setup(b){b.onResolve({filter:/^\.\//},async args=>args.importer===entry?b.resolve(args.path,{resolveDir:here,kind:args.kind}):undefined);}}]});
 const run=spawnSync(process.execPath,[bundle],{cwd:sourceRoot,stdio:"inherit",env:testEnvironment(process.env)});
 process.exitCode=run.status??1;
}finally{rmSync(out,{recursive:true,force:true});}
