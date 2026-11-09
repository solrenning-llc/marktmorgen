/**
 * The notices to a creator whose plan ended (lib/plan-closing.ts, closeOne
 * and its `send`) under a sender whose answer is not known (rule 30, a
 * sibling of 283 [HG2] unit 1's sendEmailOutcome).
 *
 * Before, a send that may have gone (a server error, or a network error after
 * the request) was held as "the notice could not be sent", and the daily job
 * sent it again: once the day of the sender's idempotency key had passed,
 * the creator had the same notice twice. An uncertain send is now written
 * down as sent, so it is never asked again; only a certain refusal holds the
 * notice for the next day. The same `send` writes the "files removed" letter
 * (`said`), so that letter is held the same way. Stripe and the sender are
 * played by a stand-in for `fetch`, and what a store keeps by a stand-in for
 * the file store; no real email is sent. Checked:
 *
 *   - a 500 from the sender: told, and the next day's run does not write again;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): held, and the next day's run sends it
 *     (control: unchanged behavior);
 *   - a plain yes: one notice (control).
 */
import { type Hands, closeOne } from "@/lib/plan-closing";
import { claimHandle, setSubscription, storeForEmail } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const GB = 1024 * 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
/** Every recipient the sender was asked for, taken or not. */
const asked: string[] = [];
/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  if (url.hostname === "api.resend.com") {
    const to = [(JSON.parse(String(init?.body)) as { to: string | string[] }).to].flat()[0] ?? "";
    asked.push(to);
    const special = senderAnswers.get(to);
    if (special) return special();
    return json({ id: `email-${asked.length}` });
  }
  if (url.hostname === "api.stripe.com") return json({ data: [], has_more: false });
  return new Response(null, { status: 404 });
}) as typeof fetch;

/** Every store keeps more than a store with no plan's room, in a stand-in file store. */
const hands: Hands = { measure: async () => 6 * GB, list: async () => [], remove: async () => {} };

const realNow = Date.now.bind(Date);
const clockAt = (ms: number) => {
  const shift = ms - realNow();
  Date.now = () => realNow() + shift;
};

async function ended(handle: string): Promise<{ email: string; end: number }> {
  const email = `${handle}@example.com`;
  await claimHandle(email, handle, `${handle[0].toUpperCase()}${handle.slice(1)} Studio`, "");
  await setSubscription(email, { customerId: `cus_${handle}0001`, subscriptionId: `sub_${handle}0001`, active: true, tier: "creator", cycle: "month", trialEnds: 0 });
  await setSubscription(email, { active: false });
  return { email, end: Date.parse((await storeForEmail(email))!.planEndedAt ?? "") };
}

const askedOf = (email: string) => asked.filter((to) => to === email).length;
const answerOf = (status: number) => new Response(JSON.stringify({ message: "stand-in" }), { status });

async function main(): Promise<void> {
  redis.clear();
  // A plan that ended before 18 October 2026 keeps a store with no plan's room, and its store does not close (lib/plan-closing-rules.ts).
  clockAt(Date.UTC(2026, 9, 10, 12, 0, 0));
  process.env.STRIPE_SECRET_KEY = "sk_test_a_stand_in_key_for_tests_only";
  process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
  const una = await ended("una");
  const tom = await ended("tom");
  const rex = await ended("rex");
  const ola = await ended("ola");
  senderAnswers.set(una.email, () => answerOf(500));
  senderAnswers.set(tom.email, () => {
    throw new TypeError("fetch failed: the connection was reset");
  });
  senderAnswers.set(rex.email, () => answerOf(422));

  part("The notice when the plan ends");
  const first = [];
  for (const one of [una, tom, rex, ola]) first.push(await closeOne(one.email, one.end + 60_000, hands));
  is("each creator's sender was asked once", [askedOf(una.email), askedOf(tom.email), askedOf(rex.email), askedOf(ola.email)], [1, 1, 1, 1]);
  is("a 500 and a thrown request are written down as told: they may have gone", first.slice(0, 2).map((row) => [row.state, row.note]), [["told", "ended"], ["told", "ended"]]);
  is("a certain refusal is held for the next day", [first[2].state, first[2].note], ["held", "the notice could not be sent"]);
  is("a plain yes is told (control)", [first[3].state, first[3].note], ["told", "ended"]);

  part("The next day's run, after the day of the sender's key");
  senderAnswers.clear();
  clockAt(Date.UTC(2026, 9, 11, 13, 0, 0));
  const next = [];
  for (const one of [una, tom, rex, ola]) next.push(await closeOne(one.email, one.end + DAY + 3_600_000, hands));
  is("the uncertain notices are not sent a second time", [askedOf(una.email), askedOf(tom.email)], [1, 1]);
  is("the refused one is sent now, once", [askedOf(rex.email), next[2].state, next[2].note], [2, "told", "ended"]);
  is("the one that went is not sent again (control)", [askedOf(ola.email), next[3].state], [1, "waiting"]);

  Date.now = realNow;
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
