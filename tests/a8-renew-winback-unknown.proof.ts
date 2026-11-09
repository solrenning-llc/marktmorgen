/**
 * A8 proof (CX-123 rule 24, MÉDIO, not fixed here): a come-back link whose
 * stored grant comes back from Redis in an unknown shape is told to the buyer
 * as an offer that "has ended", and the button's door answers "expired".
 *
 * lib/winback-send.ts, readWinBack: `typeof raw !== "string"` and the
 * `JSON.parse` catch both return null, the same answer as an absent key; and
 * app/[handle]/renew/[product]/page.tsx turns a thrown read into the same
 * null with `.catch(() => null)`. The page then prints offerNotices.expired:
 * "This offer has ended. You can still come back at the usual price below."
 * Only an absent key (null) is "nothing there".
 *
 * Each check below states the honest outcome, so it FAILS on main today.
 * Synthetic store, synthetic grant, one injected reply per case; no network.
 * Run: node <scratchpad>/run-one.mjs <worktree> a8-renew-winback-unknown.proof.ts
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import { addProduct, claimHandle, ensureStatsId, storeForEmail } from "@/lib/store";
import { openWinBack, readWinBack } from "@/lib/winback-send";
import { membershipWords } from "@/lib/buyer-words/membership";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { answering } from "./security/next-headers";

type Command = (string | number)[];
const TOKEN = "a8".repeat(20);
const LINK = `nl:wb:link:${TOKEN}`;
const real = redis.pipeline.bind(redis);
let inject: ((batch: Command[]) => unknown[] | Promise<unknown[]>) | null = null;
redis.pipeline = (async (batch: Command[]) => {
  if (inject && batch.some((c) => c[0] === "GET" && c[1] === LINK)) return inject(batch);
  return real(batch);
}) as typeof redis.pipeline;
globalThis.fetch = (async () => {
  throw new Error("No external provider in the A8 proof");
}) as typeof fetch;

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  redis.clear();
  const owner = "a8-renew-proof@example.test";
  await claimHandle(owner, "a8renewproof", "A8 Renew Proof", "");
  await ensureStatsId(owner);
  const made = await addProduct(owner, "Synthetic Club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("product fixture");
  const store = (await storeForEmail(owner))!;
  const product = made.product.id;
  const ended = membershipWords(store.language).offerNotices.expired;
  const grant = JSON.stringify({ s: store.statsId, e: "buyer@example.test", p: product, o: "", c: "co_A8Proof0001", pc: 25, m: 2 });
  const renew = async () => {
    answering(new NextRequest(`https://marktmorgen.com/@a8renewproof/renew/${product}?back=${TOKEN}`));
    return html((await RenewPage({ params: Promise.resolve({ handle: "@a8renewproof", product }), searchParams: Promise.resolve({ back: TOKEN }) })) as React.ReactElement);
  };

  part("Control: an absent link is the only 'nothing there'");
  is("an absent key reads as no grant", await readWinBack(store, product, TOKEN), null);
  is("and the page says the offer has ended", (await renew()).includes(ended), true);
  await real([["SET", LINK, grant, "EX", 86_400]]);
  is("a kept grant reads back whole", (await readWinBack(store, product, TOKEN))?.coupon, "co_A8Proof0001");

  const cases: [string, (batch: Command[]) => unknown[] | Promise<unknown[]>][] = [
    ["a GET answered with a number", () => [7, 86_400]],
    ["a GET answered with half a JSON record", () => ["{\"s\":", 86_400]],
    ["a GET answered with an array", () => [[grant], 86_400]],
    ["a pipeline answered with no replies", () => []],
    ["a pipeline that throws", () => Promise.reject(new Error("synthetic Redis failure"))],
  ];
  for (const [name, reply] of cases) {
    part(`Unknown: ${name}`);
    inject = reply;
    const read = await readWinBack(store, product, TOKEN).then(
      (value) => (value === null ? "absent" : "grant"),
      () => "unknown",
    );
    is("readWinBack says the reading is unknown, never 'absent'", read, "unknown");
    is("the renew page never tells the buyer the offer has ended", (await renew()).includes(ended), false);
    const opened = await openWinBack(store, product, TOKEN, "https://marktmorgen.com").then(
      (r) => (r.ok ? "opened" : r.reason),
      () => "unknown",
    );
    is("the button's door never answers 'expired' for an unknown reading", opened === "expired", false);
    inject = null;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
