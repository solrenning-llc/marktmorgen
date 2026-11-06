import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, launch, runLaunches, setSoon } from "@/lib/waitlist";
import { previewKnown } from "@/lib/tier-switch";
import { dueNow } from "@/lib/tier-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const single: { text: string }[] = [];
const batches: unknown[][] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input)); if (process.env.PROBE_DEBUG) console.log("fetch", String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as unknown[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") { single.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ id: "email_1" })); }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
const tokenIn = (t: string) => t.match(/token=([0-9a-f]{48})/)?.[1] ?? "";
const real = redis.pipeline.bind(redis);
function patch(match: (c: (string | number)[]) => boolean, reply: unknown) {
  redis.pipeline = (async (cmds: (string | number)[][]) => { const r = await real(cmds); return r.map((v, i) => (match(cmds[i]) ? reply : v)); }) as typeof redis.pipeline;
}
const unpatch = () => { redis.pipeline = real as typeof redis.pipeline; };

let n = 0;
async function setup(_owner: string, _handle: string) {
  const owner = "owner@example.com";
  if (!(await storeForEmail(owner))) { await claimHandle(owner, "harbor", "Harbor Kitchen", ""); await ensureStatsId(owner); await ensureListId(owner); }
  const made = await addProduct(owner, `The Bread Book ${++n}`, "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  for (const [i, e] of ["dana@example.com", "hal@example.com"].entries()) {
    const before = single.length;
    const j = await joinWaitlist({ store, product, email: e, consent: false, ip: `5.5.${n}.${i}`, origin: "https://marktmorgen.com" });
    if (j !== "sent") throw new Error(`join ${e}: ${String(j)}`);
    await confirmSpot(tokenIn(single[before].text), store);
  }
  return { store, product, load: async () => (await storeForEmail(owner))! };
}

async function main() {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  part("tier: dueNow on a preview without lines is guarded");
  const at = 1_800_000_000;
  const noLines = { currency: "usd", starting_balance: 0 };
  is("dueNow alone reads 0", dueNow(noLines, at), 0);
  is("previewKnown refuses it first", previewKnown(noLines), false);
  is("previewKnown refuses lines without has_more", previewKnown({ currency: "usd", lines: { data: [] } }), false);

  part("waitlist: HMGET unknown shape during a launch");
  const A = await setup("p1@example.com", "probeone");
  const sidA = A.store.statsId!;
  is("launched", (await launch(A.store, A.product, { note: "", address: "1 Main St, Portland, OR 97201" })).ok, true);
  patch((c) => c[0] === "HMGET", "garbage");
  const sentA = await runLaunches(A.load, readListing, Date.now() + 10_000);
  unpatch();
  is("emails sent on an unknown HMGET", [sentA, batches.length], [0, 0]);
  is("confirmed list deleted anyway", redis.run(["HLEN", `nl:wl:${sidA}:${A.product.id}`]), 0);
  is("job marked finished", Boolean(JSON.parse(String(redis.run(["GET", `nl:wl:${sidA}:${A.product.id}:job`]))).finished), true);

  part("waitlist: GET job unknown shape in runLaunches");
  const B = await setup("p2@example.com", "probetwo");
  const sidB = B.store.statsId!;
  await launch(B.store, B.product, { note: "", address: "1 Main St, Portland, OR 97201" });
  patch((c) => c[0] === "GET" && String(c[1]).endsWith(":job"), 42);
  await runLaunches(B.load, readListing, Date.now() + 10_000);
  unpatch();
  is("job dropped from the run set", redis.run(["SISMEMBER", "nl:wl:jobs", `${sidB}|${B.product.id}`]), 0);
  const before = batches.length;
  const later = await runLaunches(B.load, readListing, Date.now() + 10_000);
  is("later healthy runs never send it", [later, batches.length - before], [0, 0]);

  part("waitlist: GET job unknown shape in launch while running");
  const C = await setup("p3@example.com", "probethree");
  await launch(C.store, C.product, { note: "", address: "1 Main St, Portland, OR 97201" });
  patch((c) => c[0] === "GET" && String(c[1]).endsWith(":job"), 42);
  const again = await launch(C.store, C.product, { note: "", address: "1 Main St, Portland, OR 97201" });
  unpatch();
  is("a running launch is not busy on unknown", again.ok ? "launched" : again.reason, "launched");
  done();
}
main();
