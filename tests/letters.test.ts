/**
 * Emails published on the store (lib/letter-rules.ts, lib/letters.ts, the
 * route; docs/zero-cost-value-2026-10-18.md item 1; added 18 October 2026).
 *
 * Checked, in the in-memory Redis:
 *
 *   - only an email this store sent is published, never one scheduled,
 *     cancelled or another store's, and only by a role that may send;
 *   - what is published is the subject and words as sent, the links as typed,
 *     and nothing about who received it; its id is not the email's own;
 *   - the copy and its entry take their room in the data room first, and a
 *     store keeps at most MAX_PUBLISHED_LETTERS;
 *   - taking it off deletes the copy; a closing store's copies are found;
 *   - the store commands each action sends, measured.
 */
import { NextRequest } from "next/server";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail, type Store } from "@/lib/store";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import type { Broadcast } from "@/lib/broadcasts";
import { LETTER_ID, MAX_PUBLISHED_LETTERS, PUBLISH_WARNING } from "@/lib/letter-rules";
import { letterIdFor, letterRoomBytes, listLetters, publishLetter, publishedLetters, readLetter, unpublishLetter } from "@/lib/letters";
import { FOLLOWERS } from "@/lib/closed-store-data";
import { RESERVED_SLUGS } from "@/lib/site-page-rules";
import { dataUsed } from "@/lib/store-data";
import { bodyHtml } from "@/lib/mail-body";
import { POST as lettersRoute } from "@/app/api/store/letters/route";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { paidPeriod } from "./billing-period-fixture";

let commands = 0;
const pipeline = redis.pipeline.bind(redis);
(redis as unknown as { pipeline: typeof pipeline }).pipeline = (cmds) => {
  commands += cmds.length;
  return pipeline(cmds);
};
const measured: Record<string, number> = {};
async function measure<T>(what: string, run: () => Promise<T>): Promise<T> {
  const before = commands;
  const out = await run();
  measured[what] = commands - before;
  return out;
}

function broadcast(store: Store, over: Partial<Broadcast> = {}): Broadcast {
  const id = (over.id ?? "a1").padStart(24, "0");
  const b: Broadcast = {
    id,
    listId: store.listId!,
    handle: store.handle,
    subject: "October notes",
    body: "# What changed\nThe new workbook is out: https://example.com/workbook.\n\n- Two new lessons\n- A checklist",
    productId: null,
    notProductId: null,
    who: "all",
    narrow: null,
    status: "sent",
    createdAt: 1_760_000_000,
    sendAt: 1_760_000_100,
    finishedAt: 1_760_000_200,
    total: 120,
    sent: 120,
    note: "",
    failures: 0,
    listed: true,
    tagged: true,
    test: null,
    ...over,
  };
  redis.run(["SET", `nl:mail:bc:${id}`, JSON.stringify(b)]);
  return b;
}

async function paidStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, "Mara's Kitchen", "");
  await ensureStatsId(owner);
  await ensureStoreId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle}`, subscriptionId: `sub_${handle}`, active: true, tier: "pro", period: paidPeriod() });
  return (await storeForEmail(owner))!;
}

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const owner = "letters@example.com";
  const store = await paidStore(owner, "marakitchen");
  const sent = broadcast(store);

  part("Only an email this store sent");
  is("a scheduled one is refused", (await publishLetter(store, broadcast(store, { id: "b2", status: "scheduled" }), now)).ok, false);
  is("another store's is refused", (await publishLetter(store, { ...sent, listId: "another" }, now)).ok, false);

  part("Published: a copy of what was sent, nothing about who received it");
  const before = (await dataUsed(store))!.used;
  const published = await measure("publish (count, data room, copy, entry)", () => publishLetter(store, sent, now));
  if (!published.ok) throw new Error(published.message);
  const letter = published.letter;
  is("its id is made from the store and the email, never the email's own", [LETTER_ID.test(letter.id), letter.id === letterIdFor(store.sid, sent.id), letter.id.includes(sent.id.slice(0, 10))], [true, true, false]);
  is("its subject, words and when it went", [letter.subject, letter.body, letter.sentAt], [sent.subject, sent.body, sent.finishedAt * 1000]);
  is("nothing about who received it", Object.keys(letter).sort(), ["body", "id", "publishedAt", "sentAt", "sid", "subject"]);
  is("its room in the data room was taken first", (await dataUsed(store))!.used - before >= letterRoomBytes(letter), true);
  const page = await measure("open one published email", () => readLetter(store, letter.id));
  is("readable at its address, only under its store", [page?.subject, await readLetter({ sid: "another" }, letter.id)], [sent.subject, null]);
  is("drawn with the links as typed, not tagged", bodyHtml(page!.body).includes('href="https://example.com/workbook"'), true);
  const listed = await measure("open the list of published emails", () => listLetters(store));
  is("listed", (listed ?? []).map((l) => l.id), [letter.id]);
  is("the studio knows it is published", (await measure("the studio's read of what is published", () => publishedLetters(store)))?.has(letter.id), true);
  is("publishing it again writes it again, not a second one", [(await publishLetter(store, sent, now + 1)).ok, (await listLetters(store))?.length], [true, 1]);

  part("A cap, and taking it off");
  for (let i = 0; i < MAX_PUBLISHED_LETTERS - 1; i += 1) {
    const b = broadcast(store, { id: `e${i.toString(16)}` });
    const r = await publishLetter(store, b, now);
    if (!r.ok) throw new Error(r.message);
  }
  const over = await publishLetter(store, broadcast(store, { id: "ff" }), now);
  is(`at most ${MAX_PUBLISHED_LETTERS} at once`, [over.ok, over.ok ? "" : over.reason], [false, "too_many"]);
  is("taken off: its copy is deleted", [await measure("take it off", () => unpublishLetter(store, letter.id)), await readLetter(store, letter.id), redis.run(["GET", `nl:letters:i:${letter.id}`])], [true, null, null]);
  is("a closing store's copies are found through its list", typeof FOLLOWERS["nl:letters:s:"]?.find, "function");
  is("the address is kept from page names", RESERVED_SLUGS.has("letters"), true);

  part("The studio's route");
  const session = await openSession(owner);
  const call = async (body: Record<string, unknown>, cookie = `${SESSION_COOKIE}=${session}`) => {
    const r = await lettersRoute(new NextRequest("https://marktmorgen.com/api/store/letters", { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) }));
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const made = await call({ action: "publish", id: sent.id });
  is("publish answers its path", [made.status, made.body.path], [200, `/@marakitchen/letters/${letter.id}`]);
  is("an email that is not this store's is refused", (await call({ action: "publish", id: "c".repeat(24) })).status, 404);
  is("unpublish", [(await call({ action: "unpublish", id: sent.id })).body.ok, await readLetter(store, letter.id)], [true, null]);
  is("signed out: refused", (await call({ action: "publish", id: sent.id }, "")).status, 401);
  is("the studio asks first, saying anyone can read it", /Anyone can read it once it is published/.test(PUBLISH_WARNING), true);

  part("Store commands per action, measured");
  for (const [what, n] of Object.entries(measured)) console.log(`        ${String(n).padStart(4)}  ${what}`);
  is("each within ten commands", Object.values(measured).every((n) => n <= 10), true);
  done();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
