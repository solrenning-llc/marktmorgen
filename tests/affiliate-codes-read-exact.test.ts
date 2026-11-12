/**
 * The codes a creator gave to affiliates, read only in their exact shape (CX-123 rule 24; audit R24 round 5,
 * finding 2). Synthetic only: the in-memory Redis double, through the real noteSession.
 *
 * codeOwners (lib/affiliate-codes.ts) reads `nl:aff:<id>:promo` with HGETALL. A reply in another shape (a string,
 * a list with a non-string member, an odd list, an object, a lost reply) used to read as "no code given to anybody".
 * noteSession then fell through to the buyer's bond and the lead, and a sale made with Ben's code was written for
 * Ana with HSETNX (the first write stands for ever): the commission went to the wrong affiliate and Ben got nothing.
 * Now codeOwners throws UnknownReplyError and noteSession writes no sale for that order. It is written once a later
 * call reads the codes: the thanks page called again, or the checkout sweep (lib/checkout-sweep.ts), which counts the
 * order as failed and reads it again on its next pass, but only within its window (CONFIRM_WITHIN_SECONDS, a day).
 * A sale with no code never depends on the codes read (Claude 2, first money review of #3238, MEDIUM 1): it still
 * goes to the buyer's bond or lead when the codes reply is unknown. A confirmed empty hash still means "no codes",
 * and the healthy read is unchanged.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { noteSession, readBook } from "@/lib/affiliates";
import { bondFor, rememberBuyer } from "@/lib/affiliate-bond";
import { codeOwnerCount, codeOwners, giveCode } from "@/lib/affiliate-codes";
import { UnknownReplyError } from "@/lib/redis-reply";
import { claimHandle, ensureStatsId, setAffiliateSetting, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_affiliate_codes_exact";
process.env.RESEND_API_KEY = "re_test_affiliate_codes_exact";

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  if (url.hostname === "api.resend.com") return answer({ id: "email_1" });
  return answer({ object: "list", data: [], has_more: false });
}) as typeof fetch;

const OWNER = "baker@example.com";
const NOW = Math.floor(Date.now() / 1000);
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const PROMO = "promo_1TestBenCode001";
const BUYER = "kai@example.com";

type Shape = { name: string; reply: () => unknown } | null;
let shape: Shape = null;
let hlen: (() => unknown) | null = null;
const real = redis.pipeline.bind(redis);
redis.pipeline = (async (commands: (string | number)[][]) => {
  const one = commands.length === 1 ? commands[0] : null;
  if (shape && one?.[0] === "HGETALL" && /^nl:aff:[^:]+:promo$/.test(String(one[1]))) return shape.reply();
  if (hlen && one?.[0] === "HLEN" && /^nl:aff:[^:]+:promo$/.test(String(one[1]))) return hlen();
  return real(commands);
}) as typeof redis.pipeline;

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" });

const order = (id: string, discounts: unknown[]) => ({
  id,
  mode: "payment",
  status: "complete",
  payment_status: "paid",
  created: NOW + 600,
  amount_total: 5_000,
  amount_subtotal: 5_000,
  currency: "usd",
  total_details: { amount_tax: 0 },
  payment_intent: `pi_${id}`,
  metadata: { store: "oven", product: "prod01", title: "Bread course" },
  customer_details: { email: BUYER },
  discounts,
});

async function thrown(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "no error";
  } catch (error) {
    return error instanceof UnknownReplyError ? "UnknownReplyError" : `other: ${String(error)}`;
  }
}

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "oven", "Oven Kitchen", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestCodesExact", true);
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30, lifetime: true }));
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEN, person(BEN, "ben@example.com", "ben")],
    ["HSET", `nl:aff:${statsId}:codes`, "ben", BEN],
  ]);
  const line = async (ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);

  part("Control: a confirmed empty hash is no codes, and the bond credits the sale");
  await rememberBuyer(store, BUYER, ANA, "last");
  is("the buyer is bonded to Ana", await bondFor(store, BUYER), ANA);
  shape = { name: "empty", reply: () => [[]] };
  is("an empty list is an empty map", (await codeOwners(store)).size, 0);
  shape = null;
  await noteSession(store, order("cs_none", []));
  is("no code on the order: the sale goes to the bond", [(await line("cs_none"))?.aff, (await line("cs_none"))?.how], [ANA, "buyer"]);

  part("Unknown shapes refuse, and no sale is written for anybody");
  await giveCode(store, PROMO, BEN);
  store = (await storeForEmail(OWNER))!;
  const shapes: Exclude<Shape, null>[] = [
    { name: "a string", reply: () => ["x"] },
    { name: "a list of numbers", reply: () => [[1, 2]] },
    { name: "an odd list", reply: () => [[PROMO, BEN, "stray"]] },
    { name: "an object", reply: () => [{ [PROMO]: BEN }] },
    { name: "a lost reply", reply: () => [undefined] },
    { name: "QUEUED", reply: () => ["QUEUED"] },
    { name: "no reply at all", reply: () => [] },
    { name: "two replies for one command", reply: () => [[PROMO, BEN], []] },
    { name: "a null member", reply: () => [[PROMO, null]] },
  ];
  for (const one of shapes) {
    // Each shape starts from the buyer bonded to Ana, so one case's wrong credit (which moves the bond) cannot hide the next.
    await rememberBuyer(store, BUYER, ANA, "last");
    shape = one;
    is(`${one.name}: codeOwners throws UnknownReplyError`, await thrown(() => codeOwners(store)), "UnknownReplyError");
    const ref = `cs_${one.name.replace(/[^a-z]/g, "")}`;
    is(`${one.name}: noteSession refuses instead of crediting the bond`, await thrown(() => noteSession(store, order(ref, [{ promotion_code: PROMO }]))), "UnknownReplyError");
    shape = null;
    is(`${one.name}: no sale written for anybody`, await line(ref), undefined);
    is(`${one.name}: the buyer's bond is unchanged`, await bondFor(store, BUYER), ANA);
  }

  part("A sale with no code never reads the codes: an unknown reply leaves the bond's credit alone (MEDIUM 1)");
  for (const one of shapes) {
    await rememberBuyer(store, BUYER, ANA, "last");
    shape = one;
    const ref = `cs_nocode_${one.name.replace(/[^a-z]/g, "")}`;
    is(`${one.name}: a sale with no code is written`, await thrown(() => noteSession(store, order(ref, []))), "no error");
    shape = null;
    is(`${one.name}: it goes to the bonded affiliate`, [(await line(ref))?.aff, (await line(ref))?.how], [ANA, "buyer"]);
  }
  // A bare coupon the creator applied (no promotion code) is no code either.
  await rememberBuyer(store, BUYER, ANA, "last");
  shape = shapes[4];
  is("a bare coupon with an unknown codes reply: written", await thrown(() => noteSession(store, order("cs_coupon", [{ coupon: "co_x", promotion_code: null }]))), "no error");
  shape = null;
  is("a bare coupon: the sale goes to the bond", [(await line("cs_coupon"))?.aff, (await line("cs_coupon"))?.how], [ANA, "buyer"]);
  // The owners a caller passed in are used as given, without a read: the sweep reads them once for many orders.
  await rememberBuyer(store, BUYER, ANA, "last");
  shape = shapes[4];
  is("owners passed in: no read, the code's owner is credited", await thrown(() => noteSession(store, order("cs_given", [{ promotion_code: PROMO }]), new Map([[PROMO, BEN]]))), "no error");
  shape = null;
  is("owners passed in: the sale is Ben's, through his code", [(await line("cs_given"))?.aff, (await line("cs_given"))?.how], [BEN, "code"]);

  part("The next pass reads the codes exactly and credits the code's owner");
  shape = null;
  is("healthy read: the code belongs to Ben", [...(await codeOwners(store)).entries()], [[PROMO, BEN]]);
  await noteSession(store, order("cs_alost", [{ promotion_code: PROMO }]));
  is("the sale refused earlier is now Ben's, through his code", [(await line("cs_alost"))?.aff, (await line("cs_alost"))?.how], [BEN, "code"]);
  await redis.pipeline([["HSET", `nl:aff:${statsId}:promo`, "not-a-promo-id", ANA]]);
  is("a field that is not a promotion code id is still passed over", [...(await codeOwners(store)).entries()], [[PROMO, BEN]]);

  part("The count read before the affiliate page reads the codes: unknown is null (refused), never 0 (LOW 1)");
  is("healthy count: the two fields", await codeOwnerCount(store), 2);
  for (const [name, reply] of [["null", [null]], ["an empty string", [""]], ["false", [false]], ["a numeric string", ["2"]], ["a negative", [-1]], ["a fraction", [1.5]], ["a lost reply", [undefined]], ["no reply", []], ["two replies", [2, 2]]] as [string, unknown][]) {
    hlen = () => reply;
    is(`${name}: the count is null, so the page is refused rather than under-reserved`, await codeOwnerCount(store), null);
  }
  hlen = null;
  is("the count reads again once the reply is whole", await codeOwnerCount(store), 2);

  part("The callers that decide a sale never turn the refusal into an empty map");
  const sweep = readFileSync(join(process.cwd(), "lib/checkout-sweep.ts"), "utf8");
  // The sweep reads them only when an order on the page carries a code, and a failed read is null there, never an
  // empty map: those orders are counted as failed and wait (tests/affiliate-codes-sweep.test.ts drives it).
  is("the sweep never catches the codes read to an empty map", /codeOwners\(store\)\.catch\(\([^)]*\)\s*=>\s*new Map/.test(sweep), false);
  is("the sweep reads the codes only for a page with a code on it, an unread one as null", /coded \? codeOwners\(store\)\.catch\(unread\(/.test(sweep), true);
  const affiliates = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  is("noteSession reads them without a catch, and only for a sale with a code", /promoCodesOn\(session\)\.length \? \(owners \?\? \(await codeOwners\(store\)\)\)/.test(affiliates), true);
}

main().then(done, (error) => {
  console.error(error);
  process.exitCode = 1;
});
