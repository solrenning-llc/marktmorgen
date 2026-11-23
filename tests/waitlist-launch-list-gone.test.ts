/**
 * #4638: a waitlist launch (lib/waitlist.ts runLaunches) never emails an address the store's list took off for a hard
 * bounce, a spam complaint or a refusal (`unsub` with `gone`, lib/contacts.ts stopWriting), as community announcements
 * already do (lib/community-mail.ts, tests/community-mail-list-gone.test.ts). Each batch read only the waitlist's own
 * places, so a buyer who marked the store's mail as spam, or whose mailbox no longer exists, still got the launch
 * offer from the same sender. A plain list unsubscribe is not read here: the waitlist has its own leave link, and
 * whether a list unsubscribe also stops the launch is the owner's call (the issue claims only bounce, complaint and
 * refusal). A list row in no known shape is unknown (rule 24): the batch waits, nobody is sent to, the cursor stays.
 * Synthetic data only; no network.
 */
import { addProduct, claimHandle, ensureListId, ensureStatsId, storeForEmail, storeForHandle } from "@/lib/store";
import { readListing } from "@/lib/catalog";
import { leadsKey } from "@/lib/contact-rules";
import { launch, runLaunches, setSoon, waitlistViews } from "@/lib/waitlist";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

type Sent = { to: string[] };
const batches: Sent[][] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com" && url.pathname === "/emails/batch") {
    const batch = JSON.parse(String(init?.body)) as Sent[];
    batches.push(batch);
    return Response.json({ data: batch.map((_, i) => ({ id: `synthetic_${i}` })) });
  }
  if (url.hostname === "api.resend.com") return Response.json({ id: "synthetic" });
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ADDRESS = "1 Main St, Portland, OR 97201";
const place = (i: number) => JSON.stringify({ at: 1, ok: 1, c: false, t: String(i).repeat(48), w: 1 });
const contact = (extra: Record<string, unknown>) => JSON.stringify({ agreed: true, agreedAt: "2026-09-01T00:00:00.000Z", firstAt: "", lastAt: "", titles: [], ids: [], source: "free", t: "e".repeat(40), name: "", tags: [], importedAt: "", unsub: false, ...extra });
const gone = (why: string) => contact({ unsub: true, unsubAt: "2026-11-01T00:00:00.000Z", gone: why });
const run = () => runLaunches(storeForHandle, readListing, Date.now() + 10_000);
const to = () => batches.flat().map((m) => m.to[0]).sort();

let stores = 0;
/** A store with a list and a coming-soon product whose waitlist holds `people`, each confirmed, with `rows` on the list. */
async function launched(people: string[], rows: Record<string, string>) {
  stores += 1;
  const owner = `gone-owner${stores}@example.com`;
  await claimHandle(owner, `gonelaunch${stores}`, `Gone ${stores}`, "");
  await ensureStatsId(owner);
  await ensureListId(owner);
  const added = await addProduct(owner, "The Bread Book", "", "39", null);
  if (!added.ok) throw new Error("no product");
  const store = (await storeForEmail(owner))!;
  const product = (await readListing(store, added.product.id))!;
  await setSoon(store, product.id, true);
  for (const [i, email] of people.entries()) redis.run(["HSET", `nl:wl:${store.statsId}:${product.id}`, email, place(i)]);
  for (const [email, row] of Object.entries(rows)) redis.run(["HSET", leadsKey(store.listId!), email, row]);
  const started = await launch(store, product, { note: "", address: ADDRESS });
  if (!started.ok) throw new Error("no launch");
  batches.length = 0;
  return { store, product };
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_waitlist_only";

  part("Control: everyone on the list in good standing, or not on it, gets the launch");
  await launched(["ana@example.com", "ben@example.com"], { "ana@example.com": contact({}) });
  is("both are sent to", [await run(), to()], [2, ["ana@example.com", "ben@example.com"]]);

  part("Taken off the store's list for a bounce, a complaint or a refusal: never sent the launch");
  const people = ["bounced@example.com", "complained@example.com", "kept@example.com", "refused@example.com"];
  const { store, product } = await launched(people, {
    "bounced@example.com": gone("bounced"),
    "complained@example.com": gone("complained"),
    "refused@example.com": gone("refused"),
    "kept@example.com": contact({}),
  });
  is("only the address in good standing is sent to", [await run(), to()], [1, ["kept@example.com"]]);
  const view = (await waitlistViews(store, [product.id]))[product.id];
  is("the launch still finishes, its cursor past all four", [view?.launch?.cursor, Boolean(view?.launch?.finished)], [4, true]);

  part("A plain list unsubscribe does not stop the launch (the waitlist has its own leave link; the owner's call)");
  await launched(["left@example.com"], { "left@example.com": contact({ unsub: true, unsubAt: "2026-11-01T00:00:00.000Z" }) });
  is("sent to", [await run(), to()], [1, ["left@example.com"]]);

  part("A list row in no known shape is unknown (rule 24): the batch waits");
  const odd: string[] = [];
  for (const [label, row] of [["text that is not JSON", "{"], ["a list", "[]"], ["a number", "5"]] as const) {
    const s = await launched(["odd@example.com", "fine@example.com"], { "odd@example.com": row });
    odd.push(s.store.listId!);
    is(`${label}: nobody is sent to`, [await run(), to()], [0, []]);
    const waiting = (await waitlistViews(s.store, [s.product.id]))[s.product.id];
    is(`${label}: the launch waits at its start`, [waiting?.launch?.cursor, Boolean(waiting?.launch?.finished)], [0, false]);
  }
  for (const listId of odd) redis.run(["HDEL", leadsKey(listId), "odd@example.com"]);
  batches.length = 0;
  is("once the rows read, the waiting launches go out", [await run(), to()], [6, ["fine@example.com", "fine@example.com", "fine@example.com", "odd@example.com", "odd@example.com", "odd@example.com"]]);

  done();
}

void main();
