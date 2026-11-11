/**
 * A come-back link whose stored grant Redis answers in an unknown shape, or
 * not at all (CX-123 rule 24; A8 proof in tests/a8-renew-winback-unknown.proof.ts, #2879).
 *
 * Only an absent key (null) is "nothing there". A number, an array, half a
 * JSON record, a pipeline with no replies or a pipeline that throws is
 * unknown: lib/winback-send.ts readWinBack throws UnknownReplyError,
 * openWinBack answers "unknown" (never "expired"), the button's route answers
 * 503 with the store's words, and the renew page says the offer could not be
 * checked right now, never that it has ended.
 *
 * Controls: an absent link, an expired grant and a healthy grant read and
 * render exactly as before. Synthetic store, synthetic grant, one injected
 * reply per case; no network.
 */
import { renderToReadableStream } from "react-dom/server";
import { NextRequest } from "next/server";
import RenewPage from "@/app/[handle]/renew/[product]/page";
import { POST as openRoute } from "@/app/api/store/come-back/open/route";
import { addProduct, claimHandle, ensureStatsId, setLanguage, setProductHidden, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { openWinBack, readWinBack } from "@/lib/winback-send";
import { UnknownReplyError } from "@/lib/redis-reply";
import { MEMBERSHIP_WORDS, membershipWords } from "@/lib/buyer-words/membership";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

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
  throw new Error("No external provider in the win-back unknown test");
}) as typeof fetch;
const quiet = console.error;

