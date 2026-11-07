/**
 * A buyer's library (lib/buyer-library.ts, added 11 October 2026). What is
 * checked:
 *
 *   - an address is noted against a store's id, whatever its capitals, and
 *     nothing else about the purchase is kept;
 *   - a store that hands a purchase over another way — a gift, a place
 *     bought for somebody — is in the library too, and since 18 October 2026
 *     what a creator brings over from another platform is not: it was not
 *     bought on Marktmorgen;
 *   - each store is kept in the set of the quarter it was noted in, which
 *     ends on its own day (lib/joined-stores.ts);
 *   - the link is emailed only to an address that bought something, the
 *     answer is the same either way, and it opens the library for that
 *     address only.
 */
import { libraryOwner, rememberBuyers, requestLibraryLink, storesBoughtFrom } from "@/lib/buyer-library";
import { grantImported } from "@/lib/imported-purchases";
import { claimHandle, ensureStatsId, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { afterTasks } from "./next-server-after-world";
import { PERSON_RECORD_MONTHS } from "@/lib/joined-stores";
import { ROOM } from "./data-room";
import { done, is, part } from "./check";

const sent: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body)) as { to: string | string[]; subject: string; text: string };
    sent.push({ to: [body.to].flat()[0], subject: body.subject, text: body.text });
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

/** Runs what the answers left for after them, as Next does once each answer is sent (lib/after-answer.ts). */
async function drain(): Promise<void> {
  while (afterTasks.length) await (afterTasks.shift() as () => Promise<unknown>)();
}

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_library_only_a_stand_in";
  const A = "a@example.com";
  const B = "b@example.com";
  await claimHandle(A, "alpha", "Alpha", "");
  await claimHandle(B, "beta", "Beta", "");
  await ensureStoreId(A);
  await ensureStoreId(B);
  await ensureStatsId(B);
  const alpha = (await storeForEmail(A))!;
  const beta = (await storeForEmail(B))!;

  part("What is kept");
  await rememberBuyers(alpha.sid, ["Buyer@Example.com"]);
  is("the store's id, under the address whatever its capitals", await storesBoughtFrom("buyer@example.com"), [alpha.sid]);
  const keys = [...(redis as unknown as { data: Map<string, unknown> }).data.keys()].filter((k) => k.startsWith("nl:lib:"));
  is("and the address itself is nowhere in the key", keys.some((k) => k.includes("buyer")), false);
  await grantImported(beta.statsId!, "job1", [{ email: "buyer@example.com", productId: "p1", items: null }], undefined, beta.sid);
  is("a purchase handed over another way puts its store in too", (await storesBoughtFrom("buyer@example.com")).sort(), [alpha.sid, beta.sid].sort());
  await grantImported(beta.statsId!, "job2", [{ email: "brought@example.com", productId: "p1", items: null }], undefined, beta.sid, ROOM);
  is("a purchase brought over from another platform does not", await storesBoughtFrom("brought@example.com"), []);
  const quarter = keys.find((k) => /^nl:lib:\d{4}q[1-4]:[0-9a-f]{40}$/.test(k)) ?? "";
  const ttl = Number((await redis.pipeline([["TTL", quarter]]))[0]);
  is("kept in its quarter's set, which ends three years and at most a quarter on", [quarter !== "", ttl >= 3 * 365 * 86_400 - 86_400, ttl <= PERSON_RECORD_MONTHS * 31 * 86_400], [true, true, true]);

  part("Signing in by email");
  // The stores, the link and the email run after the answer since 07/11/2026 (the access-link timing fix): drained before each look.
  const nobody = await requestLibraryLink({ email: "nobody@example.com", ip: "203.0.113.1", origin: "https://marktmorgen.com" });
  await drain();
  is("an address that bought nothing: the same answer, and no email", [nobody, sent.length], ["sent", 0]);
  is("not an address", await requestLibraryLink({ email: "nope", ip: "203.0.113.1", origin: "https://marktmorgen.com" }), "email");
  const asked = await requestLibraryLink({ email: "BUYER@example.com", ip: "203.0.113.1", origin: "https://marktmorgen.com" });
  await drain();
  is("a buyer: a link to their library", [asked, sent.at(-1)?.to, sent.at(-1)?.text.includes("from 2 stores")], ["sent", "buyer@example.com", true]);
  const token = sent.at(-1)?.text.match(/token=([0-9a-f]{64})/)?.[1] ?? "";
  is("the link opens it for that address, and a made-up one for nobody", [await libraryOwner(token), await libraryOwner("0".repeat(64))], ["buyer@example.com", null]);
  for (let i = 0; i < 6; i += 1) await requestLibraryLink({ email: "buyer@example.com", ip: `203.0.113.${10 + i}`, origin: "https://marktmorgen.com" });
  is("a few times an hour per address, then no more", await requestLibraryLink({ email: "buyer@example.com", ip: "203.0.113.99", origin: "https://marktmorgen.com" }), "limited");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
