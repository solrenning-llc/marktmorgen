/**
 * Marktmorgen Path counts a lead only when the address uses its confirmation
 * link, never because the email asking for it was sent (13 [D10]).
 *
 *   - the counts Path reads its leads from are the confirmed ones on the
 *     store's all-time record (lc), never the addresses asked for (fs:<channel>),
 *     which the store's numbers keep as they are;
 *   - a waitlist spot is a lead the first time its button is pressed, never on
 *     the second press;
 *   - a free product's emailed link is a lead on its first use only;
 *   - joining the store's list is a lead only for an address new to the list;
 *   - sending the confirmation email counts nothing for Path.
 *
 * Synthetic stores and addresses, against the in-memory Redis and a stand-in
 * for the email provider.
 */
import { readFileSync } from "node:fs";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, setSoon } from "@/lib/waitlist";
import { countConfirmedLead, readLifeRecord } from "@/lib/stats";
import { countsFrom } from "@/lib/path-facts";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const single: { text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as { text: string });
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const tokenIn = (text: string) => text.match(/token=([0-9a-f]{48})/)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_path_leads_only";

  part("Path reads confirmed leads only, never the addresses asked for");
  is("asked for, never confirmed: no lead", countsFrom(new Map([["fs:instagram", 4], ["fs:direct", 2]]), 0, 0).leads, 0);
  is("confirmed: each one a lead", countsFrom(new Map([["fs:instagram", 4], ["lc", 3]]), 0, 0).leads, 3);
  is("a count of another shape is no lead", countsFrom(new Map([["lc", Number.NaN]]), 0, 0).leads, 0);

  await claimHandle("owner@example.com", "pathleads", "Path Leads", "");
  await ensureStatsId("owner@example.com");
  await ensureListId("owner@example.com");
  const made = await addProduct("owner@example.com", "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  let store = (await storeForEmail("owner@example.com"))!;
  const product = (await readListing(store, made.product.id))!;
  const leads = async () => (await readLifeRecord(store.statsId)).get("lc") ?? 0;

  part("A confirmed lead is counted on the store's all-time record");
  await countConfirmedLead(store.statsId);
  is("one", await leads(), 1);
  await countConfirmedLead(null);
  is("a store with no numbers yet: nothing, and nothing thrown", await leads(), 1);

  part("A waitlist spot: a lead on the first press of its button, never on the second");
  await setSoon(store, product.id, true);
  store = (await storeForEmail("owner@example.com"))!;
  is("Dana asks", await joinWaitlist({ store, product, email: "dana@example.com", consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" }), "sent");
  is("sending the email counts no lead", await leads(), 1);
  const token = tokenIn(single.at(-1)?.text ?? "");
  const first = await confirmSpot(token, store);
  is("the first press confirms it, as the first", [first.ok, first.ok && first.first], [true, true]);
  const second = await confirmSpot(token, store);
  is("the second press still confirms it, but not as the first", [second.ok, second.ok && second.first], [true, false]);

  part("The routes count a lead only on a first confirmation");
  const waitRoute = readFileSync("app/api/store/waitlist/confirm/route.ts", "utf8");
  const joinRoute = readFileSync("app/api/store/join/confirm/route.ts", "utf8");
  const freeRoute = readFileSync("app/api/store/free/download/route.ts", "utf8");
  is("the waitlist's button: only its first press", /if \(result\.ok && result\.first\)[\s\S]{0,120}countConfirmedLead\(store\.statsId\)/.test(waitRoute), true);
  is("joining the list: only an address new to it", /if \(result\.added\.joined\)[\s\S]{0,120}countConfirmedLead\(store\.statsId\)/.test(joinRoute), true);
  is("a free product's link: only its first use", /if \(used\.first\)[\s\S]{0,120}countConfirmedLead\(store\.statsId\)/.test(freeRoute), true);
  const free = readFileSync("lib/free.ts", "utf8");
  is("spendClaim says which use is the first", /return \{ ok: true, claim, first: count === 1 \}/.test(free), true);
  for (const path of ["app/api/store/join/route.ts", "app/api/store/waitlist/join/route.ts", "app/api/store/free/route.ts"]) {
    is(`${path}: asking counts no lead`, /countConfirmedLead/.test(readFileSync(path, "utf8")), false);
  }

  done();
}

main();
