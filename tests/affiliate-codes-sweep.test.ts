/**
 * The affiliate block of the checkout sweep (lib/checkout-sweep.ts) when the codes given to affiliates cannot be read
 * (Claude 2, first money review of #3238, MEDIUM 2). Real sweep on the in-memory Redis; Stripe's list stubbed;
 * synthetic only.
 *
 * codeOwners throws UnknownReplyError on a reply it cannot read exactly. The sweep used to read the codes for every
 * page with a paid order, uncaught, before the buyers' confirmations: one unknown reply ended the store's whole pass,
 * so no confirmation went, the sales brought by a link were not written either, and the run said nothing had failed.
 * Now the codes are read only when an order on the page carries a promotion code; an unread reply is null, never an
 * empty map, so only the orders with a code wait, each counted as failed and read again on the next pass (the
 * referral write is HSETNX, so the retry records the commission once). Everything else in the pass goes on.
 */
import { NO_AFFILIATES, parseAffiliateSetting } from "@/lib/affiliate-setting";
import { readBook } from "@/lib/affiliates";
import { giveCode } from "@/lib/affiliate-codes";
import { sweepCheckouts } from "@/lib/checkout-sweep";
import { addProduct, claimHandle, ensureStatsId, setAffiliateSetting, setMailSettings, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";
import { installSesMailFixture } from "./ses-mail-fixture";

let sessions: unknown[] = [];
const mail = installSesMailFixture({
  fallback: (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/checkout/sessions") return new Response(JSON.stringify({ object: "list", data: sessions, has_more: false }));
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }));
  },
});

const OWNER = "sweep-codes@example.com";
const ANA = "aaaaaaaaaaaa";
const BEN = "bbbbbbbbbbbb";
const PROMO = "promo_1TestSweepBen001";
const NOW = Math.floor(Date.now() / 1000);

const person = (id: string, email: string, code: string) =>
  JSON.stringify({ id, email, code, status: "approved", appliedAt: (NOW - 30 * 86_400) * 1000, decidedAt: 1, note: "" });

