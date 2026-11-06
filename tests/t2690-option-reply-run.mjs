import {build} from "esbuild";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {spawnSync} from "node:child_process";
import {testAliases,testEnvironment} from "./test-config.mjs";
const here=dirname(fileURLToPath(import.meta.url)),root=resolve(here,".."),out=mkdtempSync(join(tmpdir(),"t2690-review-"));
try {
  const target=join(out,"proof.cjs");
  await build({entryPoints:[join(here,"t2690-option-reply.proof.ts")],bundle:true,platform:"node",format:"cjs",outfile:target,logLevel:"error",alias:testAliases("option-sale-toggle.test.ts",root,here)});
  const run=spawnSync(process.execPath,[target],{cwd:root,stdio:"inherit",env:testEnvironment(process.env)});
  process.exitCode=run.status??1;
} finally {rmSync(out,{recursive:true,force:true});}
