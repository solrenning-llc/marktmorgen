/**
 * SG1-B-01 (queue item 506 [SG1]): one store could end another store's
 * numbers link.
 *
 * A numbers link (lib/numbers-links.ts) lets a sponsor follow a store's
 * counted numbers at /numbers/<id>; the id is in the address the creator
 * hands out, and `nl:nlink:<id>` names the store it belongs to. Taking a link
 * back (app/api/store/numbers-links, `{ action: "remove", id }`) let go of
 * that index for any id it was sent, without asking whether the store held
 * it, so anyone with settings on any store who saw another store's address
 * could make it answer "not found" while that store's studio still showed it
 * as working.
 *
 * Proved against a real Redis, through the real route with real sessions:
 * store A sends B's id and nothing of B's changes; B takes its own link back
 * and it stops at once.
 */
import { NextRequest } from "next/server";
import { POST } from "@/app/api/store/numbers-links/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { indexLink, linkStore, makeLink } from "@/lib/numbers-links";
import { addNumbersLink, claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { check, finish } from "./check";

globalThis.fetch = ((real) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (String(url).startsWith(String(process.env.UPSTASH_REDIS_REST_URL))) return real(input as string, init);
    throw new Error(`no network in this check: ${url.hostname}`);
  }) as typeof fetch)(globalThis.fetch);

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
  return { sid: (await storeForEmail(email))!.sid, session: await openSession(email) };
}

async function main(): Promise<void> {
  process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
  const now = Date.now();
  const a = await openStore("owner@numbers-a.example", "numbers-owner-a");
  const b = await openStore("owner@numbers-b.example", "numbers-owner-b");
  const made = makeLink({ label: "Acme sponsorship", password: "harbor-2026", days: 30, money: true }, now);
  if (!made.ok) throw new Error("no link");
  await addNumbersLink("owner@numbers-b.example", made.link, now);
  await indexLink(b.sid, made.link, now);
  check("B's link opens B's numbers", await linkStore(made.link.id), b.sid);

  const unknown = await remove(a.session, "zzzzzzzzzzzzzzzzzzzz");
  const foreign = await remove(a.session, made.link.id);
  check("A sending B's id is answered as an id nobody has", [foreign.status, (foreign.body as { ok?: unknown }).ok], [unknown.status, (unknown.body as { ok?: unknown }).ok]);
  check("B's public link still opens B's numbers", await linkStore(made.link.id), b.sid);
  check("B's studio still lists it", (await storeForEmail("owner@numbers-b.example"))!.numbersLinks.map((l) => l.id), [made.link.id]);

  const own = await remove(b.session, made.link.id);
  check("B takes its own link back", own.status, 200);
  check("and it stops opening at once", await linkStore(made.link.id), null);
  check("A's store is untouched throughout", [(await storeForEmail("owner@numbers-a.example"))!.numbersLinks.length, a.sid !== b.sid], [0, true]);
  finish();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
