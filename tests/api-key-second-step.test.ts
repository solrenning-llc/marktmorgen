/**
 * API keys and the second step.
 *
 * (A) Making a key (app/api/store/api-keys/route.ts, "make") on an account
 * that has a second step needs a session opened with it
 * (lib/second-step-gate.ts liveSecondStep); a session from the emailed link
 * alone is refused, and an account without any second step makes keys as
 * before.
 *
 * (B) Owner C3-100 (lib/api-key-pause.ts): when the owner turns on the team's
 * two-step rule (app/api/store/team/route.ts, "two-step"), the keys teammates
 * made without a second step pause, never deleted; the owner's never change;
 * before saving, the page says how many and whose, and a save whose reviewed
 * number is stale is refused; each affected teammate gets one email; the
 * maker turns a key back on from a session with a second step; turning the
 * rule off turns nothing back on.
 *
 * Synthetic records, sessions and stores; no email leaves (Resend is stubbed).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST as keysRoute } from "@/app/api/store/api-keys/route";
import { POST as teamRoute } from "@/app/api/store/team/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { keyRecords, makeKey, resolveKey, revokeKey } from "@/lib/api-keys";
import { makerFor, pauseIfRuleOn, pausePreview, pausesUnderRule, shownKeys } from "@/lib/api-key-pause";
import { MAKER_FORMER, MAKER_UNRECORDED } from "@/lib/api-key-rules";
import { apiStore } from "@/lib/api-guard";
import { putMember, readTeam, removeMember } from "@/lib/team";
import { claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { TeamTwoStepReview } from "@/components/team-two-step-switch";
import { makePasskey } from "./passkey-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_api_key_second_step_only";
const mails: { to: string; subject: string; text: string }[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    mails.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${mails.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;

const OWNER = "owner-keys@example.com";
const PIA = "pia-passkey@example.com"; // an Admin with a passkey
const NED = "ned-nothing@example.com"; // an Admin with no second step
const FAY = "fay-former@example.com"; // an Admin who leaves the team
const ORIGIN = "https://marktmorgen.com";

async function main(): Promise<void> {
  redis.clear();
  await claimHandle(OWNER, "keys-two-step", "Keys Two Step", "");
  await ensureStoreId(OWNER);
  await ensureStatsId(OWNER);
  await ensureListId(OWNER);
  await setSubscription(OWNER, { customerId: "cus_keystwostep", subscriptionId: "sub_keystwostep", active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(OWNER))!;
  if (!store.sid) throw new Error("no store id");
  for (const email of [PIA, NED, FAY]) await putMember(store, email, "admin");

  const post = (route: typeof keysRoute, path: string, session: string, body: unknown) =>
    route(
      new NextRequest(`${ORIGIN}${path}?store=${store.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" },
        body: JSON.stringify(body),
      }),
    );
  const keys = async (session: string, body: unknown) => {
    const response = await post(keysRoute, "/api/store/api-keys", session, body);
    return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; key?: string; made?: { id: string }; paused?: boolean } };
  };
  const team = async (session: string, body: unknown) => {
    const response = await post(teamRoute, "/api/store/team", session, body);
    return { status: response.status, body: (await response.json()) as { ok: boolean; error?: string; on?: boolean; paused?: number; emailed?: number; preview?: { total: number } } };
  };
  const make = (session: string, name: string) => keys(session, { action: "make", name });
  // Keys are handed out under "export", which has a small daily figure of its own (lib/studio-route.ts countStudio):
  // this test makes more than a day's worth, so each part starts a new day.
  const newDay = () => redis.pipeline([["DEL", `nl:rl:studio-essential:${createHash("sha256").update(`nimbus-studio-essential:${store.sid}`).digest("hex").slice(0, 32)}`]]);
  const asApi = async (key: string) => {
    const found = await apiStore(new Request(`${ORIGIN}/api/v1/store`, { headers: { authorization: `Bearer ${key}` } }));
    if (found instanceof Response) return { status: found.status, error: ((await found.json()) as { error?: string }).error };
    return { status: 200, error: "" };
  };

  // ------------------------------------------------------------------ (A)
  await newDay();
  part("(A) Making a key on an account with a second step needs a session opened with it");
  const piaKey = makePasskey(PIA, "pk-pia");
  await piaKey.keep();
  const piaLink = await openSession(PIA);
  const refused = await make(piaLink, "Zapier");
  is("an emailed-link session on a passkey account is refused", [refused.status, refused.body.error], [403, "second_step"]);
  is("and no key was made", (await keyRecords(store.sid)).length, 0);
  const piaPasskey = await openSession(PIA, "passkey", "pk-pia");
  const piaMade = await make(piaPasskey, "Pia's CRM");
  is("the same person with a passkey session makes it", piaMade.body.ok, true);
  const nedLink = await openSession(NED);
  const nedOne = await make(nedLink, "Ned's sheet");
  const nedTwo = await make(nedLink, "Ned's bot");
  is("an account with no second step at all makes keys as before", [nedOne.body.ok, nedTwo.body.ok], [true, true]);
  const fayMade = await make(await openSession(FAY), "Fay's sync");
  const ownerLink = await openSession(OWNER);
  const ownerMade = await make(ownerLink, "Owner's own");
  is("the owner with no second step yet makes one too", ownerMade.body.ok, true);
  if (!piaMade.body.key || !nedOne.body.key || !nedTwo.body.key || !fayMade.body.key || !ownerMade.body.key) throw new Error("keys not made");

  const records = await keyRecords(store.sid);
  const rec = (name: string) => records.find((r) => r.name === name)!;
  is("each record says whether its session had a second step", [rec("Pia's CRM").maker?.step, rec("Ned's sheet").maker?.step, rec("Owner's own").maker?.owner], [true, false, true]);
  is("a teammate is kept as a fingerprint, never the address", JSON.stringify(await redis.pipeline([["HGETALL", `nl:api:keys:${store.sid}`]])).includes(NED), false);
  is("a key made with a second step is never paused by the rule", pausesUnderRule(rec("Pia's CRM")), false);
  // A store has five keys at most: Pia's goes, to make room for one from before 4 November 2026, with no record of who made it.
  await revokeKey(store.sid, rec("Pia's CRM").id);
  const old = await makeKey(store.sid, "Old Zap");
  if (!old.ok) throw new Error("old key not made");
  is("an old key has no maker", (await keyRecords(store.sid)).find((r) => r.name === "Old Zap")?.maker, null);

  const ownerPk = makePasskey(OWNER, "pk-owner");
  await ownerPk.keep();
  is("the owner, once they have a passkey, is refused from an emailed-link session too", (await make(ownerLink, "Another")).body.error, "second_step");
  const ownerPasskey = await openSession(OWNER, "passkey", "pk-owner");

  await removeMember(store, FAY);

  // ------------------------------------------------------------------ (B)
  await newDay();
  part("(B) Before saving: how many keys will pause, and whose");
  const preview = await pausePreview(store);
  is("four keys would pause: Ned's two, the former member's and the old one", preview.total, 4);
  is(
    "named by whose",
    preview.people.map((l) => [l.who, l.count, l.emailed]).sort(),
    [[MAKER_FORMER, 1, false], [MAKER_UNRECORDED, 1, false], [NED, 2, true]].sort(),
  );
  const review = renderToStaticMarkup(createElement(TeamTwoStepReview, { on: false, waiting: [NED], preview }));
  is("the review says the count", review.includes("4 API keys will pause"), true);
  is("and whose, and who gets an email", review.includes(`2 keys made by ${NED}, who will get an email on how to turn them back on`), true);
  is("the former member and the unrecorded key in words", review.includes(`1 key made by ${MAKER_FORMER}`) && review.includes("made before November 4, 2026, when who made a key was not recorded"), true);
  is("and who has no second step yet", review.includes(`1 person has no second step yet and will be asked to set one up: ${NED}.`), true);
  is("a heading names the step", review.includes('id="team-two-step-review"') && review.includes("Before you turn it on"), true);
  const page = readFileSync("app/studio/team/page.tsx", "utf8");
  is("the team page draws the switch with its review for the owner", page.includes("<TeamTwoStepSwitch") && page.includes("pausePreview(store)"), true);

  await newDay();
  part("Only the owner, and only from a session with their second step");
  is("an Admin cannot switch it", (await team(piaPasskey, { action: "two-step", on: true, expect: 4 })).body.ok, false);
  is("the owner from an emailed-link session is refused", (await team(ownerLink, { action: "two-step", on: true, expect: 4 })).body.error, "owner_step_session");
  const stale = await team(ownerPasskey, { action: "two-step", on: true, expect: 3 });
  is("a stale reviewed number is refused, with the new review", [stale.status, stale.body.error, stale.body.preview?.total], [409, "changed", 4]);
  is("and nothing was saved or paused", [(await readTeam(store.sid)).requireTwoStep, (await resolveKey(nedOne.body.key))?.paused], [undefined, false]);
  is("nobody was emailed", mails.length, 0);

  await newDay();
  part("Switched on: the keys made without a second step pause; the owner's never change");
  const on = await team(ownerPasskey, { action: "two-step", on: true, expect: 4 });
  is("saved", on.body, { ok: true, on: true, paused: 4, emailed: 1 });
  is("Ned's keys are refused by the API, as paused", [await asApi(nedOne.body.key), await asApi(nedTwo.body.key)], [{ status: 403, error: "key_paused" }, { status: 403, error: "key_paused" }]);
  is("the former member's and the old key too", [(await asApi(fayMade.body.key)).error, (await asApi(old.key)).error], ["key_paused", "key_paused"]);
  is("the owner's own key still works", await asApi(ownerMade.body.key), { status: 200, error: "" });
  is("nothing was deleted", (await keyRecords(store.sid)).length, 5);

  await newDay();
  part("One email to each affected teammate, saying how to turn them back on");
  is("one email, to Ned only", mails.map((m) => m.to), [NED]);
  is("it names both keys and the way back", [mails[0].text.includes("- Ned's sheet"), mails[0].text.includes("- Ned's bot"), mails[0].text.includes('press "Turn back on"'), mails[0].text.includes("passkey")], [true, true, true, true]);
  is("its subject is plain", mails[0].subject, "Your API keys for Keys Two Step are paused");
  is("switching on again pauses and emails nothing more", [(await team(ownerPasskey, { action: "two-step", on: true, expect: 0 })).body.paused, mails.length], [0, 1]);

  await newDay();
  part("The panel shows each person what is paused and whose");
  const nedView = await shownKeys(store, NED, "admin");
  const ownerView = await shownKeys(store, OWNER, "owner");
  const view = (list: typeof nedView, name: string) => list.find((k) => k.name === name)!;
  is("Ned sees his keys as his, paused, and may turn them on", [view(nedView, "Ned's sheet").maker, view(nedView, "Ned's sheet").paused, view(nedView, "Ned's sheet").mayTurnOn], ["you", true, true]);
  is("the owner sees them as Ned's and may not turn them on", [view(ownerView, "Ned's sheet").maker, view(ownerView, "Ned's sheet").mayTurnOn], [NED, false]);
  is("the owner may turn on the old one, whose maker nobody knows", [view(ownerView, "Old Zap").maker, view(ownerView, "Old Zap").mayTurnOn], [MAKER_UNRECORDED, true]);
  is("nobody may turn on the former member's", [view(ownerView, "Fay's sync").maker, view(ownerView, "Fay's sync").mayTurnOn], [MAKER_FORMER, false]);

  await newDay();
  part("Turned back on by whoever made it, after logging in with a second step");
  const nedOneId = view(nedView, "Ned's sheet").id;
  const nedTwoId = view(nedView, "Ned's bot").id;
  is("Ned from an emailed-link session is held at the team's door", (await keys(nedLink, { action: "turn_on", id: nedOneId })).body.error, "two_step_required");
  const nedKey = makePasskey(NED, "pk-ned");
  await nedKey.keep();
  const nedPasskey = await openSession(NED, "passkey", "pk-ned");
  is("Pia cannot turn on Ned's key", (await keys(piaPasskey, { action: "turn_on", id: nedOneId })).body.error, "not_yours");
  is("nor can the owner", (await keys(ownerPasskey, { action: "turn_on", id: nedOneId })).body.error, "not_yours");
  is("Ned, with his passkey, turns it back on", (await keys(nedPasskey, { action: "turn_on", id: nedOneId })).body.ok, true);
  is("and it works again", await asApi(nedOne.body.key), { status: 200, error: "" });
  is("his other key stays paused until he turns it on too", (await asApi(nedTwo.body.key)).error, "key_paused");
  is("the owner turns on the old key", (await keys(ownerPasskey, { action: "turn_on", id: view(ownerView, "Old Zap").id })).body.ok, true);
  is("the former member's can only be revoked", (await keys(ownerPasskey, { action: "turn_on", id: view(ownerView, "Fay's sync").id })).body.error, "not_yours");

  await newDay();
  part("Turning the rule off turns nothing back on");
  is("off, from the owner's passkey session", (await team(ownerPasskey, { action: "two-step", on: false })).body, { ok: true, on: false });
  is("Ned's other key is still paused", (await asApi(nedTwo.body.key)).error, "key_paused");
  is("from an emailed-link session it still needs his second step", (await keys(nedLink, { action: "turn_on", id: nedTwoId })).body.error, "second_step_on");
  const again = await pausePreview(store);
  is("on again: the key he turned on is vouched for, and paused keys are not counted twice", again.total, 0);
  is("so on again pauses nothing and emails nobody", [(await team(ownerPasskey, { action: "two-step", on: true, expect: 0 })).body.paused, mails.length], [0, 1]);
  is("the vouched key still works", await asApi(nedOne.body.key), { status: 200, error: "" });

  await newDay();
  part("A key made in the instant the rule turned on is paused at once");
  await revokeKey(store.sid, view(ownerView, "Fay's sync").id);
  const raced = await makeKey(store.sid, "Raced", Date.now(), false, "none", makerFor("admin", NED, false));
  if (!raced.ok) throw new Error("raced key not made");
  is("paused when the rule is on", await pauseIfRuleOn(store, raced.made.id, makerFor("admin", NED, false)), true);
  is("an owner's never is", await pauseIfRuleOn(store, raced.made.id, makerFor("owner", OWNER, false)), false);
  is("revoking a paused key takes its mark with it", [await revokeKey(store.sid, raced.made.id), await redis.pipeline([["HGET", `nl:api:hold:${store.sid}`, raced.made.id]])], [true, [null]]);

  await newDay();
  part("The developers page names the answer");
  const docs = readFileSync("app/developers/page.tsx", "utf8");
  is("403 key_paused is listed", docs.includes('403  {"error": "key_paused"') && docs.includes("A paused key is never deleted."), true);

  done();
}

void main();
