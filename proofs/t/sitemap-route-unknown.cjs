/** Opt-in causal evidence; no production source is changed. */
async function main() {
const fs = await import("node:fs");
const os = await import("node:os");
const path = await import("node:path");
const { createHash } = await import("node:crypto");
const { createRequire } = await import("node:module");
const { pathToFileURL } = await import("node:url");
const { spawnSync } = await import("node:child_process");
const LEGACY = "/** Opt-in evidence only: actual catalogue writers/readers and sitemap, synthetic Redis replies. */\nimport assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { addProduct, claimHandle, ensureStatsId, storeForEmail } from \"@/lib/store\";\nimport { productWrites } from \"@/lib/catalog\";\nimport { sitemapXml, storeSitemap } from \"@/lib/store-sitemap\";\nimport { store as redis } from \"./redis-stub\";\n\nredis.clear();\nconst catalogId = \"a\".repeat(32);\nconst fixture = (async () => {\n  const owner = \"sitemap-proof@example.test\";\n  assert.equal((await claimHandle(owner, \"sitemapreplyproof\", \"Fictional map\", \"Synthetic evidence.\")).ok, true);\n  await ensureStatsId(owner);\n  const first = await addProduct(owner, \"Fictional first guide\", \"\", \"12\", null);\n  const second = await addProduct(owner, \"Fictional second guide\", \"\", \"12\", null);\n  assert.ok(first.ok && second.ok);\n  const shop = await storeForEmail(owner);\n  assert.ok(shop);\n  await redis.pipeline([...productWrites(catalogId, first.product), ...productWrites(catalogId, second.product)]);\n  // Same published inventory; only its carried cards are removed to exercise the real external catalogue read.\n  return { ...shop, catalog: { ...shop.catalog, id: catalogId, head: [], inline: null } };\n})();\n\nconst listingReads = (commands: Parameters<typeof redis.pipeline>[0]) => commands.length === 2 && commands.every(c => c[0] === \"GET\" && String(c[1]).startsWith(`nl:catalog:${catalogId}:l:`));\n\ntest(\"healthy actual sitemap contains both published products and serializes them\", async () => {\n  const entries = await storeSitemap(await fixture);\n  const xml = sitemapXml(entries);\n  assert.equal(entries.filter(e => e.url.includes(\"/p/\")).length, 2);\n  assert.match(xml, /fictional-first-guide/);\n  assert.match(xml, /fictional-second-guide/);\n});\n\nfor (const mode of [\"missing-envelope\", \"partial-envelope\", \"extra-envelope\", \"malformed-record\"] as const) {\n  test(`actual sitemap must not certify a complete map after ${mode}`, async context => {\n    const shop = await fixture;\n    const original = redis.pipeline;\n    let intercepted = 0;\n    redis.pipeline = async commands => {\n      const reply = await original.call(redis, commands);\n      if (!listingReads(commands)) return reply;\n      intercepted += 1;\n      if (mode === \"missing-envelope\") return [];\n      if (mode === \"partial-envelope\") return reply.slice(0, 1);\n      if (mode === \"extra-envelope\") return [...reply, null];\n      return [reply[0], \"{\"];\n    };\n    try {\n      await assert.rejects(async () => {\n        const entries = await storeSitemap(shop);\n        const xml = sitemapXml(entries);\n        context.diagnostic(JSON.stringify({ mode, productUrls: entries.filter(e => e.url.includes(\"/p/\")).map(e => e.url), validXmlEnvelope: xml.startsWith(\"<?xml\") && xml.includes(\"</urlset>\") }));\n      }, \"unknown catalogue became successful XML\");\n    } finally {\n      redis.pipeline = original;\n      assert.equal(intercepted, 1);\n    }\n  });\n}\n\ntest(\"an explicitly absent product remains distinct from a missing reply slot\", async () => {\n  const shop = await fixture;\n  const original = redis.pipeline;\n  redis.pipeline = async commands => {\n    const reply = await original.call(redis, commands);\n    return listingReads(commands) ? [reply[0], null] : reply;\n  };\n  try {\n    const entries = await storeSitemap(shop);\n    assert.equal(entries.filter(e => e.url.includes(\"/p/\")).length, 1);\n  } finally { redis.pipeline = original; }\n});\n\ntest(\"a thrown catalogue transport error already prevents a successful map\", async () => {\n  const shop = await fixture;\n  const original = redis.pipeline;\n  redis.pipeline = async commands => {\n    if (listingReads(commands)) throw new Error(\"Synthetic catalogue transport failure\");\n    return original.call(redis, commands);\n  };\n  try { await assert.rejects(() => storeSitemap(shop), /Synthetic catalogue transport failure/); }\n  finally { redis.pipeline = original; }\n});\n";
const LEGACY_BLOB = "3b66e82898be9eb89fd2407491693671ab3734d7";
const HTTP_BLOB = "b136014c0c5c3bedc5769e7c2a64b4118ee4513a";
const LIMIT = Object.freeze({ children: 2, cases: 14, commandsPerChild: 2000, commandsTotal: 5000, milliseconds: 120000, logBytes: 256 * 1024 });
const HTTP_FILE = "store-sitemap-exact-read.test.ts";
function gitBlob(text) {
  const bytes = Buffer.from(text);
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
async function prohibitNetwork() {
  globalThis.__tSitemap = { commands: 0, networkAttempts: 0 };
  const denied = () => { globalThis.__tSitemap.networkAttempts++; throw new Error("Synthetic proof: network prohibited"); };
  globalThis.fetch = async () => denied();
  (await import("node:net")).Socket.prototype.connect = denied;
  (await import("node:tls")).default.connect = denied;
  for (const name of ["node:http", "node:https"]) {
    const api = (await import(name)).default;
    api.request = denied;
    api.get = denied;
  }
}
async function compile(source, kind, output, milliseconds) {
  // Block before loading any production/dependency graph in the local compiler.
  await prohibitNetwork();
  const root = path.resolve(__dirname, "../..");
  const http = fs.readFileSync(path.join(root, "tests", HTTP_FILE), "utf8");
  if (gitBlob(LEGACY) !== LEGACY_BLOB || gitBlob(http) !== HTTP_BLOB) throw new Error("Evidence test blob changed");
  const requireSource = createRequire(path.join(source, "package.json"));
  const esbuild = await import(pathToFileURL(requireSource.resolve("esbuild")));
  const { testAliases } = await import(pathToFileURL(path.join(source, "tests/test-config.mjs")));
  const file = kind === "legacy" ? "t-sitemap-listing-unknown.proof.ts" : HTTP_FILE;
  const aliases = testAliases(file, source, path.join(source, "tests"));
  if (kind === "http") {
    aliases["@/lib/store"] = path.join(source, "tests", HTTP_FILE);
    aliases["@/lib/traffic"] = path.join(source, "tests", HTTP_FILE);
  }
  const banner = `;(async()=>{await (${prohibitNetwork.toString()})();process.once("exit",()=>console.log("T_SITEMAP_METRICS "+JSON.stringify(globalThis.__tSitemap)));`;
  const options = {
    bundle: true, platform: "node", format: "cjs", outfile: output,
    logLevel: "error", alias: aliases, banner: { js: banner }, footer: { js: "})();" },
    plugins: [{ name: "bounded-sitemap-evidence", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => kind === "http" &&
        (args.path === "t-http-world" || args.path === "@/lib/store" || args.path === "@/lib/traffic" || args.path.endsWith("/" + HTTP_FILE))
        ? { path: "world", namespace: "t-http-world" } : undefined);
      builder.onLoad({ filter: /.*/, namespace: "t-http-world" }, () => ({ contents: http, loader: "ts", resolveDir: path.join(source, "tests") }));
      builder.onLoad({ filter: /redis-stub[.]ts$/ }, args => ({
        loader: "ts", resolveDir: path.join(source, "tests"),
        contents: fs.readFileSync(args.path, "utf8") + `\nconst tOriginalPipeline=store.pipeline.bind(store);store.pipeline=async(commands)=>{if(globalThis.__tSitemap.commands+commands.length>${LIMIT.commandsPerChild})throw new Error("Synthetic command ceiling");globalThis.__tSitemap.commands+=commands.length;return tOriginalPipeline(commands);};`,
      }));
    }}],
  };
  if (kind === "legacy") options.stdin = { contents: LEGACY, resolveDir: path.join(source, "tests"), sourcefile: file, loader: "ts" };
  else options.entryPoints = ["t-http-world"];
  let timer;
  try {
    await Promise.race([esbuild.build(options), new Promise((_, reject) => { timer = setTimeout(() => { esbuild.stop(); reject(new Error("Compile deadline")); }, milliseconds); })]);
  } finally { clearTimeout(timer); }
}
async function run() {
  const args = process.argv.slice(2);
  if (![1, 3].includes(args.length) || (args.length === 3 && args[1] !== "--suite")) throw new Error("Usage: node proofs/t/sitemap-route-unknown.cjs SOURCE_CHECKOUT [--suite http|legacy|all]");
  const source = fs.realpathSync(args[0]);
  const suite = args[2] ?? "all";
  if (!["all", "http", "legacy"].includes(suite)) throw new Error("Unknown suite");
  const kinds = suite === "all" ? ["legacy", "http"] : [suite];
  // Reserve the maximum for both suites BEFORE compiling or dispatching tests.
  const reserved = { children: LIMIT.children, cases: LIMIT.cases, commands: LIMIT.children * LIMIT.commandsPerChild };
  if (kinds.length > reserved.children || reserved.cases > 40 || reserved.commands > LIMIT.commandsTotal) throw new Error("Invalid pre-dispatch reservation");
  const started = Date.now();
  let bytes = 0, cases = 0, commands = 0, failures = 0;
  const remaining = () => {
    const value = LIMIT.milliseconds - (Date.now() - started);
    if (value <= 0) throw new Error("120s total ceiling");
    return value;
  };
  const emit = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > LIMIT.logBytes) throw new Error("Combined 256KiB log ceiling");
    process.stdout.write(text);
  };
  emit("T_SITEMAP_RESERVATION " + JSON.stringify({ ...reserved, milliseconds: LIMIT.milliseconds, logBytes: LIMIT.logBytes, source, suite }) + "\n");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "t-sitemap-route-proof-"));
  try {
    const { testEnvironment } = await import(pathToFileURL(path.join(source, "tests/test-config.mjs")));
    const environment = testEnvironment({ PATH: process.env.PATH, NIMBUS_DATA_KEY: "t-sitemap-exact-proof-only", FORCE_COLOR: "0" });
    for (const kind of kinds) {
      const bundle = path.join(out, kind + ".cjs");
      await compile(source, kind, bundle, remaining());
      const child = spawnSync(process.execPath, [bundle], { cwd: source, env: environment, encoding: "utf8", timeout: remaining(), maxBuffer: Math.floor((LIMIT.logBytes - bytes) / 2) });
      const log = (child.stdout ?? "") + (child.stderr ?? "");
      emit("=== " + kind + " ===\n" + log);
      if (child.error) throw child.error;
      const metric = log.match(/T_SITEMAP_METRICS (\{[^\n]+\})/);
      const count = log.match(/(?:#|ℹ) tests (\d+)/);
      if (!metric || !count) throw new Error("Missing actual accounting");
      const actual = JSON.parse(metric[1]);
      if (actual.networkAttempts !== 0 || actual.commands > LIMIT.commandsPerChild || Number(count[1]) !== 7) throw new Error("Evidence boundary violated");
      commands += actual.commands;
      cases += Number(count[1]);
      if (commands > reserved.commands || cases > reserved.cases) throw new Error("Pre-dispatch reservation exceeded");
      failures += child.status === 0 ? 0 : 1;
      emit("T_SITEMAP_CHILD " + JSON.stringify({ kind, status: child.status, cases: Number(count[1]), commands: actual.commands, networkAttempts: actual.networkAttempts }) + "\n");
    }
    emit("T_SITEMAP_TOTAL " + JSON.stringify({ cases, commands, elapsedMilliseconds: Date.now() - started, networkAttempts: 0, failedSuites: failures }) + "\n");
    process.exitCode = failures ? 1 : 0; // RED is an honest non-zero result.
  } finally { fs.rmSync(out, { recursive: true, force: true }); }
}
await run();
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
