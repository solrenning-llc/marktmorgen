/**
 * MM-SA-53 (docs/security-audit-2026-10-28.md), item waitlist launch: a
 * product that is a draft again (product.hidden) is not launched. Launching
 * emails everyone who confirmed that the product is on sale; for a draft
 * that email is false and spends the store's email on nothing anybody can
 * buy. So launch (lib/waitlist.ts) refuses it with its reason ("draft"),
 * before anything is written: no launch job, no send queue, the list kept,
 * no email; the studio says why (components/waitlist-panel.tsx). Published
 * again, it launches as before.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, setProductHidden, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { confirmSpot, joinWaitlist, launch, runLaunches, setSoon, waitlistViews } from "@/lib/waitlist";
import { readFileSync } from "node:fs";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[]; subject: string; text: string };
const single: Sent[] = [];
const batches: Sent[][] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") {
    single.push(JSON.parse(String(init?.body)) as Sent);
    return new Response(JSON.stringify({ id: "email_1" }));
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const tokenIn = (text: string) => text.match(/token=([0-9a-f]{48})/)?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  const OWNER = "draft-launch@example.com";
  await claimHandle(OWNER, "draftlaunch", "Draft Launch", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const made = await addProduct(OWNER, "The Bread Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  let store = (await storeForEmail(OWNER))!;
  let product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  is("Dana joins", await joinWaitlist({ store, product, email: "dana@example.com", consent: false, ip: "1.1.1.1", origin: "https://marktmorgen.com" }), "sent");
  is("and confirms", (await confirmSpot(tokenIn(single[0].text), store)).ok, true);

  part("A draft is refused with its reason, and nothing is written or sent");
  is("back to draft", (await setProductHidden(OWNER, product.id, true)).ok, true);
  store = (await storeForEmail(OWNER))!;
  product = (await readListing(store, product.id))!;
  const keysBefore = redis.keys().sort();
  const refused = await launch(store, product, { note: "It is here.", address: "1 Main St, Portland, OR 97201" });
  is("refused as a draft", refused, { ok: false, reason: "draft" });
  is("nothing written: no launch job, no send queue", redis.keys().sort(), keysBefore);
  const sent = await runLaunches(async () => (await storeForEmail(OWNER))!, readListing, Date.now() + 10_000);
  is("no email to anybody", [sent, batches.length], [0, 0]);
  const view = (await waitlistViews(store, [product.id]))[product.id];
  is("the list is kept, nobody told", [view?.confirmed, view?.launch ?? null], [1, null]);
  is("the studio says why", /draft:\s*"/.test(readFileSync("components/waitlist-panel.tsx", "utf8")), true);

  part("Published again, it launches as before");
  is("published", (await setProductHidden(OWNER, product.id, false)).ok, true);
  store = (await storeForEmail(OWNER))!;
  product = (await readListing(store, product.id))!;
  const launched = await launch(store, product, { note: "It is here.", address: "1 Main St, Portland, OR 97201" });
  is("launched, for the one confirmed", launched.ok && launched.total, 1);
  is("and the email goes", [await runLaunches(async () => (await storeForEmail(OWNER))!, readListing, Date.now() + 10_000), batches.flat().map((m) => m.to[0])], [1, ["dana@example.com"]]);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
