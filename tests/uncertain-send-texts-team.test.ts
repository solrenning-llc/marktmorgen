/**
 * A team invitation whose email is not known to have gone (rule 30, a
 * sibling of 283 [HG2] unit 1's sendEmailOutcome): lib/team.ts inviteMember,
 * app/api/store/team/route.ts and components/team-manager.tsx.
 *
 * Found 9 November 2026: a sender's answer that was not known (a 5xx, a
 * network error after the request may have reached it) was taken for "not
 * sent", so the invitation was taken back and the owner read "could not be
 * sent just now, so nothing was kept". The email may have arrived, and its
 * link then did nothing. Checked:
 *
 *   - the sender answers 500: the invitation is kept and stays on the list,
 *     its link (read from the email the stand-in kept) lets the person join,
 *     and the route answers ok with `uncertain`, so the studio says it could
 *     not confirm the email went and to ask them before sending a new one;
 *   - a thrown request (network error): the same;
 *   - a 422 (a certain refusal): taken back and "unsent", as before (control);
 *   - a plain yes: ok, with no `uncertain` (control);
 *   - the studio's words for each answer.
 *
 * Synthetic stores and sessions; the sender is a stand-in for `fetch`, so
 * no real email is sent.
 */
import { NextRequest } from "next/server";
import { POST as teamRoute } from "@/app/api/store/team/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { inviteMember, readLog, readTeam, spendInvite } from "@/lib/team";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import * as teamManager from "@/components/team-manager";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";

const mails: { to: string; text: string }[] = [];
let senderAnswer: (() => Response) | null = null;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.hostname === "api.resend.com") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; text?: string };
    // Kept whatever the answer: a request whose answer is lost may still have been delivered.
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), text: String(body.text ?? "") });
    if (senderAnswer) return senderAnswer();
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const SERVER_ERROR = () => new Response("{}", { status: 500 });
const REFUSED = () => new Response(JSON.stringify({ message: "not a valid address" }), { status: 422 });
const THROWN = () => { throw new TypeError("network error"); };
// Read off the module, so this file still runs (and fails) before the studio's words exist.
const inviteDoneWords = (email: string, uncertain: boolean): string => {
  const words = (teamManager as Record<string, unknown>).inviteDoneWords;
  return typeof words === "function" ? String(words(email, uncertain)) : "(no inviteDoneWords)";
};
const tokenTo = (to: string) => /\/signin\/join\?token=([0-9a-f]{64})/.exec([...mails].reverse().find((m) => m.to === to)?.text ?? "")?.[1] ?? "";

async function main(): Promise<void> {
  redis.clear();
  const OWNER = "owner-team-unsure@example.com";
  await claimHandle(OWNER, "team-unsure", "Team Unsure", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_TeamUnsure01", subscriptionId: "sub_TeamUnsure01", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  const session = await openSession(OWNER, "passkey", "pk-owner-unsure");
  const invite = async (email: string, answer: (() => Response) | null) => {
    senderAnswer = answer;
    const response = await teamRoute(
      new NextRequest(`https://marktmorgen.com/api/store/team?store=${store.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: "https://marktmorgen.com", host: "marktmorgen.com" },
        body: JSON.stringify({ action: "invite", email, role: "editor" }),
      }),
    );
    senderAnswer = null;
    return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; uncertain?: boolean; invite?: { email: string } } };
  };
  const waiting = async () => (await readTeam(store.sid)).invites.map((i) => i.email).sort();

  part("The sender's answer not known: the invitation is kept");
  const ANA = "ana-unsure@example.com";
  const unsure = await invite(ANA, SERVER_ERROR);
  is("a 500: ok, said to be not confirmed", [unsure.status, unsure.body.ok, unsure.body.uncertain, unsure.body.invite?.email], [200, true, true, ANA]);
  is("still waiting on the team's list", await waiting(), [ANA]);
  const log = (await readLog(store.sid)).map((line) => line.what);
  is("the log says its email was not confirmed", log.includes(`Invited ${ANA} as Editor (its email could not be confirmed as sent)`), true);
  const joined = await spendInvite(tokenTo(ANA));
  is("the link in the email that may have arrived works", [joined.ok, joined.ok ? joined.member.email : ""], [true, ANA]);

  const BEN = "ben-unsure@example.com";
  const thrown = await inviteMember(store, BEN, "editor", "https://marktmorgen.com").catch(() => null);
  is("a plain yes from inviteMember first (control)", thrown && thrown.ok ? [thrown.ok, "uncertain" in thrown] : thrown, [true, false]);
  const CAL = "cal-unsure@example.com";
  senderAnswer = THROWN;
  const network = await inviteMember(store, CAL, "editor", "https://marktmorgen.com");
  senderAnswer = null;
  is("a thrown request: kept, said to be not confirmed", [network.ok, network.ok && network.uncertain], [true, true]);
  is("both still waiting", await waiting(), [BEN, CAL]);

  part("A certain refusal is taken back, as before (control)");
  const DOT = "dot-refused@example.com";
  const refused = await invite(DOT, REFUSED);
  is("a 422: unsent", [refused.status, refused.body.ok, refused.body.error], [502, false, "unsent"]);
  is("and not kept", (await waiting()).includes(DOT), false);

  part("The studio's words");
  is("sent", inviteDoneWords(" eve@example.com ", false), "Invitation sent to eve@example.com.");
  is("not confirmed: true, and says what to do before sending again",
    inviteDoneWords("eve@example.com", true),
    "The invitation to eve@example.com is saved, but we could not confirm its email was sent. It may still arrive, so ask them before you take it back and send a new one.");

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
