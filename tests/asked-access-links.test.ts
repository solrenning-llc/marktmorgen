/**
 * MM-SA-47 (docs/security-audit-2026-10-28.md; 506 [SG1]; the MM-SA-05 class):
 * the buyer library link (lib/buyer-library.ts, requestLibraryLink) and the
 * affiliate page link (lib/affiliate-hub.ts, requestHubLink) are sent to an
 * address anyone may type, yet each took one of the store's access emails as
 * if a buyer's own purchase had asked for it. Typing the store's buyers'
 * addresses from many connections could spend the month's access emails, and
 * the links buyers are sent after paying would then not go. A confirmation to
 * a typed address may use only part of them (lib/store-allowance-rules.ts,
 * askedCeiling, `asked` on the email's meter), as every other such form does.
 *
 * What fails here: more library links sent for one store than askedCeiling of
 * its access emails; the affiliate page link's meter without `asked`.
 * Synthetic store and buyers, Redis stand-in, emails caught here.
 */
import { readFileSync } from "node:fs";
import { rememberBuyers, requestLibraryLink } from "@/lib/buyer-library";
import { allowanceFor, askedCeiling } from "@/lib/store-allowance-rules";
import { claimHandle, ensureStoreId, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

let sent = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (new URL(String(input)).hostname === "api.resend.com") {
    sent += 1;
    return new Response(JSON.stringify({ id: `email_${sent}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

async function main(): Promise<void> {
  redis.clear();
  process.env.RESEND_API_KEY = "re_test_library_only_a_stand_in";
  const OWNER = "owner@example.com";
  await claimHandle(OWNER, "alpha", "Alpha", "");
  await ensureStoreId(OWNER);
  const store = (await storeForEmail(OWNER))!;
  const whole = allowanceFor(store, "transactional");
  const ceiling = askedCeiling(whole);

  part("Library links asked for a store's buyers, from many connections");
  is("the store has access emails, and a typed address may use only part of them", whole > 0 && ceiling > 0 && ceiling < whole, true);
  const buyers = Array.from({ length: whole + 3 }, (_, i) => `buyer-${i}@example.com`);
  await rememberBuyers(store.sid, buyers);
  for (const [i, email] of buyers.entries()) await requestLibraryLink({ email, ip: `198.51.${Math.floor(i / 250)}.${i % 250}`, origin: "https://marktmorgen.com" });
  is(`at most ${ceiling} sent, so the rest stays for the links buyers are sent after paying`, sent, ceiling);

  part("The affiliate page link is a typed address too");
  const hub = readFileSync("lib/affiliate-hub.ts", "utf8");
  is("its email's meter says asked", /meter: \{ by: "store", store: charged, kind: "transactional", asked: true \}/.test(hub), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
