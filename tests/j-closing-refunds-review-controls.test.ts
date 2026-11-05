/** Independent Codex J review controls for #2559/419765c5.
 * Bundle harness adapted with credit from Claude 4 closing-refunds-unknown.test.ts.
 * Page, closing state and paid-period reader remain real; request/layout and Redis transport are synthetic.
 * No provider operation or browser is exercised. */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { done, is, part } from "./check";

type MemoryRedis = { pipeline: (commands: (string | number)[][]) => Promise<unknown[]>; clear: () => void };
type World = {
  redis: MemoryRedis;
  who: { store: unknown; role: "owner" | "admin" | "editor" | "support" };
  render: () => Promise<string>;
  FINAL_INDEX: string;
  paidKey: (folder: string) => string;
  workKey: (folder: string) => string;
  storeFolder: (email: string) => Promise<string>;
  storeRef: (store: unknown) => string;
};

const ENTRY = `
export { store as redis } from "./redis-stub";
export { who } from "./plan-refund-route-world";
export { FINAL_INDEX, paidKey, workKey } from "@/lib/closing-holds";
export { storeFolder, storeRef } from "@/lib/store";
import { renderToStaticMarkup } from "react-dom/server";
import ClosingRefundsPage from "@/app/studio/closing-refunds/page";
export const render = async () => renderToStaticMarkup(await ClosingRefundsPage({ searchParams: Promise.resolve({}) }));
`;

async function world(): Promise<{ world: World; cleanup: () => void }> {
  const root = process.cwd();
  const here = join(root, "tests");
  const req = createRequire(join(root, "package.json"));
  const { buildSync } = req("esbuild") as typeof import("esbuild");
  const config = (await import(pathToFileURL(join(here, "test-config.mjs")).href)) as { testAliases: (file: string, root: string, here: string) => Record<string, string> };
  const pageWorld = join(here, "meeting-withdrawal-page-world.ts");
  const out = mkdtempSync(join(tmpdir(), "closing-refunds-unknown-"));
  // The real studio routing, with only the signed-in view taken from the stand-in.
  const route = join(out, "studio-route.ts");
  writeFileSync(route, `export * from ${JSON.stringify(join(root, "lib/studio-route.ts"))};\nexport { studioView } from ${JSON.stringify(join(here, "plan-refund-route-world.ts"))};\n`);
  const alias = {
    ...config.testAliases("closing-refunds-unknown.test.ts", root, here),
    "@/lib/studio-route": route,
    "next/headers": pageWorld,
    "next/navigation": pageWorld,
    "@/components/studio-header": pageWorld,
  };
  const file = join(out, "world.cjs");
  const built = buildSync({ stdin: { contents: ENTRY, resolveDir: here, loader: "tsx", sourcefile: "closing-refunds-world.tsx" }, bundle: true, platform: "node", format: "cjs", write: false, logLevel: "error", alias });
  writeFileSync(file, built.outputFiles[0].text);
  return { world: req(file) as World, cleanup: () => rmSync(out, { recursive: true, force: true }) };
}

const DAY_MS = 86_400_000;
async function main() {
  const { world: w, cleanup } = await world();
  const priorFetch = globalThis.fetch;
  let externalCalls = 0;
  globalThis.fetch = async () => { externalCalls += 1; throw Error("Unexpected external call in SSR-only control"); };
  const pipeline = w.redis.pipeline.bind(w.redis);
  let failOn = "";
  w.redis.pipeline = async (commands) => {
    if (failOn && commands.some((c) => c[0] === failOn)) throw Error("Synthetic unreadable " + failOn);
    return pipeline(commands);
  };
  try {
    const store = { sid: "jreviewrefunds", email: "owner@example.com", name: "Harbor", handle: "harbor" };
    w.who.store = store;
    w.who.role = "owner";
    const ref = w.storeRef(store), paid = w.paidKey(await w.storeFolder(ref));
    const now = Math.floor(Date.now() / 1000);
    part("Unknown closing never exposes an actionable refund form");
    failOn = "ZSCORE";
    const unknownClosing = await w.render();
    failOn = "";
    is("unknown closing retains retry guidance and removes table, button and form", [unknownClosing.includes("We could not check"), unknownClosing.includes("reload"), /<table|<button|<form/.test(unknownClosing)], [true, true, false]);
    part("A known closing with unreadable payments never exposes an actionable refund form");
    await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - DAY_MS, ref]]);
    failOn = "HGETALL";
    const unknownPayments = await w.render();
    failOn = "";
    is("unknown payments retain retry and manual fallback with no controls", [unknownPayments.includes("We could not read"), unknownPayments.includes("not listed, refund them in Stripe"), /<table|<button|<form/.test(unknownPayments)], [true, true, false]);
    part("Settled paid periods do not resurrect a refund button or claim no member paid");
    for (const status of ["done", "none", "disputed", "over"]) {
      w.redis.clear();
      await w.redis.pipeline([["ZADD", w.FINAL_INDEX, Date.now() - DAY_MS, ref], ["HSET", paid, "sub_jmember01", JSON.stringify({inv:"in_jmember01",amt:1200,cur:"usd",ps:now-86400,pe:now+86400,e:"member@example.com",r:status})]]);
      const settled = await w.render();
      is("settled " + status + " is unlisted with manual fallback, never an all-member claim", [settled.includes("This page lists no refund to make"), settled.includes("not listed, refund them in Stripe"), /<table|<button|<form/.test(settled), settled.includes("No member has paid")], [true,true,false,false]);
    }
    is("SSR review controls made no provider request", externalCalls, 0);
  } finally {
    w.redis.pipeline = pipeline;
    globalThis.fetch = priorFetch;
    cleanup();
  }
  done();
}
void main();
