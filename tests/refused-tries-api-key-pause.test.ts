/**
 * The email to a teammate whose API keys the team's two-step rule paused
 * (lib/api-key-pause.ts, tellPaused, from the owner's "Finish") when the
 * sender refuses it for certain every time (rule 30; Claude 5's MEDIUM on the
 * -v3 branches, 9 November 2026).
 *
 * A certain refusal puts the keys back for the next press; a refusal can come
 * after the store's figure was taken (a stop before the request since #3377,
 * a 4xx after it: a 422 here), so each press took one more of the store's
 * emails, with no end. Each refusal is now counted (lib/refused-tries.ts, a
 * day): past REFUSED_TRIES the press sends nothing to that person and takes
 * nothing, and the page says when it is tried again instead of "Press Finish
 * now". The sender is a stand-in for `fetch`; no real email is sent.
 */
import { keyRecords, makeKey, swapHolds } from "@/lib/api-keys";
import { makerFor, tellPaused } from "@/lib/api-key-pause";
import { putMember } from "@/lib/team";
import { type Store, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";
import { unfinishedWords } from "@/components/team-two-step-switch";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    const to = [body.to ?? ""].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return new Response(JSON.stringify({ id: `email_${asked.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const OWNER = "owner-refused@example.com";
const UNA = "una-admin@example.com";
const TOM = "tom-admin@example.com";
const REX = "rex-admin@example.com";
const OLA = "ola-admin@example.com";

const askedOf = (email: string) => asked.filter((to) => to === email).length;
const answerOf = (status: number) => new Response(JSON.stringify({ message: "stand-in" }), { status });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "keys-refused", "Keys Refused", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_keysrefused", subscriptionId: "sub_keysrefused", active: true, tier: "creator", period: paidPeriod() });
  const store: Store = (await storeForEmail(OWNER))!;
  if (!store.sid) throw new Error("no store id");
  if (!(await putMember(store, REX, "admin"))) throw new Error("no member");
  const made = await makeKey(store.sid, "rex's key", Date.now(), false, "none", makerFor(store.sid, "admin", REX, false));
  if (!made.ok) throw new Error("no key");
  if ((await swapHolds(store.sid, [made.made.id], "paused", [null])).length !== 1) throw new Error("key not paused");
  const hold = async () => (await keyRecords(store.sid)).find((k) => k.id === made.made.id)?.hold ?? null;
  senderAnswers.set(REX, () => answerOf(422));
  const usedBefore = await allowanceUsed(store, "email");

  part("The owner presses Finish six times; the sender refuses the email for certain each time");
  let last: Awaited<ReturnType<typeof tellPaused>> | null = null;
  for (let press = 0; press < 6; press += 1) last = await tellPaused(store, ORIGIN);
  is("the sender is asked at most REFUSED_TRIES (3) times", askedOf(REX), 3);
  is("the store's figure is taken at most 3 times", (await allowanceUsed(store, "email")) - usedBefore, 3);
  is("the key stays paused and its maker waits", [await hold(), last?.waiting], ["paused", 1]);
  is("the answer says the email was refused too often today", (last as { refused?: number } | null)?.refused, 1);
  const words = unfinishedWords({ waiting: 1, emailed: 0, uncertain: 0, refused: 1 } as Parameters<typeof unfinishedWords>[0]);
  is("the page never says to press Finish now for an email that is not tried again today", /Press Finish now/.test(words), false);
  is("it says when it is tried again", /tomorrow/.test(words), true);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
