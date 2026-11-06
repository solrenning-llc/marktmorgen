import { build } from "esbuild";
import { createRequire } from "node:module";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync, execFileSync } from "node:child_process";
import { testAliases, testEnvironment } from "../tests/test-config.mjs";

const root = process.cwd(), here = join(root, "tests"), require = createRequire(import.meta.url);
const undici = require.resolve("undici");
if (createRequire(require.resolve("@vercel/blob")).resolve("undici") !== undici) throw new Error("SDK dispatcher mismatch; refuse to run");
const out = mkdtempSync(join(tmpdir(), "j-2896-"));
let failed = 0;
try {
  console.log("SOURCE", execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim());
  const files = process.argv.slice(2);
  if (!files.length) files.push("r24-two-step-exact.test.ts", "j-2896-two-step.proof.ts");
  for (const file of files) {
    if (!existsSync(join(here, file))) throw new Error(`Missing selected file: ${file}`);
    const bundle = join(out, `${file}.cjs`), launch = join(out, `${file}.launch.cjs`);
    await build({ entryPoints: [join(here, file)], bundle: true, platform: "node", format: "cjs", outfile: bundle,
      logLevel: "error", alias: testAliases(file.endsWith(".proof.ts") ? "r24-two-step-exact.test.ts" : file, root, here) });
    writeFileSync(launch, `const assert=require('node:assert/strict');
const net=require('node:net');let attempted=0;net.Socket.prototype.connect=function(){attempted++;throw new Error('J2896 refuses external sockets');};
const undici=require(${JSON.stringify(undici)}), agent=new undici.MockAgent();agent.disableNetConnect();undici.setGlobalDispatcher(agent);
globalThis.fetch=async()=>{throw new Error('J2896 refuses unregistered HTTP');};
(async()=>{
assert.throws(()=>new net.Socket().connect(443,'unregistered.invalid'),/refuses external sockets/);
await assert.rejects(()=>undici.fetch('https://unregistered.invalid/'), e=>e?.cause?.code==='UND_MOCK_ERR_MOCK_NOT_MATCHED');
assert.equal(attempted,1);globalThis.__j2896NetworkGuard=true;console.log('NETWORK GUARDS PASS before graph');require(${JSON.stringify(bundle)});
})().catch(e=>{console.error(e);process.exitCode=1;});\n`);
    const env = testEnvironment(process.env);
    for (const key of Object.keys(env)) if (/^(AWS_|SES_|RESEND_|STRIPE_|PAYPAL_|BLOB_|R2_|S3_)/.test(key)) delete env[key];
    env.NIMBUS_DATA_KEY = "tests-only-not-a-real-deployment-secret";
    console.log(`\n=== ${file} ===`);
    const child = spawnSync(process.execPath, [launch], { stdio: "inherit", env, timeout: 120000 });
    if (child.error) throw child.error;
    if (child.status !== 0) failed++;
  }
} finally { rmSync(out, { recursive: true, force: true }); }
if (failed) process.exitCode = 1;
