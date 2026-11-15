/**
 * 639 [GL7](34), unit 2: the buyer's library across stores (app/library)
 * says, on each store's card, what waits on them there: payment requests
 * to pay and proposals or agreements to sign (lib/buyer-waiting.ts), only
 * where that store's orders page opens to act on them. Upcoming sessions
 * stay on each store's orders page, which already lists them, so the
 * library makes no extra Stripe reading per store.
 *
 * Codex J on #1969 (C3-131): each card's read is paid with that store's
 * buyer requests before it is made (LIBRARY_WAITING_UNITS), and without
 * them nothing is read and the card says it could not check, never that something waits or when (Claude 5 on #1969); a count
 * past what one read lists is said as "more than 10", never as 10.
 * Against the in-memory Redis double and synthetic stores only.
 */
import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import LibraryPage from "@/app/library/page";
import { claimHandle, ensureStatsId, ensureStoreId, setPastBuyers, setSubscription, storeForEmail } from "@/lib/store";
import { rememberBuyers } from "@/lib/buyer-library";
import { createAgreement } from "@/lib/agreement-store";
import { WAITING_LATER, WAITING_SHOWN, waitingFor, waitingLine } from "@/lib/buyer-waiting";
import { LIBRARY_WAITING_UNITS } from "@/lib/public-read-rules";
import { takePublicRequest } from "@/lib/traffic";
import { requestLimitFor } from "@/lib/traffic-rules";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

const totals = (requestsTotal: number, agreementsTotal: number, unread = false) => ({ requestsTotal, agreementsTotal, unread });

