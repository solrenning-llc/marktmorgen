/**
 * What the owner's team page says after "Turn it on" or "Finish now" when an
 * email to a teammate whose API keys were paused may have gone but was not
 * confirmed (lib/api-key-pause.ts tellPaused, app/api/store/team/route.ts
 * finish, components/team-two-step-switch.tsx; VR item 2, rule 30 after the
 * uncertain-send fix in the same branch).
 *
 * tellPaused keeps such a person's keys told, so they are counted as neither
 * emailed nor waiting. Before, the route answered only `emailed`, and the page
 * said "2 people were emailed" as if that were everyone, with nothing about
 * the email that may still arrive. Now the route also answers `uncertain`, and
 * the page says it. The sender is a stand-in for `fetch`; no real email is
 * sent. Checked through the real route:
 *
 *   - two plain yeses and one 500: ok, 3 paused, 2 emailed, 1 uncertain, and
 *     the words say 2 were emailed and 1 more could not be confirmed;
 *   - one yes, one 500 and one certain refusal: not finished, 1 emailed,
 *     1 waiting, 1 uncertain, and the words say all three;
 *   - with nothing uncertain, the words stay exactly as before (control).
 */
import { NextRequest } from "next/server";
import { POST as teamRoute } from "@/app/api/store/team/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { makeKey } from "@/lib/api-keys";
import { makerFor, pausePreview } from "@/lib/api-key-pause";
import { putMember } from "@/lib/team";
import { type Store, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import * as screen from "@/components/team-two-step-switch";
import { makePasskey } from "./passkey-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

/** How the sender answers one recipient, when not plainly yes. */
const senderAnswers = new Map<string, () => Response>();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[] };
    const to = [body.to ?? ""].flat()[0] ?? "";
    const special = senderAnswers.get(to);
    if (special) return special();
    return new Response(JSON.stringify({ id: `email_${to}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const ORIGIN = "https://marktmorgen.com";
const answerOf = (status: number) => new Response(JSON.stringify({ message: "stand-in" }), { status });

type Answer = { ok?: boolean; error?: string; paused?: number; emailed?: number; waiting?: number; uncertain?: number };
type Words = (answer: Answer) => string;
const words = screen as unknown as Record<string, Words | undefined>;
const say = (name: string, answer: Answer) => (typeof words[name] === "function" ? words[name]!(answer) : `no ${name} in the component`);

async function storeWith(owner: string, handle: string, members: string[]): Promise<{ store: Store; session: string }> {
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/-/g, "")}`, subscriptionId: `sub_${handle.replace(/-/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  if (!store.sid) throw new Error("no store id");
  for (const email of members) {
    if (!(await putMember(store, email, "admin"))) throw new Error(`no member ${email}`);
    const made = await makeKey(store.sid, `${email.split("@")[0]}'s key`, Date.now(), false, "none", makerFor(store.sid, "admin", email, false));
    if (!made.ok) throw new Error(`no key for ${email}`);
  }
  await makePasskey(owner, `pk-${handle}`).keep();
  return { store, session: await openSession(owner, "passkey", `pk-${handle}`) };
}

async function turnOn(store: Store, session: string): Promise<{ status: number; body: Answer }> {
  const response = await teamRoute(
    new NextRequest(`${ORIGIN}/api/store/team?store=${store.sid}`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" },
      body: JSON.stringify({ action: "two-step", on: true, expect: (await pausePreview(store)).stamp }),
    }),
  );
  return { status: response.status, body: (await response.json()) as Answer };
}

async function main(): Promise<void> {
  redis.clear();

  part("Two emails went and one may have gone");
  const ana = "ana-admin@example.com";
  const bo = "bo-admin@example.com";
  const cy = "cy-admin@example.com";
  const first = await storeWith("owner-screen-one@example.com", "screen-one", [ana, bo, cy]);
  senderAnswers.set(cy, () => answerOf(500));
  const one = await turnOn(first.store, first.session);
  is("the route answers who was emailed and who may have been", [one.status, one.body.ok, one.body.paused, one.body.emailed, one.body.uncertain], [200, true, 3, 2, 1]);
  is(
    "the page never says 2 as if it were everyone: it says the one it could not confirm",
    say("turnedOnWords", one.body),
    "Turned on. 3 API keys are paused, and 2 people were emailed how to turn theirs back on. We could not confirm the email to 1 more person; it may still arrive.",
  );

  part("One went, one may have gone, one was refused");
  const di = "di-admin@example.com";
  const ed = "ed-admin@example.com";
  const flo = "flo-admin@example.com";
  const second = await storeWith("owner-screen-two@example.com", "screen-two", [di, ed, flo]);
  senderAnswers.set(ed, () => answerOf(500));
  senderAnswers.set(flo, () => answerOf(422));
  const two = await turnOn(second.store, second.session);
  is("not finished: 1 emailed, 1 waiting, 1 uncertain", [two.status, two.body.error, two.body.emailed, two.body.waiting, two.body.uncertain], [502, "incomplete", 1, 1, 1]);
  is(
    "the words say the one still to email and the one not confirmed",
    say("unfinishedWords", two.body),
    "Turned on, but not finished: 1 key's maker was not emailed yet. We could not confirm the email to 1 more person; it may still arrive. Press Finish now to try again.",
  );

  part("Nothing uncertain: the words are as before (control)");
  is("all emailed", say("turnedOnWords", { ok: true, paused: 2, emailed: 2, uncertain: 0 }), "Turned on. 2 API keys are paused, and 2 people were emailed how to turn theirs back on.");
  is("nothing paused", say("turnedOnWords", { ok: true, paused: 0, emailed: 0 }), "Turned on. Everyone on the team now logs in with a second step.");
  is("nothing paused, one emailed on a later press", say("turnedOnWords", { ok: true, paused: 0, emailed: 1 }), "Turned on. Everyone on the team now logs in with a second step. 1 person was emailed about their paused keys.");
  is("one waiting", say("unfinishedWords", { error: "incomplete", waiting: 1 }), "Turned on, but not finished: 1 key's maker was not emailed yet. Press Finish now to try again.");
  is("not paused yet", say("unfinishedWords", { error: "incomplete" }), "Turned on, but not finished: some keys may not be paused yet. Press Finish now to try again.");

  part("Only uncertain, none confirmed");
  is(
    "nobody is called more",
    say("turnedOnWords", { ok: true, paused: 1, emailed: 0, uncertain: 1 }),
    "Turned on. 1 API key is paused, and 0 people were emailed how to turn theirs back on. We could not confirm the email to 1 person; it may still arrive.",
  );

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
