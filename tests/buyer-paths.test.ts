/**
 * What buyers get next (lib/next-bought.ts; added 12 October 2026). Checked:
 *
 *   - a later purchase by the same buyer, more than an hour after, is "next";
 *     a box ticked at checkout or an offer taken right after paying is not;
 *   - each buyer counts once for a pair, said from three buyers up, with the
 *     middle number of days between;
 *   - what is most often bought first;
 *   - kept from the all-time reading, read back safely, and read again only
 *     when stale, one request at a time.
 */
import { MIN_NEXT, claimPathsRead, laterWords, parsePaths, pathsFrom, pathsStale, readPaths } from "@/lib/next-bought";
import { readAllTimeSales } from "@/lib/stats";
import { claimHandle, ensureStatsId, setStripeAccount, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.STRIPE_SECRET_KEY = "sk_test_buyer_paths_stand_in";

const DAY_MS = 86_400_000;
const NOW = Date.now();
let sessions: Record<string, unknown>[] = [];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace(/^\/v1/, "");
  const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
  if (path === "/checkout/sessions") return json({ object: "list", data: sessions, has_more: false });
  return json({ object: "list", data: [], has_more: false });
}) as typeof fetch;

/** One paid sale as lib/stats.ts reads it. */
const sale = (email: string, daysAgo: number, product: string, meta: Record<string, string> = {}, upsell = false) => ({
  created: NOW - daysAgo * DAY_MS,
  product,
  upsell,
  row: { customer_details: { email }, metadata: { product, ...meta } },
});

async function main(): Promise<void> {
  redis.clear();

  part("Next, not together");
  const sales = [
    // Four buyers of the guide come back for the course, 10, 12, 14 and 40 days later.
    sale("a@example.com", 50, "guide"), sale("a@example.com", 40, "course"),
    sale("b@example.com", 50, "guide"), sale("b@example.com", 38, "course"),
    sale("c@example.com", 50, "guide"), sale("c@example.com", 36, "course"),
    sale("d@example.com", 60, "guide"), sale("d@example.com", 20, "course"),
    // The same buyer buying the course twice counts once.
    sale("d@example.com", 10, "course"),
    // Three take the checklist in the same checkout, or one click after paying: together, never next.
    sale("e@example.com", 5, "guide", { bump: "checklist" }),
    sale("f@example.com", 5, "guide"), { ...sale("f@example.com", 5, "checklist", {}, true), created: NOW - 5 * DAY_MS + 60_000 },
    sale("g@example.com", 5, "guide", { bump: "checklist" }),
    // Two buyers of the course go on to the call: below three, nothing is said.
    sale("a@example.com", 30, "call"), sale("b@example.com", 30, "call"),
  ];
  const paths = pathsFrom(sales, NOW);
  is("the guide's buyers went on to the course, four of them, usually 13 days later", paths.next.guide, [{ id: "course", buyers: 4, days: 13 }]);
  is("a box at checkout and an offer right after paying are the same visit", paths.next.guide?.some((s) => s.id === "checklist"), false);
  is(`from ${MIN_NEXT} buyers up only`, paths.next.course, undefined);
  is("what is bought first, counted per buyer, a same-visit add-on with it", [paths.starts.guide, paths.starts.checklist, paths.starts.course], [7, 3, undefined]);
  is("said in words", [laterWords(0), laterWords(1), laterWords(13)], ["the same day", "1 day later", "13 days later"]);

  part("Read back safely");
  // A snapshot with a part that does not read is no reading, never the rest of it (#4071; tests/next-bought-exact.test.ts).
  is("anything else is nothing", [parsePaths(null), parsePaths({ at: "x" }), parsePaths({ at: 1, next: { x: [{ id: "y", buyers: 2, days: 1 }] } })], [null, null, null]);

  part("Kept from the all-time reading");
  await claimHandle("owner@example.com", "harbor", "Harbor Kitchen", "");
  await ensureStatsId("owner@example.com");
  await setStripeAccount("owner@example.com", "acct_1TestHarbor0001", true);
  const store = (await storeForEmail("owner@example.com"))!;
  const session = (id: string, email: string, daysAgo: number, product: string) => ({
    id,
    status: "complete",
    payment_status: "paid",
    amount_total: 1900,
    currency: "usd",
    created: Math.floor((NOW - daysAgo * DAY_MS) / 1000),
    customer_details: { email },
    metadata: { store: "harbor", product },
  });
  sessions = ["a", "b", "c"].flatMap((who, i) => [session(`cs_test_first${i}aaaaaaaa`, `${who}@example.com`, 30, "guide"), session(`cs_test_later${i}aaaaaaaa`, `${who}@example.com`, 20, "course")]);
  is("nothing kept yet: read again", pathsStale(await readPaths(store.statsId)), true);
  await readAllTimeSales(store);
  const kept = await readPaths(store.statsId);
  is("kept for the studio", [kept?.next.guide, pathsStale(kept)], [[{ id: "course", buyers: 3, days: 10 }], false]);
  is("read again one request at a time", [await claimPathsRead(store.statsId), await claimPathsRead(store.statsId)], [true, false]);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
