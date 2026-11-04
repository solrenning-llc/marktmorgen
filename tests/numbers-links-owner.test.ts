/**
 * SG1-B-01 (queue item 506 [SG1]): taking back a numbers link
 * (app/api/store/numbers-links) must only ever reach this store's own link.
 *
 * The id of a link is in the address a creator hands a sponsor
 * (/numbers/<id>). Before the fix the route let go of the public index for
 * any id it was sent, whether or not the store held it, so anyone with
 * settings on any store could end another store's link: it answered "not
 * found" to the sponsor while the other studio still showed it as working.
 *
 * Driven through the real route, with real sessions, on the in-memory Redis.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/numbers-links/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { indexLink, linkStore, makeLink } from "@/lib/numbers-links";
import { addNumbersLink, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const NOW = Date.now();

async function remove(session: string, id: string): Promise<{ status: number; body: unknown }> {
  const response = await POST(new NextRequest("https://marktmorgen.com/api/store/numbers-links", {
    method: "POST",
    headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}` },
    body: JSON.stringify({ action: "remove", id }),
  }));
  return { status: response.status, body: await response.json() };
}

async function openStore(email: string, handle: string): Promise<{ sid: string; session: string }> {
  await claimHandle(email, handle, handle, "");
  await ensureStatsId(email);
  await ensureStoreId(email);
  const store = (await storeForEmail(email))!;
  return { sid: store.sid, session: await openSession(email) };
}

async function main() {
  redis.clear();
  const a = await openStore("owner-a@example.com", "store-a-numbers");
  const b = await openStore("owner-b@example.com", "store-b-numbers");
  is("two stores, each with an id of its own", [Boolean(a.sid), Boolean(b.sid), a.sid !== b.sid], [true, true, true]);

  const made = makeLink({ label: "Acme sponsorship", password: "harbor-2026", days: 30, money: true }, NOW);
  if (!made.ok) throw new Error("no link");
  const victim = made.link;
  await addNumbersLink("owner-b@example.com", victim, NOW);
  await indexLink(b.sid, victim, NOW);
  is("B's link points at B", await linkStore(victim.id), b.sid);

  part("Another store cannot take B's link back");
  const unknown = await remove(a.session, "zzzzzzzzzzzzzzzzzzzz");
  const foreign = await remove(a.session, victim.id);
  is("B's id answers A exactly as an id nobody has", [foreign.status, unknown.status, (foreign.body as { ok?: unknown }).ok], [unknown.status, unknown.status, (unknown.body as { ok?: unknown }).ok]);
  is("B's public link still opens B's numbers", await linkStore(victim.id), b.sid);
  is("B's studio still lists it, unchanged", (await storeForEmail("owner-b@example.com"))!.numbersLinks.map((l) => [l.id, l.hash]), [[victim.id, victim.hash]]);
  is("A's record gained nothing", (await storeForEmail("owner-a@example.com"))!.numbersLinks.length, 0);

  part("B takes its own link back");
  const own = await remove(b.session, victim.id);
  is("answered as taken back", [own.status, own.body], [200, { ok: true, id: victim.id }]);
  is("the public link stops at once", await linkStore(victim.id), null);
  is("and it leaves B's studio", (await storeForEmail("owner-b@example.com"))!.numbersLinks.length, 0);

  part("An index still naming this store is let go even when the record no longer holds it");
  const stale = makeLink({ label: "Old partner", password: "harbor-2026", days: 7, money: false }, NOW);
  if (!stale.ok) throw new Error("no link");
  await indexLink(b.sid, stale.link, NOW);
  await remove(b.session, stale.link.id);
  is("B's own stale index is cleared", await linkStore(stale.link.id), null);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