async function main(): Promise<void> {
  redis.clear();
  mail.configure();
  await mail.setReady(true, { max24: 50_000, rate: 100 });
  process.env.STRIPE_SECRET_KEY = "sk_test_conditions_only_a_stand_in";

  await claimHandle(OWNER, "sweepcodes", "Harbor Bakery", "");
  await ensureStatsId(OWNER);
  await setStripeAccount(OWNER, "acct_1TestSwpCodes", true);
  await setSubscription(OWNER, { customerId: "cus_SwpCodes1", subscriptionId: "sub_SwpCodes1", active: true, tier: "pro", period: paidPeriod() });
  await setMailSettings(OWNER, { fromName: "Harbor Bakery", address: "1 Main St, Portland, OR 97201" });
  await setAffiliateSetting(OWNER, parseAffiliateSetting({ ...NO_AFFILIATES, enabled: true, percent: 30 }));
  const course = await addProduct(OWNER, "Bread Course", "Twelve loaves.", "50", null);
  if (!course.ok) throw new Error("no product");
  await setProductLink(OWNER, course.product.id, "https://example.com/bread");
  let store = (await storeForEmail(OWNER))!;
  const statsId = store.statsId!;
  await redis.pipeline([
    ["HSET", `nl:aff:${statsId}:people`, ANA, person(ANA, "ana@example.com", "ana")],
    ["HSET", `nl:aff:${statsId}:codes`, "ana", ANA],
    ["HSET", `nl:aff:${statsId}:people`, BEN, person(BEN, "ben@example.com", "ben")],
    ["HSET", `nl:aff:${statsId}:codes`, "ben", BEN],
  ]);
  await giveCode(store, PROMO, BEN);
  store = (await storeForEmail(OWNER))!;

  const paid = (id: string, email: string, extra: { via?: string; discounts?: unknown[] }) => ({
    id, object: "checkout.session", status: "complete", payment_status: "paid", mode: "payment",
    created: NOW - 60, amount_total: 5_000, amount_subtotal: 5_000, currency: "usd", total_details: { amount_tax: 0 },
    payment_intent: `pi_${id}`, customer_details: { email },
    metadata: { store: "sweepcodes", product: course.product.id, title: "Bread Course", ...(extra.via ? { via: extra.via, via_rate: "30" } : {}) },
    discounts: extra.discounts ?? [],
  });
  const CODED = "cs_test_sweepcodesCoded001";
  const LINKED = "cs_test_sweepcodesLinked01";
  const line = async (ref: string) => (await readBook(store)).lines.find((l) => l.ref === ref);
  const sentTo = (email: string) => mail.ses.filter((m) => m.to.includes(email)).length;

  const real = redis.pipeline.bind(redis);
  let unknown = false;
  let codeReads = 0;
  redis.pipeline = (async (commands: (string | number)[][]) => {
    const one = commands.length === 1 ? commands[0] : null;
    if (one?.[0] === "HGETALL" && one[1] === `nl:aff:${statsId}:promo`) {
      codeReads += 1;
      if (unknown) return [undefined];
    }
    return real(commands);
  }) as typeof redis.pipeline;
  const errors = console.error;
  console.error = () => undefined;

  part("No order on the page carries a code: the codes are never read, an unknown reply changes nothing");
  sessions = [paid(LINKED, "lee@example.com", { via: ANA })];
  unknown = true;
  codeReads = 0;
  let counts = await sweepCheckouts(Date.now() + 20_000);
  is("the codes were not read", codeReads, 0);
  is("the sale brought by Ana's link is written for her", [(await line(LINKED))?.aff, (await line(LINKED))?.how], [ANA, "click"]);
  is("the buyer's confirmation went", sentTo("lee@example.com"), 1);
  is("nothing is counted as failed", counts.failed, 0);

  part("An order with a code, the codes unreadable: only that order waits, the rest of the pass goes on");
  sessions = [paid(CODED, "kai@example.com", { discounts: [{ promotion_code: PROMO }] }), ...sessions];
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("the codes were read (and answered in an unknown shape)", codeReads > 0, true);
  is("the sale with Ben's code is not written for anybody", await line(CODED), undefined);
  is("it is counted as failed, once", counts.failed, 1);
  is("its buyer's confirmation still went", sentTo("kai@example.com"), 1);
  is("the linked sale stays Ana's, written once", (await readBook(store)).lines.filter((l) => l.ref === LINKED).length, 1);

  part("The next pass reads the codes and credits the code's owner, once");
  unknown = false;
  counts = await sweepCheckouts(Date.now() + 20_000);
  console.error = errors;
  is("the sale is Ben's, through his code", [(await line(CODED))?.aff, (await line(CODED))?.how], [BEN, "code"]);
  is("nothing failed, and no confirmation went twice", [counts.failed, sentTo("kai@example.com"), sentTo("lee@example.com")], [0, 1, 1]);
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("another pass writes no second line", (await readBook(store)).lines.filter((l) => l.ref === CODED).length, 1);

  // Codex H2, second money review of #3238: a click wins over a code (noteSession never reads the codes when the
  // checkout's `via` is an affiliate id), so an order with both is decided without the codes and never waits on them.
  console.error = () => undefined;
  part("Ana's link and Ben's code on one order, the codes unreadable: the click decides, nothing waits");
  const BOTH = "cs_test_sweepcodesBoth0001";
  sessions = [paid(BOTH, "mia@example.com", { via: ANA, discounts: [{ promotion_code: PROMO }] })];
  unknown = true;
  codeReads = 0;
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("the sale is written for Ana, through her link", [(await line(BOTH))?.aff, (await line(BOTH))?.how], [ANA, "click"]);
  is("nothing is counted as failed", counts.failed, 0);
  is("the codes were not even read: every order with a code has a click", codeReads, 0);
  is("the buyer's confirmation went", sentTo("mia@example.com"), 1);

  part("A mixed page, the codes unreadable: only the order with a code and no click waits");
  const CODE_ONLY = "cs_test_sweepcodesCodeOnly1";
  const CLICK_ONLY = "cs_test_sweepcodesClickOnl1";
  const CLICK_CODE = "cs_test_sweepcodesClickCod1";
  sessions = [
    paid(CODE_ONLY, "noa@example.com", { discounts: [{ promotion_code: PROMO }] }),
    paid(CLICK_ONLY, "oli@example.com", { via: ANA }),
    paid(CLICK_CODE, "pia@example.com", { via: ANA, discounts: [{ promotion_code: PROMO }] }),
  ];
  codeReads = 0;
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("the codes were read (and answered in an unknown shape)", codeReads > 0, true);
  is("the code-only order is not written for anybody", await line(CODE_ONLY), undefined);
  is("it alone is counted as failed", counts.failed, 1);
  is("the click-only order is Ana's", [(await line(CLICK_ONLY))?.aff, (await line(CLICK_ONLY))?.how], [ANA, "click"]);
  is("the click-and-code order is Ana's, through her link", [(await line(CLICK_CODE))?.aff, (await line(CLICK_CODE))?.how], [ANA, "click"]);
  is("every buyer's confirmation went", [sentTo("noa@example.com"), sentTo("oli@example.com"), sentTo("pia@example.com")], [1, 1, 1]);

  part("A `via` that is not an affiliate id is no click: with a code and the codes unreadable, that order waits");
  const BAD_VIA = "cs_test_sweepcodesBadVia01";
  sessions = [...sessions, paid(BAD_VIA, "quin@example.com", { via: "not-an-affiliate", discounts: [{ promotion_code: PROMO }] })];
  codeReads = 0;
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("the codes were read", codeReads > 0, true);
  is("the order is not written for anybody", await line(BAD_VIA), undefined);
  is("it and the code-only order wait, the clicks stay written once", [counts.failed, (await readBook(store)).lines.filter((l) => l.ref === CLICK_CODE || l.ref === CLICK_ONLY).length], [2, 2]);

  part("The codes read again: the code-only orders are Ben's, once, and nothing is written or sent twice");
  unknown = false;
  counts = await sweepCheckouts(Date.now() + 20_000);
  is("nothing failed", counts.failed, 0);
  is("the code-only order is Ben's, through his code", [(await line(CODE_ONLY))?.aff, (await line(CODE_ONLY))?.how], [BEN, "code"]);
  is("the order with the bad `via` is Ben's, through his code", [(await line(BAD_VIA))?.aff, (await line(BAD_VIA))?.how], [BEN, "code"]);
  is("the clicks stay Ana's", [(await line(CLICK_ONLY))?.aff, (await line(CLICK_CODE))?.aff], [ANA, ANA]);
  counts = await sweepCheckouts(Date.now() + 20_000);
  console.error = errors;
  const refs = [CODE_ONLY, CLICK_ONLY, CLICK_CODE, BAD_VIA];
  const book = (await readBook(store)).lines;
  is("one line per order, after another pass", refs.map((ref) => book.filter((l) => l.ref === ref).length), [1, 1, 1, 1]);
  is("no confirmation went twice", ["noa", "oli", "pia", "quin"].map((n) => sentTo(`${n}@example.com`)), [1, 1, 1, 1]);
  done();
}

void main();
