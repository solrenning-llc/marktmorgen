/** Run only G2's owned lesson corrective proofs with the repository test wiring. */
import {build} from "esbuild";
import {spawnSync} from "node:child_process";
import {mkdirSync} from "node:fs";
import {resolve} from "node:path";
import {testAliases,testEnvironment} from "../tests/test-config.mjs";
const root=process.cwd();mkdirSync(".review-output",{recursive:true});
for(const file of ["review-g2-lesson-thread-corrective-boundaries.test.ts","review-g2-lesson-delete-cost-fixture.test.ts"]){
 const out=resolve(".review-output",file+".cjs");
 await build({entryPoints:[resolve("tests",file)],bundle:true,platform:"node",format:"cjs",outfile:out,alias:testAliases(file,root,resolve("tests"))});
 const r=spawnSync(process.execPath,[out],{stdio:"inherit",env:testEnvironment(process.env)});
 if(r.status!==0)process.exit(r.status??1);
}
const native=spawnSync("python",["scripts/review_g2_lesson_thread_lua.py"],{stdio:"inherit"});
process.exit(native.status??1);