async function html(node: React.ReactElement): Promise<string> {
  const stream = await renderToReadableStream(node, { onError: () => {} });
  await stream.allReady;
  return new Response(stream).text();
}

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = "sk_test_winback_unknown_only_a_stand_in";
  redis.clear();
  const owner = "winback-unknown@example.test";
  await claimHandle(owner, "wbunknown", "Win-back Unknown", "");
  await ensureStatsId(owner);
  // A store that sells, so the healthy grant is offered (lib/store-checkout.ts, canSellProduct).
  await setStripeAccount(owner, "acct_1TestWbUnknown1", true);
  await setSubscription(owner, { customerId: "cus_WbUnknown01", subscriptionId: "sub_WbUnknown01", active: true, period: paidPeriod() });
  const made = await addProduct(owner, "Synthetic Club", "", "29", { interval: "month", trialDays: 0, payments: 0 });
  if (!made.ok) throw new Error("product fixture");
  await setProductLink(owner, made.product.id, "https://example.com/club");
  const store = (await storeForEmail(owner))!;
  const product = made.product.id;
  const notices = membershipWords(store.language).offerNotices;
  const ended = notices.expired;
  const grant = JSON.stringify({ s: store.statsId, e: "buyer@example.test", p: product, o: "", c: "co_WbUnknown001", pc: 25, m: 2 });
  const renew = async () =>
    html((await RenewPage({ params: Promise.resolve({ handle: "@wbunknown", product }), searchParams: Promise.resolve({ back: TOKEN }) })) as React.ReactElement);
  const press = async () => {
    const body = new URLSearchParams({ handle: "wbunknown", product, back: TOKEN }).toString();
    return openRoute(
      new NextRequest("https://marktmorgen.com/api/store/come-back/open", {
        method: "POST",
        body,
        headers: { host: "marktmorgen.com", origin: "https://marktmorgen.com", "content-type": "application/x-www-form-urlencoded", "content-length": String(body.length) },
      }),
    );
  };

  part("Words: every buyer language says the offer could not be checked, never that it ended");
  for (const [code, words] of Object.entries(MEMBERSHIP_WORDS)) {
    const unknown = words.offerNotices.unknown;
    is(`${code}: an unknown notice is written`, typeof unknown === "string" && unknown.length > 20, true);
    is(`${code}: it is not the 'ended' notice`, unknown !== words.offerNotices.expired, true);
  }

  part("Control: an absent link is the only 'nothing there'");
  is("an absent key reads as no grant", await readWinBack(store, product, TOKEN), null);
  const absentPage = await renew();
  is("and the page says the offer has ended", absentPage.includes(ended), true);
  is("and never that it could not be checked", absentPage.includes(notices.unknown), false);
  is("the button's door answers 'expired'", await openWinBack(store, product, TOKEN, "https://marktmorgen.com").then((r) => (r.ok ? "opened" : r.reason)), "expired");
  const absentPress = await press();
  is("the route sends the buyer back with status=expired", [absentPress.status, absentPress.headers.get("location")?.endsWith("&status=expired")], [303, true]);

  part("Control: a healthy grant reads back whole and shows the offer");
  await real([["SET", LINK, grant, "EX", 86_400]]);
  const kept = await readWinBack(store, product, TOKEN);
  is("a kept grant reads back whole", [kept?.coupon, kept?.percent, kept?.months, kept?.email], ["co_WbUnknown001", 25, 2, "buyer@example.test"]);
  const healthyPage = await renew();
  is("the page shows the come-back button", healthyPage.includes('action="/api/store/come-back/open"'), true);
  is("and neither notice", [healthyPage.includes(ended), healthyPage.includes(notices.unknown)], [false, false]);

  part("Control: a grant for another store or product is no grant here");
  await real([["SET", LINK, JSON.stringify({ ...JSON.parse(grant), p: "otherproduct1" }), "EX", 86_400]]);
  is("another product's grant reads as none", await readWinBack(store, product, TOKEN), null);

  part("Control: an expired grant is gone, as before");
  await real([["SET", LINK, grant, "EX", 60]]);
  redis.advance(61_000);
  is("an expired grant reads as none", await readWinBack(store, product, TOKEN), null);
  is("and the page says the offer has ended", (await renew()).includes(ended), true);
  is("and the door answers 'expired'", await openWinBack(store, product, TOKEN, "https://marktmorgen.com").then((r) => (r.ok ? "opened" : r.reason)), "expired");
  await real([["SET", LINK, grant, "EX", 86_400]]);

  const cases: [string, (batch: Command[]) => unknown[] | Promise<unknown[]>][] = [
    ["a GET answered with a number", () => [7, 86_400]],
    ["a GET answered with half a JSON record", () => ["{\"s\":", 86_400]],
    ["a GET answered with an array", () => [[grant], 86_400]],
    ["a GET answered with JSON that is not a record", () => ["[1,2]", 86_400]],
    ["a TTL answered with a string", () => [grant, "86400"]],
    ["a pipeline answered with no replies", () => []],
    ["a pipeline answered with three replies", () => [grant, 86_400, "OK"]],
    ["a pipeline that throws", () => Promise.reject(new Error("synthetic Redis failure"))],
  ];
  console.error = () => {};
  try {
    for (const [name, reply] of cases) {
      part(`Unknown: ${name}`);
      inject = reply;
      const read = await readWinBack(store, product, TOKEN).then(
        (value) => (value === null ? "absent" : "grant"),
        (error) => (error instanceof UnknownReplyError || name.endsWith("throws") ? "unknown" : `other: ${error}`),
      );
      is("readWinBack says the reading is unknown, never 'absent'", read, "unknown");
      const page = await renew();
      is("the renew page never tells the buyer the offer has ended", page.includes(ended), false);
      is("it says the offer could not be checked right now", page.includes(notices.unknown), true);
      is("and shows no come-back button it cannot back", page.includes('action="/api/store/come-back/open"'), false);
      const opened = await openWinBack(store, product, TOKEN, "https://marktmorgen.com").then(
        (r) => (r.ok ? "opened" : r.reason),
        () => "threw",
      );
      is("the button's door answers 'unknown', never 'expired'", opened, "unknown");
      const pressed = await press().then(async (r) => [r.status, r.headers.get("location"), await r.text()], () => "threw");
      is("the route answers 503 with the store's words, no redirect", pressed, [503, null, notices.unknown]);
      inject = null;
    }

    part("Unknown, on a draft: neither named nor said as no longer listed (MM-SA-30)");
    inject = null;
    await setProductHidden(owner, product, true);
    const gone = membershipWords(store.language).endedGone(store.name);
    await real([["DEL", LINK]]);
    is("control: an absent link on a draft says it is no longer listed, as before", (await renew()).includes(gone), true);
    inject = () => [7, 86_400];
    const draft = await renew();
    is("unknown: the page never says the store no longer lists it", draft.includes(gone), false);
    is("nor names the draft", draft.includes("Synthetic Club"), false);
    is("and says the offer could not be checked", draft.includes(notices.unknown), true);
    inject = null;
    await setProductHidden(owner, product, false);
    await real([["SET", LINK, grant, "EX", 86_400]]);

    part("Unknown, in another buyer language: the store's own words");
    await setLanguage(owner, "de");
    const de = MEMBERSHIP_WORDS.de.offerNotices;
    inject = () => [[grant], 86_400];
    const german = await renew();
    is("de: the page says it could not be checked", german.includes(de.unknown), true);
    is("de: and never that it ended", german.includes(de.expired), false);
    const pressedDe = await press().then(async (r) => [r.status, await r.text()], () => "threw");
    is("de: the route answers 503 in German", pressedDe, [503, de.unknown]);
    inject = null;
  } finally {
    console.error = quiet;
  }
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
