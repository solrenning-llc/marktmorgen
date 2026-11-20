/**
 * Every note a confirmed Path lead leaves in the person's erasure index is
 * priced (13 [D10], review M1 of Claude 5 on #3431).
 *
 * A confirmation link is noted for the person's deletion when it is made
 * (lib/erasure-index.ts), and countConfirmedLead notes the Path lead's mark
 * in the same set, kept INDEX_SECONDS (401 days). Each unit that carries a
 * link therefore leaves its link's notes and the mark's note; the registry
 * line of that set ("nl:erase:ix:@lib/erasure-index.ts" in
 * tests/store-data-registry.ts) must price as many notes for that unit as the
 * real flow leaves, or a byte kept 401 days is unknown and taken as zero.
 *
 * Each flow runs as a buyer would: the real function that emails the link
 * (askToJoin, joinWaitlist, requestCopy), then the real route the link
 * posts to. Synthetic store and addresses, the in-memory Redis, no email
 * leaves (Resend is stubbed).
 */
import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { addProduct, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setJoin, setProductLink, setStripeAccount, setSubscription, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { askToJoin } from "@/lib/store-join";
import { joinWaitlist, setSoon } from "@/lib/waitlist";
import { requestCopy } from "@/lib/free";
import { normaliseEmail } from "@/lib/auth";
import { INDEX_SECONDS } from "@/lib/erasure-index";
import { readLifeRecord } from "@/lib/stats";
import { POST as joinConfirm } from "@/app/api/store/join/confirm/route";
import { POST as waitConfirm } from "@/app/api/store/waitlist/confirm/route";
import { POST as freeDownload } from "@/app/api/store/free/download/route";
import { FAMILIES, MARK, type Part, type Unit } from "./store-data-registry";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const sent: { to: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to?: unknown; text?: string };
    sent.push({ to: String(body.to), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  if (url.hostname === "api.stripe.com") return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  throw new Error(`no network in this test: ${url.hostname}`);
}) as typeof fetch;

const press = (path: string, token: string) => {
  const form = new FormData();
  form.set("token", token);
  return new NextRequest(`https://marktmorgen.com${path}`, { method: "POST", body: form });
};
/** The token in the last email sent to `to`. */
const tokenTo = (to: string) => {
  const text = sent.filter((s) => s.to.includes(to)).at(-1)?.text ?? "";
  return /token=([0-9a-f]+)/.exec(text)?.[1] ?? "";
};
/** The person's erasure notes, as lib/erasure-index.ts names the set. */
const notesOf = (statsId: string, email: string) =>
  Number(redis.run(["ZCARD", `nl:erase:ix:${statsId}:${createHash("sha256").update(`nimbus-erase-ix:${statsId}:${normaliseEmail(email)}`).digest("hex").slice(0, 32)}:z`]));

const LINE = FAMILIES["nl:erase:ix:@lib/erasure-index.ts"];
/** The notes the registry prices for one unit of `unit` whose kind is `group`: the parts for every kind of it, and the parts of that kind. */
function priced(unit: Unit, group: string): number {
  return (LINE?.parts ?? []).filter((p): p is Extract<Part, { per: Unit }> => "per" in p && p.per === unit && (!p.group || p.group === group)).reduce((n, p) => n + p.bytes / MARK, 0);
}

async function main(): Promise<void> {
  redis.clear();
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const owner = "owner@path-notes.example";
  await claimHandle(owner, "pathnotes", "Path Notes", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setStripeAccount(owner, "acct_1PathNotesXXXXX", true);
  await setSubscription(owner, { customerId: "cus_pathnotes", subscriptionId: "sub_pathnotes", active: true, tier: "creator", period: paidPeriod() });
  await setJoin(owner, { on: true });
  const free = await addProduct(owner, "Starter Guide", "", "0", null);
  const soon = await addProduct(owner, "The Bread Book", "", "39", null);
  if (!free.ok || !soon.ok) throw new Error("no products");
  await setProductLink(owner, free.product.id, "https://example.com/guide.pdf");
  await setSoon((await storeForEmail(owner))!, soon.product.id, true);
  const store = (await storeForEmail(owner))!;
  const sid = store.statsId!;
  const leads = async () => (await readLifeRecord(sid)).get("lc") ?? 0;

  part("Every note of the person's erasure index is kept as long as the index");
  is("each part of the line keeps its note INDEX_SECONDS", (LINE?.parts ?? []).every((p) => "per" in p && p.days * 86_400 === INDEX_SECONDS), true);

  part("Joining the list (an access email of the kind join): every note it leaves is priced");
  const joiner = "ann@path-notes.example";
  is("the sign-up email is sent", await askToJoin({ store, email: joiner, ip: "198.18.1.1", origin: "https://marktmorgen.com" }), "sent");
  await joinConfirm(press("/api/store/join/confirm", tokenTo(joiner)));
  is("its confirmation counted a lead", await leads(), 1);
  is("the notes it left, priced on the access line", [notesOf(sid, joiner), priced("access", "email kind/join")], [notesOf(sid, joiner), notesOf(sid, joiner)]);

  part("A waitlist spot (a store email of the kind waitlist): every note it leaves is priced");
  const waiter = "bo@path-notes.example";
  const product = (await readListing(store, soon.product.id))!;
  is("the waitlist email is sent", await joinWaitlist({ store, product, email: waiter, consent: false, ip: "198.18.1.2", origin: "https://marktmorgen.com" }), "sent");
  await waitConfirm(press("/api/store/waitlist/confirm", tokenTo(waiter)));
  is("its confirmation counted a lead", await leads(), 2);
  is("the notes it left, priced on the store line", [notesOf(sid, waiter), priced("store", "email kind/waitlist")], [notesOf(sid, waiter), notesOf(sid, waiter)]);

  part("A free copy's link (an order of the kind free): every note it leaves is priced");
  const reader = "cy@path-notes.example";
  const guide = (await readListing(store, free.product.id))!;
  is("the free copy's email is sent", await requestCopy({ store, product: guide, email: reader, consent: false, ip: "198.18.1.3", origin: "https://marktmorgen.com" }), "sent");
  await freeDownload(press("/api/store/free/download", tokenTo(reader)));
  is("its use counted a lead", await leads(), 3);
  is("the notes it left, priced on the order line", [notesOf(sid, reader), priced("order", "order kind/free")], [notesOf(sid, reader), notesOf(sid, reader)]);

  done();
}

main();
