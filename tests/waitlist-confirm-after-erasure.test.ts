/**
 * #4268: a waitlist confirmation (lib/waitlist.ts confirmSpot) whose link was read before the person's erasure must
 * not finish after it. Before the fix it wrote the waitlist entry back with a plain HSET and called upsertContact as
 * the person's own yes "given now", which put the erased address back on the creator's list as someone who agreed and
 * lifted the erasure print. The confirmation is now fenced by its own link (lib/contacts.ts upsertContact `fence`):
 * the erasure deletes the link (its erasure note), so a write that lands after the erasure is refused in one step with
 * the check. A fresh yes, given by a link made after the erasure, still lifts the print.
 * Synthetic only (in-memory Redis stand-in, no email sent).
 */
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { leadsKey, upsertContact } from "@/lib/contacts";
import { suppressedKey, suppressionPrint } from "@/lib/suppression";
import { erasePerson } from "@/lib/person-erasure";
import { confirmSpot, joinWaitlist, setSoon } from "@/lib/waitlist";
import { ROOM } from "./data-room";

const OWNER = "wait-race-owner@example.com";
const PERSON = "wait-race-person@example.com";
const sent: string[] = [];

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === "api.resend.com") {
      sent.push(String((JSON.parse(String(init?.body)) as { text?: string }).text ?? ""));
      return new Response(JSON.stringify({ id: "email_1" }));
    }
    return new Response(JSON.stringify({ object: "list", data: [], has_more: false }), { status: 200 });
  }) as typeof fetch;
  await claimHandle(OWNER, "waitrace", "Wait Race", "");
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  const made = await addProduct(OWNER, "The Soon Book", "", "39", null);
  if (!made.ok) throw new Error("no product");
  const store = (await storeForEmail(OWNER))!;
  const product = (await readListing(store, made.product.id))!;
  await setSoon(store, product.id, true);
  const leads = leadsKey(store.listId!);
  const print = () => redis.run(["HEXISTS", suppressedKey(store.listId!), suppressionPrint(store.listId!, PERSON)]);
  const entryKey = `nl:wl:${store.statsId}:${product.id}`;
  const tokenIn = (text: string) => text.match(/token=([0-9a-f]{48})/)?.[1] ?? "";
  const join = async () => {
    is("(control) the person joins the waitlist, asking to hear more", await joinWaitlist({ store, product, email: PERSON, consent: true, ip: "3.3.3.3", origin: "https://marktmorgen.com" }), "sent");
    return tokenIn(sent[sent.length - 1]);
  };
  const erase = () => erasePerson(store, PERSON, { kind: "team", who: OWNER, role: "owner" });

  /** Runs the erasure once, when the first pipeline `when` matches is sent: just before it runs, or just after it was answered. */
  async function withErasureAt(when: (commands: (string | number)[][]) => boolean, timing: "before" | "after", run: () => Promise<unknown>) {
    const original = redis.pipeline.bind(redis);
    let erasure: { ok: boolean } | null = null;
    const hook = (async (commands: (string | number)[][]) => {
      const matched = !erasure && when(commands);
      const eraseNow = async () => {
        redis.pipeline = original;
        erasure = await erase();
        redis.pipeline = hook;
      };
      if (matched && timing === "before") await eraseNow();
      const replies = await original(commands);
      if (matched && timing === "after") await eraseNow();
      return replies;
    }) as typeof redis.pipeline;
    redis.pipeline = hook;
    const result = await run().catch((error: unknown) => ({ ok: "threw", error: String(error) }));
    redis.pipeline = original;
    return { result, erasure: erasure as { ok: boolean } | null };
  }

  part("an erasure completes between reading the waitlist entry and writing it back");
  await upsertContact(store.listId!, PERSON, { agreed: true, explicit: true, source: "free", sid: store.sid }, ROOM);
  let token = await join();
  let run = await withErasureAt((c) => c[0]?.[0] === "HGET" && c[0]?.[1] === entryKey, "after", () => confirmSpot(token, store));
  is("(control) the erasure completed while the confirmation was in flight", run.erasure?.ok, true);
  is("the confirmation does not report a spot", (run.result as { ok: unknown }).ok, false);
  is("the waitlist entry is not written back", redis.run(["HGET", entryKey, PERSON]), null);
  is("the erased address is not on the list", redis.run(["HGET", leads, PERSON]), null);
  is("the erasure print is still in place", print(), 1);

  part("an erasure completes at the contact write of a second press (the spot already confirmed)");
  redis.run(["HDEL", suppressedKey(store.listId!), suppressionPrint(store.listId!, PERSON)]);
  token = await join();
  is("(control) the first press confirms the spot", (await confirmSpot(token, store)).ok, true);
  is("(control) and puts the address on the list", typeof redis.run(["HGET", leads, PERSON]), "string");
  // The erasure lands at upsertContact's first read (HGET, HLEN, erased?), after confirmSpot read the link and the entry.
  run = await withErasureAt((c) => c[0]?.[0] === "HGET" && c[0]?.[1] === leads && c.length === 3, "before", () => confirmSpot(token, store));
  is("(control) the erasure completed while the second press was in flight", run.erasure?.ok, true);
  is("the second press does not report a spot", (run.result as { ok: unknown }).ok, false);
  is("the erased address is not on the list", redis.run(["HGET", leads, PERSON]), null);
  is("the erasure print is still in place", print(), 1);

  part("a fresh yes, by a link made after the erasure, still lifts the print");
  token = await join();
  is("the new link confirms the spot", (await confirmSpot(token, store)).ok, true);
  is("the address is back on the list, as it asked again", typeof redis.run(["HGET", leads, PERSON]), "string");
  is("its own new yes lifted the print", print(), 0);

  part("upsertContact with a fence whose key is gone writes nothing and says so");
  redis.run(["SET", "nl:test:fence", "1"]);
  const other = "fence-gone@example.com";
  redis.run(["HSET", suppressedKey(store.listId!), suppressionPrint(store.listId!, other), 1]);
  redis.run(["DEL", "nl:test:fence"]);
  const refused = await upsertContact(store.listId!, other, { agreed: true, explicit: true, source: "free", fence: "nl:test:fence" }, store);
  is("refused as gone", [refused.joined, refused.gone], [false, true]);
  is("nothing written", redis.run(["HGET", leads, other]), null);
  is("the print stays", redis.run(["HEXISTS", suppressedKey(store.listId!), suppressionPrint(store.listId!, other)]), 1);
  redis.run(["SET", "nl:test:fence", "1"]);
  const kept = await upsertContact(store.listId!, other, { agreed: true, explicit: true, source: "free", fence: "nl:test:fence" }, store);
  is("with the fence in place, the own yes is written and lifts the print", [kept.joined, kept.gone, redis.run(["HEXISTS", suppressedKey(store.listId!), suppressionPrint(store.listId!, other)])], [true, undefined, 0]);
  done();
}
main().catch((error) => { console.error(error); process.exit(1); });
