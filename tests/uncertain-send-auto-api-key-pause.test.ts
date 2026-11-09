/**
 * The email to a teammate whose API keys the team's two-step rule paused
 * (lib/api-key-pause.ts, tellPaused, from the owner's "Finish") under a
 * sender whose answer is not known (rule 30, a sibling of 283 [HG2] unit 1's
 * sendEmailOutcome).
 *
 * Before, a send that may have gone (a server error, or a network error after
 * the request) put the teammate's keys back from told to paused, so the
 * owner's next "Finish" wrote to them again (the email has no idempotency
 * key). The keys now stay told on an uncertain answer and the person is
 * counted as neither emailed nor waiting; only a certain refusal puts them
 * back for the next press. The sender is played by a stand-in for `fetch`;
 * no real email is sent. Checked:
 *
 *   - a 500 from the sender: the keys stay told, the next press writes nothing;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): put back and waiting, the next press writes
 *     again (control: unchanged behavior);
 *   - a plain yes: emailed once, told (control);
 *   - each email is taken from the store's figure once, the uncertain ones
 *     included.
 */
import { keyRecords, makeKey, swapHolds } from "@/lib/api-keys";
import { makerFor, tellPaused } from "@/lib/api-key-pause";
import { putMember } from "@/lib/team";
import { type Store, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { allowanceUsed } from "@/lib/store-allowance";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

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
const OWNER = "owner-uncertain@example.com";
const UNA = "una-admin@example.com";
const TOM = "tom-admin@example.com";
const REX = "rex-admin@example.com";
const OLA = "ola-admin@example.com";

const askedOf = (email: string) => asked.filter((to) => to === email).length;
const answerOf = (status: number) => new Response(JSON.stringify({ message: "stand-in" }), { status });

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "keys-uncertain", "Keys Uncertain", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_keysuncertain", subscriptionId: "sub_keysuncertain", active: true, tier: "creator", period: paidPeriod() });
  const store: Store = (await storeForEmail(OWNER))!;
  if (!store.sid) throw new Error("no store id");
  const keyOf = new Map<string, string>();
  for (const email of [UNA, TOM, REX, OLA]) {
    if (!(await putMember(store, email, "admin"))) throw new Error(`no member ${email}`);
    const made = await makeKey(store.sid, `${email.split("-")[0]}'s key`, Date.now(), false, "none", makerFor(store.sid, "admin", email, false));
    if (!made.ok) throw new Error(`no key for ${email}`);
    keyOf.set(email, made.made.id);
  }
  if ((await swapHolds(store.sid, [...keyOf.values()], "paused", [null])).length !== 4) throw new Error("keys not paused");
  const holdOf = async (email: string) => (await keyRecords(store.sid)).find((k) => k.id === keyOf.get(email))?.hold ?? null;
  senderAnswers.set(UNA, () => answerOf(500));
  senderAnswers.set(TOM, () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set(REX, () => answerOf(422));
  const usedBefore = await allowanceUsed(store, "email");

  part("The owner's first press");
  const first = await tellPaused(store, ORIGIN);
  is("each teammate's sender was asked once", [askedOf(UNA), askedOf(TOM), askedOf(REX), askedOf(OLA)], [1, 1, 1, 1]);
  is("a 500 and a thrown request keep the keys told: the email may have gone", [await holdOf(UNA), await holdOf(TOM)], ["told", "told"]);
  is("a certain refusal puts the key back", await holdOf(REX), "paused");
  is("only the plain yes is said to be emailed, only the refusal waits", [first.emailed, first.waiting], [[OLA], 1]);

  part("The owner's next press");
  senderAnswers.clear();
  const second = await tellPaused(store, ORIGIN);
  is("the uncertain ones are not written a second time", [askedOf(UNA), askedOf(TOM)], [1, 1]);
  is("the refused one is written now, once", [askedOf(REX), await holdOf(REX), second.emailed, second.waiting], [2, "told", [REX], 0]);
  is("the one that went is not written again (control)", askedOf(OLA), 1);
  is("each request took one of the store's emails", (await allowanceUsed(store, "email")) - usedBefore, 5);

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