async function main(): Promise<void> {
  redis.clear();
  globalThis.fetch = (async () => {
    throw new Error("No outside request in this test");
  }) as typeof fetch;
  process.env.RESEND_API_KEY = "re_test_library_only_a_stand_in";

  part("In words");
  is("nothing waiting, nothing said", waitingLine(totals(0, 0)), "");
  is("one of each", waitingLine(totals(1, 1)), "Waiting for you: 1 payment request to pay and 1 proposal or agreement to sign.");
  is("several", waitingLine(totals(2, 0)), "Waiting for you: 2 payment requests to pay.");
  is("as many as one read lists: the number", waitingLine(totals(0, WAITING_SHOWN)), `Waiting for you: ${WAITING_SHOWN} proposals or agreements to sign.`);
  is("past it: more than that, never the limit as a total", waitingLine(totals(WAITING_SHOWN + 1, 0)), `Waiting for you: more than ${WAITING_SHOWN} payment requests to pay.`);
  is("some could not be read: said", waitingLine(totals(1, 0, true)), "Waiting for you: 1 payment request to pay. Some of it could not be read just now.");
  is("nothing could be read: said, never as nothing waiting", waitingLine(totals(0, 0, true)), "We could not check just now whether this store is waiting on anything from you.");
  is("nor as something waiting: no word that it waits on them", /waiting on (anything|you)/.test(waitingLine(totals(0, 0, true))) && !/is waiting on from you/.test(waitingLine(totals(0, 0, true))), true);

  part("Eleven agreements waiting: said as more than ten (Codex J)");
  const OWNER = "jlib@example.com";
  const BUYER = "buyer@example.com";
  await claimHandle(OWNER, "jlib", "Library review", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await setPastBuyers(OWNER);
  await setSubscription(OWNER, { customerId: "cus_JLibrary", subscriptionId: "sub_JLibrary", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  await rememberBuyers(store.sid, [BUYER]);
  for (let i = 0; i < 11; i += 1) {
    const made = await createAgreement(store, { kind: "agreement", email: BUYER, name: "Buyer", title: `Agreement ${i}`, body: "Example agreement.", lines: [], total: 0, payRequest: "" });
    if (!made.ok) throw new Error("no synthetic agreement");
    // As if its email went (a buyer is shown only what was emailed to them, lib/buyer-waiting.ts).
    const [raw] = await redis.pipeline([["GET", `nl:agree:r:${made.agreement.id}`]]);
    await redis.pipeline([["SET", `nl:agree:r:${made.agreement.id}`, JSON.stringify({ ...JSON.parse(String(raw)), sent: [Date.now()] })]]);
  }
  const found = await waitingFor(store, BUYER);
  is("the line says more than ten, not ten", waitingLine(found), `Waiting for you: more than ${WAITING_SHOWN} proposals or agreements to sign.`);

  part("Each card pays for its read before it reads (Codex J)");
  const token = "f".repeat(64);
  const digest = createHash("sha256").update(`nimbus-lib-link:${token}`).digest("hex").slice(0, 40);
  await redis.pipeline([["SET", `nl:lib:link:${digest}`, BUYER, "EX", 86_400]]);
  const original = redis.pipeline;
  const watch = async (run: () => Promise<unknown>) => {
    const commands: (string | number)[][] = [];
    redis.pipeline = async (batch) => {
      commands.push(...batch.map((c) => [...c]));
      return original.call(redis, batch);
    };
    try {
      const page = await run();
      return { commands, html: renderToStaticMarkup(page as never) };
    } finally {
      redis.pipeline = original;
    }
  };
  const isWaiting = (c: (string | number)[]) => c.some((x) => /^nl:(agree|payreq):/.test(String(x)));
  const isTraffic = (c: (string | number)[]) => c.some((x) => String(x).startsWith("nl:traffic:") || /:req:|:requests?:/.test(String(x)));
  const opened = await watch(() => LibraryPage({ searchParams: Promise.resolve({ token }) }));
  const firstWaiting = opened.commands.findIndex(isWaiting);
  const firstTraffic = opened.commands.findIndex(isTraffic);
  is("its waiting records are read", firstWaiting >= 0, true);
  is("only after the store's requests were taken", firstTraffic >= 0 && firstTraffic < firstWaiting, true);
  is("and the card says what waits", opened.html.includes(`more than ${WAITING_SHOWN} proposals or agreements to sign`), true);

  part("Stores are read a few at a time, not one after another (Claude 5 on #1969)");
  const OTHER = "jlib-two@example.com";
  await claimHandle(OTHER, "jlibtwo", "Second library store", "");
  await ensureStoreId(OTHER);
  await ensureStatsId(OTHER);
  await setPastBuyers(OTHER);
  await setSubscription(OTHER, { customerId: "cus_JLibraryTwo", subscriptionId: "sub_JLibraryTwo", active: true, tier: "creator", period: paidPeriod() });
  await rememberBuyers((await storeForEmail(OTHER))!.sid, [BUYER]);
  const both = await watch(() => LibraryPage({ searchParams: Promise.resolve({ token }) }));
  const firstRead = both.commands.findIndex(isWaiting);
  // Read one after another, the second store's orders link would come only after the first store's waiting records.
  const links = both.commands.slice(0, firstRead).filter((c) => c[0] === "SET" && String(c[1]).startsWith("nl:orders:link:")).length;
  is("both stores' cards start before the first one's waiting records are read", links, 2);

  part("With the store's requests used up: nothing read, and the card says it could not check");
  await takePublicRequest(store, "buyer", Date.now(), requestLimitFor(store));
  is("(the window used up)", await takePublicRequest(store, "buyer", Date.now(), 1), false);
  const spent = await watch(() => LibraryPage({ searchParams: Promise.resolve({ token }) }));
  // The first store's records only: the second store still has its requests and reads its own.
  is("no waiting record read", spent.commands.some((c) => isWaiting(c) && c.some((x) => String(x).includes(store.sid))), false);
  is("the card says it could not check", spent.html.includes(WAITING_LATER), true);
  is("and promises no time", /soon|again/.test(WAITING_LATER), false);
  is("nor that something waits", WAITING_LATER.includes("whether this store is waiting on anything"), true);

  part("An invalid library link reads nothing of what waits");
  const invalid = await watch(() => LibraryPage({ searchParams: Promise.resolve({ token: "0".repeat(64) }) }));
  is("no waiting record read", invalid.commands.some(isWaiting), false);

  part("On the library");
  const page = readFileSync("app/library/page.tsx", "utf8");
  is("the requests are taken before the read, at LIBRARY_WAITING_UNITS", page.indexOf(`takePublicRequest(store, "buyer", undefined, LIBRARY_WAITING_UNITS)`) < page.indexOf("await waitingFor(") && page.includes("LIBRARY_WAITING_UNITS"), true);
  is("payment requests read only where they take payment", page.includes("waitingFor(store, email, undefined, requestsOpen(store))"), true);
  is("said on the store's card, beside the way to open it", page.includes('{waiting ? <p className="mt-4 text-sm font-semibold text-ink">{waiting}</p> : null}'), true);
  is("no extra reading of the creator's Stripe account per store", !page.includes("callsFor("), true);
  is("(the units are a whole number above nothing)", Number.isSafeInteger(LIBRARY_WAITING_UNITS) && LIBRARY_WAITING_UNITS > 0, true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
