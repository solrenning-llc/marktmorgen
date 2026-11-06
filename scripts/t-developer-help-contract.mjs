/** G6 healthy contract proof; no unavailable-read, security or commercial claim. */
import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Reserved before graph initialization: across the entire child, including setup.
const ceiling = { commands: 5_000, cases: 12, milliseconds: 120_000, logBytes: 128 * 1024 };
const out = mkdtempSync(join(tmpdir(), "t-developer-help-contract-"));
const banner = `
globalThis.__tDeveloperHelp = { commands: 0, cases: 0, networkAttempts: 0 };
const denyNetwork = () => { globalThis.__tDeveloperHelp.networkAttempts++; throw new Error("G6 network is prohibited"); };
globalThis.fetch = async () => denyNetwork();
require("node:net").Socket.prototype.connect = denyNetwork;
for (const name of ["node:http", "node:https"]) {
  require(name).request = denyNetwork;
  require(name).get = denyNetwork;
}
`;

try {
  const bundle = join(out, "proof.cjs");
  await build({
    entryPoints: [join(root, "tests/t-developer-help-contract.proof.ts")],
    bundle: true, platform: "node", format: "cjs", outfile: bundle,
    logLevel: "error", banner: { js: banner },
    plugins: [{
      name: "bounded-synthetic-redis",
      setup(build) {
        build.onResolve({ filter: /(^@\/lib\/redis$|\/lib\/redis(?:\.ts)?$)/ }, () => ({ path: "redis", namespace: "g6-memory" }));
        build.onLoad({ filter: /.*/, namespace: "g6-memory" }, () => ({
          loader: "js", resolveDir: root,
          contents: `
            import { MemoryRedis } from ${JSON.stringify(join(root, "lib/redis-memory.ts"))};
            export const store = new MemoryRedis();
            export const isRedisConfigured = () => true;
            export async function redisPipeline(commands) {
              const m = globalThis.__tDeveloperHelp;
              if (!Array.isArray(commands) || m.commands + commands.length > ${ceiling.commands}) throw new Error("G6 command ceiling");
              m.commands += commands.length;
              return store.pipeline(commands);
            }
            export async function redisPipelineBase64(commands) {
              const encode = value => typeof value === "string" ? (value === "OK" ? value : Buffer.from(value).toString("base64")) : Array.isArray(value) ? value.map(encode) : value;
              return (await redisPipeline(commands)).map(encode);
            }
          `,
        }));
      },
    }],
    alias: { "@": root },
  });
  const result = spawnSync(process.execPath, [bundle], {
    cwd: root, encoding: "utf8", timeout: ceiling.milliseconds, maxBuffer: ceiling.logBytes,
    env: { PATH: process.env.PATH, NIMBUS_DATA_KEY: "g6-synthetic-contract-proof-only", NODE_ENV: "test" },
  });
  const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (Buffer.byteLength(log) > ceiling.logBytes) throw new Error("G6 output ceiling");
  process.stdout.write(log);
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(out, { recursive: true, force: true });
}
