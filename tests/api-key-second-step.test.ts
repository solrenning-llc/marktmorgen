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
 * made without a second step pause, never deleted, and so do the webhook
 * endpoints they added; the owner's never change; before saving, the page
 * says which keys and endpoints and whose, and a save whose reviewed list
 * changed is refused; a save that cannot write the rule undoes its pause; one
 * that wrote it but could not finish finishes when pressed again; each
 * affected teammate gets one email; the maker turns a key back on from a
 * session with a second step, and its endpoints with it; turning the rule off
 * turns nothing back on. A teammate taken off the team has every key paused
 * at once, whatever the rule, and only the owner may revoke them; a teammate
 * who moves their address keeps their keys. Who made a key is an HMAC under
 * the deployment's secret and the store's id.
 *
 * Synthetic records, sessions and stores; no email leaves (Resend is stubbed)
 * and no webhook is sent (the address lookup is a stand-in that answers
 * nothing).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { POST as keysRoute } from "@/app/api/store/api-keys/route";
import { POST as teamRoute } from "@/app/api/store/team/route";
import { POST as postHook } from "@/app/api/v1/hooks/route";
import { SESSION_COOKIE, openSession } from "@/lib/auth";
import { HOLD_SWAP, RECORD_SWAP, keyRecords, makeKey, makerPrint, resolveKey, revokeKey, rewriteMakers, swapHolds } from "@/lib/api-keys";
import { afterMake, applyPause, leftTeam, makerFor, planPause, pausePreview, pausesUnderRule, shownKeys, tellPaused, undoPause } from "@/lib/api-key-pause";
import { MAKER_FORMER, MAKER_UNRECORDED, pausedWords, turnOnNote } from "@/lib/api-key-rules";
import { TAKE_COMMANDS } from "./plan-cost-registry";
import { KEY_PAUSED_WORDS, apiStore } from "@/lib/api-guard";
import { moveMemberships, putMember, readTeam, removeMember, setMemberRole } from "@/lib/team";
import { type Store, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { addEndpoint, emitEvent, sendTest, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { allowanceUsed } from "@/lib/store-allowance";
import { TeamTwoStepReview } from "@/components/team-two-step-switch";
import { makePasskey } from "./passkey-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
// One of the synthetic credentials the reviewed Resend fallback fixture knows (tests/resend-fixture-credentials.ts).
process.env.RESEND_API_KEY = "re_test_a_stand_in_key_for_tests_only";
const sent: { to: string; subject: string; text: string }[] = [];
// The paused-keys emails; the creator's own notices (a webhook added) are not this test's.
const mails = { get length() { return sent.filter((m) => m.subject.includes("API key")).length; }, list: () => sent.filter((m) => m.subject.includes("API key")) };
let resendDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    // A refusal the sender is sure of (lib/resend-fallback-transport.ts: not accepted), so trying again may send;
    // an uncertain one (a 500) holds the message rather than risk sending it twice.
    if (resendDown) return new Response("{}", { status: 422 });
    const body = JSON.parse(String(init?.body ?? "{}")) as { to?: string | string[]; subject?: string; text?: string };
    sent.push({ to: Array.isArray(body.to) ? body.to[0] : String(body.to ?? ""), subject: String(body.subject ?? ""), text: String(body.text ?? "") });
    return new Response(JSON.stringify({ id: `email_${sent.length}` }), { status: 200 });
  }
  return new Response("{}", { status: 404 });
}) as typeof fetch;
setSendHooksForTests({ fetch: { resolve: (async () => { throw new Error("no network in tests"); }) as never } });

// Every command the code sends passes here first, so a test can act at an exact moment of a real route.
type Commands = (string | number)[][];
const realPipeline = redis.pipeline;
let hook: ((commands: Commands) => Promise<void>) | null = null;
// And after it ran, to act between two steps of a real route.
let afterHook: ((commands: Commands) => Promise<void>) | null = null;
redis.pipeline = async (commands: Commands) => {
  if (hook) await hook(commands);
  const out = await realPipeline(commands);
  if (afterHook) await afterHook(commands);
  return out;
};
const writes = (commands: Commands, verb: string, key: string) => commands.some((c) => c[0] === verb && c[1] === key);

const ORIGIN = "https://marktmorgen.com";
const OWNER = "owner-keys@example.com";
const PIA = "pia-passkey@example.com"; // an Admin with a passkey
const NED = "ned-nothing@example.com"; // an Admin with no second step
const LOU = "lou-late@example.com"; // an Admin with no second step, for the race
const OWNER2 = "owner-two@example.com";
const FAY = "fay-former@example.com"; // an Admin who is taken off the team
const GUS = "gus-admin@example.com"; // an Admin who stays
const MO = "mo-mover@example.com"; // an Admin who moves their address
const MO2 = "mo-moved@example.com";
const OWNER3 = "owner-three@example.com";
const ADA = "ada-admin@example.com";
const BEN = "ben-admin@example.com";
const CAL = "cal-admin@example.com";
const DOT = "dot-admin@example.com";
const EVE = "eve-admin@example.com";
const ADA2 = "ada-moved@example.com";
const OWNER4 = "owner-four@example.com";
const FIN = "fin-admin@example.com";
const GIA = "gia-admin@example.com";
const HAL = "hal-admin@example.com";
const FIN2 = "fin-moved@example.com";
const FIN3 = "fin-again@example.com";
const IVY = "ivy-admin@example.com";
const OWNER5 = "owner-five@example.com";
const JO = "jo-admin@example.com"; // an Admin with no second step
const LEO = "leo-admin@example.com"; // an Admin with a passkey

async function newStore(owner: string, handle: string): Promise<Store> {
  await claimHandle(owner, handle, handle, "");
  await ensureStoreId(owner);
  await ensureStatsId(owner);
  await ensureListId(owner);
  await setSubscription(owner, { customerId: `cus_${handle.replace(/-/g, "")}`, subscriptionId: `sub_${handle.replace(/-/g, "")}`, active: true, tier: "creator", period: paidPeriod() });
  const store = (await storeForEmail(owner))!;
  if (!store.sid || !store.statsId) throw new Error("no store id");
  return store;
}

async function main(): Promise<void> {
  redis.clear();
  const store = await newStore(OWNER, "keys-two-step");
  const other = await newStore(OWNER2, "keys-former");
  const third = await newStore(OWNER3, "keys-races");
  const fourth = await newStore(OWNER4, "keys-third-round");
  const fifth = await newStore(OWNER5, "keys-codex-g");
  for (const email of [PIA, NED, LOU]) await putMember(store, email, "admin");
  for (const email of [FAY, GUS, MO]) await putMember(other, email, "admin");

  const call = async (route: typeof keysRoute, path: string, on: Store, session: string, body: unknown) => {
    const response = await route(
      new NextRequest(`${ORIGIN}${path}?store=${on.sid}`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `${SESSION_COOKIE}=${session}`, origin: ORIGIN, host: "marktmorgen.com" },
        body: JSON.stringify(body),
      }),
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> & { ok: boolean; error?: string } };
  };
  type KeyAnswer = { ok: boolean; error?: string; key?: string; made?: { id: string }; paused?: boolean };
  const keys = async (session: string, body: unknown, on = store) => (await call(keysRoute, "/api/store/api-keys", on, session, body)) as { status: number; body: KeyAnswer };
  type TeamAnswer = { ok: boolean; error?: string; on?: boolean; paused?: number; emailed?: number; waiting?: number; undone?: boolean; preview?: { total: number; stamp: string } };
  const team = async (session: string, body: unknown, on = store) => (await call(teamRoute, "/api/store/team", on, session, body)) as { status: number; body: TeamAnswer };
  const make = (session: string, name: string, on = store, write = false) => keys(session, { action: "make", name, write }, on);
  const asApi = async (key: string) => {
    const found = await apiStore(new Request(`${ORIGIN}/api/v1/store`, { headers: { authorization: `Bearer ${key}` } }));
    if (found instanceof Response) {
      const said = (await found.json()) as { error?: string; message?: string };
      lastMessage = said.message ?? "";
      return { status: found.status, error: said.error };
    }
    return { status: 200, error: "" };
  };
  let lastMessage = "";
  const addHook = async (key: string, url: string) => {
    const response = await postHook(new Request(`${ORIGIN}/api/v1/hooks`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ url, events: ["sale.completed"] }) }));
    return ((await response.json()) as { data?: { id: string } }).data?.id ?? "";
  };
  let seed = 0;
  const sale = (on: Store) => emitEvent(on, "sale.completed", `cs_test_${(seed += 1)}`, { amount_cents: 100 });
  const held = async (on: Store, id: string) => (await webhooksView(on)).endpoints.find((e) => e.id === id)?.held ?? "none";
  // Keys are handed out under "export", which has a small daily figure of its own (lib/studio-route.ts countStudio):
  // this test makes more than a day's worth, so each part starts a new day.
  const newDay = () =>
    redis.pipeline([store, other, third, fourth, fifth].map((s) => ["DEL", `nl:rl:studio-essential:${createHash("sha256").update(`nimbus-studio-essential:${s.sid}`).digest("hex").slice(0, 32)}`]));
  const teamRaw = async () => String((await realPipeline([["GET", `nl:team:${store.sid}`]]))[0]);
  const nobody = new Map<string, string>();

  // ------------------------------------------------------------------ (A)
  await newDay();
  part("(A) Making a key on an account with a second step needs a session opened with it");
  await makePasskey(PIA, "pk-pia").keep();
  const piaLink = await openSession(PIA);
  const refused = await make(piaLink, "Zapier");
  is("an emailed-link session on a passkey account is refused", [refused.status, refused.body.error], [403, "second_step"]);
  is("and no key was made", (await keyRecords(store.sid)).length, 0);
  const piaPasskey = await openSession(PIA, "passkey", "pk-pia");
  const piaMade = await make(piaPasskey, "Pia's CRM");
  is("the same person with a passkey session makes it", piaMade.body.ok, true);
  const nedLink = await openSession(NED);
  const nedOne = await make(nedLink, "Ned's sheet");
  const nedTwo = await make(nedLink, "Ned's bot", store, true);
  is("an account with no second step at all makes keys as before", [nedOne.body.ok, nedTwo.body.ok], [true, true]);
  const ownerLink = await openSession(OWNER);
  const ownerMade = await make(ownerLink, "Owner's own");
  is("the owner with no second step yet makes one too", ownerMade.body.ok, true);
  if (!piaMade.body.key || !nedOne.body.key || !nedTwo.body.key || !ownerMade.body.key) throw new Error("keys not made");
  // A key from before 4 November 2026: no record of who made it.
  const old = await makeKey(store.sid, "Old Zap");
  if (!old.ok) throw new Error("old key not made");

  const records = await keyRecords(store.sid);
  const rec = (name: string) => records.find((r) => r.name === name)!;
  is("each record says whether its session had a second step", [rec("Pia's CRM").maker?.step, rec("Ned's sheet").maker?.step, rec("Owner's own").maker?.owner], [true, false, true]);
  is("an old key has no maker", rec("Old Zap").maker, null);

  await makePasskey(OWNER, "pk-owner").keep();
  is("the owner, once they have a passkey, is refused from an emailed-link session too", (await make(ownerLink, "Another")).body.error, "second_step");
  const ownerPasskey = await openSession(OWNER, "passkey", "pk-owner");

  part("(5) Who made a key is an HMAC under the deployment's secret and the store's id");
  const rawKeys = JSON.stringify(await realPipeline([["HGETALL", `nl:api:keys:${store.sid}`]]));
  is("never the address", rawKeys.includes(NED), false);
  is("never a plain hash of it either", rawKeys.includes(createHash("sha256").update(`nimbus-api-key-by:${NED}`).digest("hex").slice(0, 40)), false);
  is("the same person reads differently on another store", makerPrint(store.sid, NED) !== makerPrint(other.sid, NED) && /^[0-9a-f]{40}$/.test(makerPrint(store.sid, NED)), true);
  is("what is kept is this store's print", rec("Ned's sheet").maker?.by, makerPrint(store.sid, NED));

  part("(B) The webhook endpoints a key adds are kept with it");
  // Room for what comes: a store keeps five keys at most.
  await revokeKey(store.sid, rec("Pia's CRM").id);
  const nedHook = await addHook(nedTwo.body.key, "https://hooks.zapier.com/hooks/catch/9/ned");
  // One added in the studio, by no key: it never pauses.
  const studioAdded = await addEndpoint(store, "https://hooks.zapier.com/hooks/catch/9/owner", ["sale.completed"]);
  const ownerHook = studioAdded.ok ? (studioAdded.view.endpoints.at(-1)?.id ?? "") : "";
  is("both added", [nedHook !== "", ownerHook !== ""], [true, true]);
  is("a sale goes to both while nothing is paused", await sale(store), 2);
  is("a key made with a second step is never paused by the rule", pausesUnderRule(rec("Pia's CRM"), new Map([[makerPrint(store.sid, PIA), PIA]])), false);

  // ------------------------------------------------------------------ (B) review
  await newDay();
  part("Before saving: which keys and endpoints will pause, and whose");
  const preview = await pausePreview(store);
  is("three keys and one endpoint would pause: Ned's two, his bot's endpoint, and the old key", [preview.total, preview.endpoints], [3, 1]);
  is(
    "named by whose",
    preview.people.map((l) => [l.who, l.count, l.endpoints, l.emailed]).sort(),
    [[MAKER_UNRECORDED, 1, 0, false], [NED, 2, 1, true]].sort(),
  );
  const review = renderToStaticMarkup(createElement(TeamTwoStepReview, { on: false, waiting: [NED, LOU], preview }));
  is("the review says the count, endpoints included", review.includes("3 API keys and 1 webhook endpoint will pause"), true);
  is("and whose, with the endpoint, and who gets an email", review.includes(`2 keys made by ${NED}, and 1 webhook endpoint they added. They will get an email on how to turn them back on.`), true);
  is("the unrecorded key in words", review.includes("1 key made before November 4, 2026, when who made a key was not recorded. You can turn it back on yourself."), true);
  is("and who has no second step yet", review.includes(`2 people have no second step yet and will be asked to set one up: ${NED}, ${LOU}.`), true);
  const formerReview = renderToStaticMarkup(createElement(TeamTwoStepReview, { on: false, waiting: [], preview: { ...preview, people: [{ who: MAKER_FORMER, count: 1, endpoints: 0, emailed: false }] } }));
  is("a former teammate's key is said to be revocable only", formerReview.includes(`1 key made by ${MAKER_FORMER}. It can only be revoked, by you.`), true);
  const page = readFileSync("app/studio/team/page.tsx", "utf8");
  is("the team page draws the switch with its review for the owner", page.includes("<TeamTwoStepSwitch") && page.includes("pausePreview(store)"), true);

  part("Only the owner, only with their second step, and only for the list reviewed");
  is("an Admin cannot switch it", (await team(piaPasskey, { action: "two-step", on: true, expect: preview.stamp })).body.ok, false);
  is("the owner from an emailed-link session is refused", (await team(ownerLink, { action: "two-step", on: true, expect: preview.stamp })).body.error, "owner_step_session");
  // (3) The same count, another list: the old key revoked and another old one made.
  await revokeKey(store.sid, rec("Old Zap").id);
  const old2 = await makeKey(store.sid, "Old Zap 2");
  if (!old2.ok) throw new Error("old key not made");
  const swapped = await pausePreview(store);
  is("the count is the same", swapped.total, preview.total);
  const stale = await team(ownerPasskey, { action: "two-step", on: true, expect: preview.stamp });
  is("but the list is not, so the save is refused with the new review", [stale.status, stale.body.error, stale.body.preview?.stamp], [409, "changed", swapped.stamp]);
  is("and nothing was saved, paused or held", [(await readTeam(store.sid)).requireTwoStep, (await resolveKey(nedOne.body.key))?.paused, await held(store, nedHook)], [undefined, false, "none"]);

  part("(4) A save that cannot write the rule undoes its pause, and says so");
  hook = async (commands) => {
    if (!writes(commands, "SET", `nl:team:${store.sid}`)) return;
    hook = null;
    throw new Error("a stand-in for a failed write");
  };
  const failed = await team(ownerPasskey, { action: "two-step", on: true, expect: swapped.stamp });
  is("refused as unsaved, undone", [failed.status, failed.body.error, failed.body.undone], [503, "unsaved", true]);
  is("the rule is off, no key is paused, the endpoint is not held", [(await readTeam(store.sid)).requireTwoStep, (await resolveKey(nedOne.body.key))?.paused, (await resolveKey(old2.key))?.paused, await held(store, nedHook)], [undefined, false, false, "none"]);
  is("nobody was emailed", mails.length, 0);

  part("(8) A key made after the first pause, as the rule is written, is paused by the second");
  hook = async (commands) => {
    if (!writes(commands, "SET", `nl:team:${store.sid}`)) return;
    hook = null;
    await makeKey(store.sid, "Ned's late one", Date.now(), false, "none", makerFor(store.sid, "admin", NED, false));
  };
  // (4) And its emails cannot go: the rule stays on, and pressing again finishes.
  resendDown = true;
  const unfinished = await team(ownerPasskey, { action: "two-step", on: true, expect: swapped.stamp });
  resendDown = false;
  is("saved, but not finished: four keys paused, Ned's three still to be told", [unfinished.body.error, unfinished.body.on, unfinished.body.paused, unfinished.body.waiting], ["incomplete", true, 4, 3]);
  is("the rule is on", (await readTeam(store.sid)).requireTwoStep, true);
  const late = (await keyRecords(store.sid)).find((k) => k.name === "Ned's late one")!;
  is("the late key is paused", late.hold, "paused");
  is("the page offers to finish", (await pausePreview(store)).untold, 3);
  const finished = await team(ownerPasskey, { action: "two-step", on: true });
  is("pressing again tells who is left, and pauses nothing more", [finished.body.ok, finished.body.paused, finished.body.emailed], [true, 0, 1]);
  is("pressing once more tells nobody twice", [(await team(ownerPasskey, { action: "two-step", on: true })).body.emailed, mails.length], [0, 1]);
  const told = mails.list();
  is("one email, to Ned only", told.map((m) => m.to), [NED]);
  is(
    "it names his three keys and the way back",
    [told[0].text.includes("- Ned's sheet"), told[0].text.includes("- Ned's bot"), told[0].text.includes("- Ned's late one"), told[0].text.includes('press "Turn back on"')],
    [true, true, true, true],
  );
  is("its subject is plain", told[0].subject, "Your API keys for keys-two-step are paused");

  part("On: the keys made without a second step pause, with their endpoints; the owner's never change");
  is("Ned's keys are refused by the API, as paused", [await asApi(nedOne.body.key), await asApi(nedTwo.body.key)], [{ status: 403, error: "key_paused" }, { status: 403, error: "key_paused" }]);
  is("the old key too", (await asApi(old2.key)).error, "key_paused");
  is("the owner's own key still works", await asApi(ownerMade.body.key), { status: 200, error: "" });
  is("Ned's bot's endpoint is held, the owner's is not", [await held(store, nedHook), await held(store, ownerHook)], ["paused", "none"]);
  is("so a sale goes to the owner's endpoint only", await sale(store), 1);
  is("nothing was deleted", (await keyRecords(store.sid)).length, 5);
  is("an endpoint added in the studio, by no key, is never held", await held(store, ownerHook), "none");

  // ------------------------------------------------------------------ turning back on
  await newDay();
  part("The panel shows each person what is paused and whose");
  const nedView = await shownKeys(store, NED, "admin");
  const ownerView = await shownKeys(store, OWNER, "owner");
  const view = (list: typeof nedView, name: string) => list.find((k) => k.name === name)!;
  is("Ned sees his keys as his, paused, and may turn them on", [view(nedView, "Ned's sheet").maker, view(nedView, "Ned's sheet").paused, view(nedView, "Ned's sheet").mayTurnOn], ["you", true, true]);
  is("the owner sees them as Ned's and may not turn them on", [view(ownerView, "Ned's sheet").maker, view(ownerView, "Ned's sheet").mayTurnOn], [NED, false]);
  is("the owner may turn on the old one, whose maker nobody knows", [view(ownerView, "Old Zap 2").maker, view(ownerView, "Old Zap 2").mayTurnOn], [MAKER_UNRECORDED, true]);

  part("Turned back on by whoever made it, after logging in with a second step, endpoints included");
  const botId = view(nedView, "Ned's bot").id;
  is("Ned from an emailed-link session is held at the team's door", (await keys(nedLink, { action: "turn_on", id: botId })).body.error, "two_step_required");
  await makePasskey(NED, "pk-ned").keep();
  const nedPasskey = await openSession(NED, "passkey", "pk-ned");
  is("Pia cannot turn on Ned's key", (await keys(piaPasskey, { action: "turn_on", id: botId })).body.error, "not_yours");
  is("nor can the owner", (await keys(ownerPasskey, { action: "turn_on", id: botId })).body.error, "not_yours");
  is("Ned, with his passkey, turns it back on", (await keys(nedPasskey, { action: "turn_on", id: botId })).body.ok, true);
  is("it works again", await asApi(nedTwo.body.key), { status: 200, error: "" });
  is("and so does its endpoint", [await held(store, nedHook), await sale(store)], ["none", 2]);
  is("his other key stays paused until he turns it on too", (await asApi(nedOne.body.key)).error, "key_paused");
  is("the owner turns on the old key", (await keys(ownerPasskey, { action: "turn_on", id: view(ownerView, "Old Zap 2").id })).body.ok, true);

  part("Revoking a key stops its endpoints for good");
  is("Ned revokes his bot", (await keys(nedPasskey, { action: "revoke", id: botId })).body.ok, true);
  is("its endpoint is held as revoked, and hears nothing", [await held(store, nedHook), await sale(store)], ["revoked", 1]);
  is("its mark goes with it", await realPipeline([["HGET", `nl:api:hold:${store.sid}`, botId]]), [null]);

  part("Turning the rule off turns nothing back on");
  is("off, from the owner's passkey session", (await team(ownerPasskey, { action: "two-step", on: false })).body, { ok: true, on: false });
  is("Ned's other key is still paused", (await asApi(nedOne.body.key)).error, "key_paused");
  is("from an emailed-link session it still needs his second step", (await keys(nedLink, { action: "turn_on", id: view(nedView, "Ned's sheet").id })).body.error, "second_step_on");
  const again = await pausePreview(store);
  is("on again: what was turned on is vouched for, and paused keys are not counted twice", again.total, 0);
  is("so on again pauses nothing and emails nobody", [(await team(ownerPasskey, { action: "two-step", on: true, expect: again.stamp })).body.paused, mails.length], [0, 1]);

  // ------------------------------------------------------------------ the race, through the real route
  await newDay();
  part("(8) A key made through the route in the instant the rule turned on is paused at once");
  await team(ownerPasskey, { action: "two-step", on: false });
  const louLink = await openSession(LOU);
  hook = async (commands) => {
    if (!commands.some((c) => c[0] === "HSET" && c[1] === `nl:api:keys:${store.sid}`)) return;
    hook = null;
    const current = JSON.parse(await teamRaw()) as Record<string, unknown>;
    await realPipeline([["SET", `nl:team:${store.sid}`, JSON.stringify({ ...current, requireTwoStep: true })]]);
  };
  const raced = await make(louLink, "Lou's sync");
  is("let in while the rule was off, made as it turned on: paused, and the answer says so", [raced.body.ok, raced.body.paused], [true, true]);
  is("refused by the API", (await asApi(raced.body.key ?? "")).error, "key_paused");
  is("an owner's key never is", await afterMake(store, ownerMade.body.made?.id ?? "", makerFor(store.sid, "owner", OWNER, false), OWNER, false), false);

  // ------------------------------------------------------------------ a teammate leaving
  await newDay();
  part("(1) A teammate taken off the team has every key paused at once, whatever the rule");
  await makePasskey(FAY, "pk-fay").keep();
  const fayPasskey = await openSession(FAY, "passkey", "pk-fay");
  const fayKey = await make(fayPasskey, "Fay's sync", other, true);
  if (!fayKey.body.key) throw new Error("Fay's key not made");
  const fayHook = await addHook(fayKey.body.key, "https://hooks.zapier.com/hooks/catch/9/fay");
  is("made with her passkey, it works while she is on the team", await asApi(fayKey.body.key), { status: 200, error: "" });
  is("the rule is off on this store", (await readTeam(other.sid)).requireTwoStep, undefined);
  await removeMember(other, FAY);
  is("taken off: her key is paused", (await asApi(fayKey.body.key)).error, "key_paused");
  is("and its endpoint is held", await held(other, fayHook), "paused");
  const fayRecord = (await keyRecords(other.sid)).find((k) => k.name === "Fay's sync")!;
  is("her fingerprint is gone from it", [fayRecord.maker?.by, fayRecord.maker?.left, JSON.stringify(await realPipeline([["HGETALL", `nl:api:keys:${other.sid}`]])).includes(makerPrint(other.sid, FAY))], ["", true, false]);
  is("under the rule it counts as a former teammate's, vouched for or not", pausesUnderRule({ maker: { owner: false, by: "f".repeat(40), step: true }, hold: "vouched" }, nobody), true);
  const gusView = (await shownKeys(other, GUS, "admin")).find((k) => k.name === "Fay's sync")!;
  const owner2View = (await shownKeys(other, OWNER2, "owner")).find((k) => k.name === "Fay's sync")!;
  is("shown as a former teammate's, never to be turned on", [owner2View.maker, owner2View.mayTurnOn, owner2View.mayRevoke], [MAKER_FORMER, false, true]);
  is("an Admin may not revoke it", gusView.mayRevoke, false);
  await makePasskey(GUS, "pk-gus").keep();
  const gusPasskey = await openSession(GUS, "passkey", "pk-gus");
  is("and the route agrees", (await keys(gusPasskey, { action: "revoke", id: fayRecord.id }, other)).body.error, "owner_only");
  await makePasskey(OWNER2, "pk-owner2").keep();
  const owner2Passkey = await openSession(OWNER2, "passkey", "pk-owner2");
  is("the owner may not turn it on", (await keys(owner2Passkey, { action: "turn_on", id: fayRecord.id }, other)).body.error, "not_yours");
  is("the owner revokes it", (await keys(owner2Passkey, { action: "revoke", id: fayRecord.id }, other)).body.ok, true);
  is("and its endpoint stops for good", await held(other, fayHook), "revoked");

  part("(6) A teammate who moves their address keeps their keys");
  const moKey = await make(await openSession(MO), "Mo's sheet", other);
  if (!moKey.body.key) throw new Error("Mo's key not made");
  await moveMemberships(MO, MO2);
  const moView = (await shownKeys(other, MO2, "admin")).find((k) => k.name === "Mo's sheet")!;
  is("the key follows the new address", [moView.maker, (await readTeam(other.sid)).members.some((m) => m.email === MO2)], ["you", true]);
  is("and still works", await asApi(moKey.body.key), { status: 200, error: "" });


  // ------------------------------------------------------------------ the second review: races and failures
  for (const email of [ADA, BEN, CAL, DOT, EVE]) await putMember(third, email, "admin");
  await makePasskey(OWNER3, "pk-owner3").keep();
  const owner3Passkey = await openSession(OWNER3, "passkey", "pk-owner3");
  const hold3 = async (id: string) => (await realPipeline([["HGET", `nl:api:hold:${third.sid}`, id]]))[0];
  const rec3 = async (name: string) => (await keyRecords(third.sid)).find((k) => k.name === name)!;
  const teamSet = async (on: Store, change: (t: Record<string, unknown> & { members: { email: string }[] }) => unknown) => {
    const raw = String((await realPipeline([["GET", `nl:team:${on.sid}`]]))[0]);
    await realPipeline([["SET", `nl:team:${on.sid}`, JSON.stringify(change(JSON.parse(raw)))]]);
  };

  await newDay();
  part("G1: a key written after its maker was taken off, as the door let them in before, is theirs who left");
  hook = async (commands) => {
    if (!commands.some((c) => c[0] === "HSET" && c[1] === `nl:api:keys:${third.sid}`)) return;
    hook = null;
    await teamSet(third, (t) => ({ ...t, members: t.members.filter((m) => m.email !== ADA) }));
  };
  const adaRaced = await make(await openSession(ADA), "Ada's raced", third);
  is("made, and paused in the same answer", [adaRaced.body.ok, adaRaced.body.paused], [true, true]);
  is("refused by the API, held for good", [(await asApi(adaRaced.body.key ?? "")).error, await hold3(adaRaced.body.made?.id ?? "")], ["key_paused", "left"]);
  await revokeKey(third.sid, adaRaced.body.made?.id ?? "");
  await putMember(third, ADA, "admin");

  part("G1: an endpoint written as its key was revoked is sent nothing");
  const benLink = await openSession(BEN);
  const benWriter = await make(benLink, "Ben's writer", third, true);
  const benId = benWriter.body.made?.id ?? "";
  await revokeKey(third.sid, benId);
  const late1 = await addEndpoint(third, "https://hooks.zapier.com/hooks/catch/9/late", ["sale.completed"], Date.now(), benId);
  const lateHook = late1.ok ? (late1.view.endpoints.at(-1)?.id ?? "") : "";
  is("it is written, and shown as its key's: revoked", await held(third, lateHook), "revoked");
  is("a sale goes nowhere", await sale(third), 0);

  part("G1: a key whose maker left is refused even with no hold written");
  const calKey = await make(await openSession(CAL), "Cal's sheet", third);
  const calId = calKey.body.made?.id ?? "";
  await rewriteMakers(third.sid, (m) => (!m.owner && m.by === makerPrint(third.sid, CAL) ? { owner: false, by: "", step: m.step, left: true } : null));
  await realPipeline([["HDEL", `nl:api:hold:${third.sid}`, calId]]);
  is("refused", (await asApi(calKey.body.key ?? "")).error, "key_paused");
  await revokeKey(third.sid, calId);

  await newDay();
  part("G2: turning a key on while its maker leaves never wins over the leaving");
  await makePasskey(BEN, "pk-ben").keep();
  const benPasskey = await openSession(BEN, "passkey", "pk-ben");
  const benKey = await make(benPasskey, "Ben's sheet", third);
  const benKeyId = benKey.body.made?.id ?? "";
  await swapHolds(third.sid, [benKeyId], "paused", [null]);
  hook = async (commands) => {
    if (!commands.some((c) => c[0] === "EVAL" && c[1] === HOLD_SWAP && c[5] === "vouched")) return;
    hook = null;
    await leftTeam(third, BEN);
  };
  const turned = await keys(benPasskey, { action: "turn_on", id: benKeyId }, third);
  is("the turning on is refused, as the hold changed", turned.body.ok, false);
  is("the key stays held for good, and refused", [await hold3(benKeyId), (await asApi(benKey.body.key ?? "")).error], ["left", "key_paused"]);
  const undoPlan = [{ id: benKeyId, to: "paused" as const, before: null }];
  await undoPause(third, undoPlan);
  is("an undo never puts back a key whose maker left", await hold3(benKeyId), "left");
  await revokeKey(third.sid, benKeyId);

  part("M1: a key made under the earlier secret is still its maker's once NIMBUS_DATA_KEY is set");
  const dataKey = process.env.NIMBUS_DATA_KEY;
  delete process.env.NIMBUS_DATA_KEY;
  process.env.STRIPE_SECRET_KEY = "sk_test_api_key_second_step_legacy_root_only";
  const legacyMaker = makerFor(third.sid, "admin", ADA, false);
  process.env.NIMBUS_DATA_KEY = dataKey;
  const adaLegacy = await makeKey(third.sid, "Ada's legacy", Date.now(), false, "none", legacyMaker);
  if (!adaLegacy.ok) throw new Error("legacy key not made");
  is("its print is not today's", legacyMaker.by !== makerPrint(third.sid, ADA), true);
  is("Ada still sees it as hers", (await shownKeys(third, ADA, "admin")).find((k) => k.name === "Ada's legacy")?.maker, "you");

  part("M2: a teammate leaving also pauses keys nobody is recorded as having made, without a secret too");
  delete process.env.NIMBUS_DATA_KEY;
  delete process.env.STRIPE_SECRET_KEY;
  const noSecret = await makeKey(third.sid, "No secret", Date.now(), false, "none", makerFor(third.sid, "admin", DOT, false));
  process.env.NIMBUS_DATA_KEY = dataKey;
  process.env.STRIPE_SECRET_KEY = "sk_test_api_key_second_step_legacy_root_only";
  if (!noSecret.ok) throw new Error("key not made");
  is("with no secret, nobody is recorded", (await rec3("No secret")).maker, null);
  await removeMember(third, ADA);
  is("Ada's legacy key is found and held for good", await hold3(adaLegacy.made.id), "left");
  is("the unrecorded key is paused", [await hold3(noSecret.made.id), (await asApi(noSecret.key)).error], ["told", "key_paused"]);
  is("and the owner may turn it back on", (await shownKeys(third, OWNER3, "owner")).find((k) => k.name === "No secret")?.mayTurnOn, true);
  delete process.env.STRIPE_SECRET_KEY;
  await revokeKey(third.sid, adaLegacy.made.id);
  await revokeKey(third.sid, noSecret.made.id);

  await newDay();
  part("M3: a pause cut short before the rule is saved is undone, key by key");
  const dotLink = await openSession(DOT);
  const dotKey = await make(dotLink, "Dot's sheet", third);
  const oldThird = await makeKey(third.sid, "Old third");
  if (!oldThird.ok) throw new Error("old key not made");
  const cut = await pausePreview(third);
  hook = async (commands) => {
    if (!commands.some((c) => c[0] === "EVAL" && c[1] === HOLD_SWAP && c[5] === "told")) return;
    hook = null;
    throw new Error("a stand-in for a pipeline cut short");
  };
  const cutShort = await team(owner3Passkey, { action: "two-step", on: true, expect: cut.stamp }, third);
  is("refused as unsaved, and undone", [cutShort.body.error, cutShort.body.undone], ["unsaved", true]);
  is("the key paused before the cut is back on", [await hold3(dotKey.body.made?.id ?? ""), (await asApi(dotKey.body.key ?? "")).status], [null, 200]);
  const plan = await planPause(third);
  is("a plan applied and undone leaves nothing", [(await applyPause(third, plan)).length, await undoPause(third, plan).then(() => hold3(oldThird.made.id))], [2, null]);
  await revokeKey(third.sid, oldThird.made.id);

  await newDay();
  part("L3: the team unreadable after a failed save: the pause stands, and the answer does not claim it saved");
  const unsureStamp = (await pausePreview(third)).stamp;
  let setFailed = false;
  hook = async (commands) => {
    if (writes(commands, "SET", `nl:team:${third.sid}`)) {
      setFailed = true;
      throw new Error("a stand-in for a failed write");
    }
    if (setFailed && commands.some((c) => c[0] === "GET" && c[1] === `nl:team:${third.sid}`)) {
      hook = null;
      throw new Error("a stand-in for an unreadable team");
    }
  };
  const unsure = await team(owner3Passkey, { action: "two-step", on: true, expect: unsureStamp }, third);
  hook = null;
  is("answered unsure", [unsure.status, unsure.body.error], [503, "unsure"]);
  is("Dot's key stays paused", (await asApi(dotKey.body.key ?? "")).error, "key_paused");

  part("L3: two presses at once email a teammate once");
  const before = mails.length;
  await Promise.all([tellPaused(third, ORIGIN), tellPaused(third, ORIGIN)]);
  is("one email to Dot", [mails.length - before, mails.list().at(-1)?.to], [1, DOT]);
  is("and his key is told", await hold3(dotKey.body.made?.id ?? ""), "told");

  await newDay();
  part("L1: a test to an endpoint whose key is paused takes nothing");
  await swapHolds(third.sid, [dotKey.body.made?.id ?? ""], null, ["told"]);
  const dotWriter = await make(dotLink, "Dot's writer", third, true);
  const dotHook = await addHook(dotWriter.body.key ?? "", "https://hooks.zapier.com/hooks/catch/9/dot");
  await swapHolds(third.sid, [dotWriter.body.made?.id ?? ""], "told", [null]);
  const usedBefore = await allowanceUsed(third, "webhook");
  const test = await sendTest(third, dotHook);
  is("refused as held", test.ok ? "sent" : test.reason, "held");
  is("and no delivery was taken", await allowanceUsed(third, "webhook"), usedBefore);
  await revokeKey(third.sid, dotWriter.body.made?.id ?? "");

  part("L4: using a key at the instant its maker is rewritten never writes the old maker back");
  // A key never used yet, so this use writes when it was last used.
  const dotFresh = await make(dotLink, "Dot's fresh", third);
  hook = async (commands) => {
    if (!(commands.length === 1 && commands[0][0] === "HSET" && (commands[0][1] === `nl:api:used:${third.sid}` || (commands[0][1] === `nl:api:keys:${third.sid}` && String(commands[0][3]).includes('"usedAt":1'))))) return;
    hook = null;
    await rewriteMakers(third.sid, (m) => (!m.owner && m.by === makerPrint(third.sid, DOT) ? { owner: false, by: "", step: m.step, left: true } : null));
  };
  await asApi(dotFresh.body.key ?? "");
  const touched = hook === null;
  hook = null;
  is("the use wrote when it was last used, after the rewrite", touched, true);
  is("the rewrite stands", (await rec3("Dot's fresh")).maker?.left, true);
  await revokeKey(third.sid, dotFresh.body.made?.id ?? "");
  await revokeKey(third.sid, dotKey.body.made?.id ?? "");

  await newDay();
  part("L5: a teammate moved to a role that cannot hand out keys has theirs wait for the owner");
  const eveKey = await make(await openSession(EVE), "Eve's sync", third, true);
  await setMemberRole(third, EVE, "editor");
  is("paused for the role", [await hold3(eveKey.body.made?.id ?? ""), (await asApi(eveKey.body.key ?? "")).error], ["role", "key_paused"]);
  // A1 (fifth review): turning it on cannot override the role it answers to; once the role allows it again, the owner can.
  is("while her role does not allow it, the owner cannot turn it on", (await keys(owner3Passkey, { action: "turn_on", id: eveKey.body.made?.id ?? "" }, third)).body.error, "role_disallows");
  await setMemberRole(third, EVE, "admin");
  is("the owner turns it back on", (await keys(owner3Passkey, { action: "turn_on", id: eveKey.body.made?.id ?? "" }, third)).body.ok, true);
  is("and it works", await asApi(eveKey.body.key ?? ""), { status: 200, error: "" });
  await revokeKey(third.sid, eveKey.body.made?.id ?? "");

  await newDay();
  part("M4: when the keys cannot follow a move, the membership stays where it was");
  await putMember(third, ADA, "admin");
  const adaKey = await make(await openSession(ADA), "Ada's sheet", third);
  hook = async (commands) => {
    if (!commands.some((c) => (c[0] === "HSET" || (c[0] === "EVAL" && c[1] === RECORD_SWAP)) && (c[1] === `nl:api:keys:${third.sid}` || c[3] === `nl:api:keys:${third.sid}`))) return;
    hook = null;
    throw new Error("a stand-in for a failed rewrite");
  };
  await moveMemberships(ADA, ADA2);
  hook = null;
  is("the membership stayed on the old address", [(await readTeam(third.sid)).members.some((m) => m.email === ADA), (await readTeam(third.sid)).members.some((m) => m.email === ADA2)], [true, false]);
  is("and the key is still hers there", (await shownKeys(third, ADA, "admin")).find((k) => k.name === "Ada's sheet")?.maker, "you");
  is("and still works", (await asApi(adaKey.body.key ?? "")).status, 200);


  // ------------------------------------------------------------------ the third review
  for (const email of [FIN, GIA, HAL]) await putMember(fourth, email, "admin");
  await makePasskey(OWNER4, "pk-owner4").keep();
  const owner4Passkey = await openSession(OWNER4, "passkey", "pk-owner4");
  const hold4 = async (id: string) => (await realPipeline([["HGET", `nl:api:hold:${fourth.sid}`, id]]))[0];
  const finLink = await openSession(FIN);

  await newDay();
  part("M5 (b): a teammate's key whose maker matches nobody on the team is refused at the door, at one command more");
  const finKey = await make(finLink, "Fin's sheet", fourth);
  let doorCommands = 0;
  hook = async (commands) => {
    doorCommands += commands.length;
  };
  is("a teammate's key works", await asApi(finKey.body.key ?? ""), { status: 200, error: "" });
  hook = null;
  is("within an API request's own commands", doorCommands <= 20 + TAKE_COMMANDS, true);
  // As if the secret its fingerprint was made under were gone: it matches nobody now.
  const ghost = await makeKey(fourth.sid, "Ghost's sync", Date.now(), false, "none", makerFor(fourth.sid, "admin", "ghost@example.com", false));
  if (!ghost.ok) throw new Error("ghost key not made");
  is("refused, as made by someone who could not be matched to the team (not as one who left)", [await asApi(ghost.key), lastMessage], [{ status: 403, error: "key_paused" }, KEY_PAUSED_WORDS.unmatched]);
  is("and the endpoints it added would hear nothing", (await shownKeys(fourth, OWNER4, "owner")).find((k) => k.name === "Ghost's sync")?.why, "unmatched");

  part("M5 (a), N2: a teammate leaving holds a key whose maker matches nobody, but never for good on a guess");
  await removeMember(fourth, HAL);
  is("the ghost's key is held as unmatched", await hold4(ghost.made.id), "unmatched");
  const ghostShown = (await shownKeys(fourth, OWNER4, "owner")).find((k) => k.name === "Ghost's sync")!;
  is("the owner may turn it back on", ghostShown.mayTurnOn, true);
  // A1 (fifth review): turning on an unmatched key means saying whose it is; it then answers to that person.
  is("turning it on without saying whose it is is refused", (await keys(owner4Passkey, { action: "turn_on", id: ghost.made.id }, fourth)).body.error, "whose");
  is("the owner may give it to Gia, an Admin", ghostShown.whoseChoices.includes(GIA), true);
  is("given to Gia, it is hers and works", [(await keys(owner4Passkey, { action: "turn_on", id: ghost.made.id, as: GIA }, fourth)).body.ok, await hold4(ghost.made.id), (await keyRecords(fourth.sid)).find((k) => k.id === ghost.made.id)?.maker?.by === makerPrint(fourth.sid, GIA), (await asApi(ghost.key)).status], [true, "vouched", true, 200]);
  await removeMember(fourth, GIA);
  is("and when Gia leaves, it goes with her, for good", [await hold4(ghost.made.id), (await asApi(ghost.key)).error], ["left", "key_paused"]);
  await putMember(fourth, GIA, "admin");
  is("Fin's is untouched", [await hold4(finKey.body.made?.id ?? ""), (await asApi(finKey.body.key ?? "")).status], [null, 200]);

  part("M6: the owner is told which keys a teammate leaving paused, and each refusal says why");
  const unknownKey = await makeKey(fourth.sid, "Owner's old zap");
  if (!unknownKey.ok) throw new Error("old key not made");
  const mailsBefore = sent.length;
  await putMember(fourth, HAL, "admin");
  await removeMember(fourth, HAL);
  const ownerMail = sent.slice(mailsBefore).find((m) => m.to === OWNER4);
  is("one email to the owner", sent.slice(mailsBefore).filter((m) => m.to === OWNER4).length, 1);
  is(
    "it names the key, says why, and how to turn it back on, in plain words",
    [ownerMail?.subject, ownerMail?.text.includes("- Owner's old zap"), ownerMail?.text.includes("nobody is recorded as having made them"), ownerMail?.text.includes('press "Turn back on"'), /urgent|immediately|asap/i.test(ownerMail?.text ?? "")],
    ["Some API keys for keys-third-round were paused", true, true, true, false],
  );
  is("the unrecorded key's refusal says the owner can turn it back on", [(await asApi(unknownKey.key)).error, lastMessage], ["key_paused", KEY_PAUSED_WORDS.unrecorded]);
  await swapHolds(fourth.sid, [finKey.body.made?.id ?? ""], "told", [null]);
  is("a key paused by the rule says whoever made it can turn it on", [(await asApi(finKey.body.key ?? "")).error, lastMessage], ["key_paused", KEY_PAUSED_WORDS.rule]);
  await swapHolds(fourth.sid, [finKey.body.made?.id ?? ""], "role", ["told"]);
  is("one paused for its maker's role says it waits for the owner", [(await asApi(finKey.body.key ?? "")).error, lastMessage], ["key_paused", KEY_PAUSED_WORDS.role]);
  await swapHolds(fourth.sid, [finKey.body.made?.id ?? ""], null, ["role"]);
  await revokeKey(fourth.sid, unknownKey.made.id);
  await revokeKey(fourth.sid, ghost.made.id);

  await newDay();
  part("M5 (c): when the sweep after a removal fails, the route says to repeat it, and repeating finishes it");
  await putMember(fourth, HAL, "admin");
  const halKey = await make(await openSession(HAL), "Hal's sync", fourth);
  let teamSaved = false;
  hook = async (commands) => {
    if (writes(commands, "SET", `nl:team:${fourth.sid}`)) teamSaved = true;
    else if (teamSaved && commands.some((c) => c[0] === "HGETALL" && c[1] === `nl:api:keys:${fourth.sid}`)) {
      hook = null;
      // A key Hal made in between the two sweeps, then the sweep after fails.
      await makeKey(fourth.sid, "Hal's late one", Date.now(), false, "none", makerFor(fourth.sid, "admin", HAL, false));
      throw new Error("a stand-in for a failed sweep");
    }
  };
  const cutRemove = await team(owner4Passkey, { action: "remove", email: HAL }, fourth);
  hook = null;
  is("answered: repeat the removal", [cutRemove.status, cutRemove.body.error], [503, "repeat"]);
  const halLate = (await keyRecords(fourth.sid)).find((k) => k.name === "Hal's late one")!;
  is("Hal is off the team, and his keys are refused all the same", [(await readTeam(fourth.sid)).members.some((m) => m.email === HAL), (await asApi(halKey.body.key ?? "")).error, halLate.hold], [false, "key_paused", null]);
  const repeated = await team(owner4Passkey, { action: "remove", email: HAL }, fourth);
  is("repeated: answered, not a silent 404", [repeated.status, repeated.body.ok, (repeated.body as { already?: boolean }).already], [200, true, true]);
  is("and the key he made in between is held for good", await hold4(halLate.id), "left");
  await revokeKey(fourth.sid, halKey.body.made?.id ?? "");
  await revokeKey(fourth.sid, halLate.id);

  await newDay();
  part("L5: a role change that cannot be saved undoes its pause; one whose pause fails changes nothing");
  const giaLink = await openSession(GIA);
  const giaKey = await make(giaLink, "Gia's writer", fourth, true);
  const noMaker = await makeKey(fourth.sid, "Nobody's sync", Date.now(), true);
  if (!noMaker.ok) throw new Error("key not made");
  hook = async (commands) => {
    if (!writes(commands, "SET", `nl:team:${fourth.sid}`)) return;
    hook = null;
    throw new Error("a stand-in for a failed save");
  };
  const unsavedRole = await setMemberRole(fourth, GIA, "editor").then(() => "saved", () => "refused");
  is("the change is refused", unsavedRole, "refused");
  is("and the keys it paused are back on", [await hold4(giaKey.body.made?.id ?? ""), await hold4(noMaker.made.id), (await readTeam(fourth.sid)).members.find((m) => m.email === GIA)?.role], [null, null, "admin"]);
  hook = async (commands) => {
    if (!commands.some((c) => c[0] === "EVAL" && c[1] === HOLD_SWAP && c[5] === "role")) return;
    hook = null;
    throw new Error("a stand-in for a failed pause");
  };
  const pauseFailed = await setMemberRole(fourth, GIA, "editor").then(() => "saved", () => "refused");
  is("a pause that fails changes no role", [pauseFailed, (await readTeam(fourth.sid)).members.find((m) => m.email === GIA)?.role], ["refused", "admin"]);
  const demoted = await setMemberRole(fourth, GIA, "editor");
  is("tried again, it goes through", demoted.ok, true);
  is("her key and the unrecorded writer wait for the owner", [await hold4(giaKey.body.made?.id ?? ""), await hold4(noMaker.made.id)], ["role", "role"]);
  is("and the refusal says so", [(await asApi(giaKey.body.key ?? "")).error, lastMessage], ["key_paused", KEY_PAUSED_WORDS.role]);
  await revokeKey(fourth.sid, giaKey.body.made?.id ?? "");
  await revokeKey(fourth.sid, noMaker.made.id);

  part("L7: turning a key back on says it will not be paused by the rule again, before it is done");
  is("the note for a key paused for its maker's role", turnOnNote({ why: "role" }), "It works again at once, and the team's two-step rule will not pause it again. It stops again if its maker's role no longer allows such a key, or when they leave the team.");
  is("and for one given to a teammate, it says it becomes theirs and when it stops", turnOnNote({ why: "unmatched" }, GIA).startsWith(`It becomes ${GIA}'s: it works again at once and the team's two-step rule will not pause it again, but it stops if their role no longer allows such a key or they leave the team.`), true);
  is("and for one nobody is recorded as making", turnOnNote({ why: "unrecorded" }).includes("will not pause it again"), true);
  const editorSource = readFileSync("components/api-key-editor.tsx", "utf8");
  is("the panel asks with it before turning on", editorSource.includes("{turnOnNote(key, whose)}") && editorSource.includes("Yes, turn it on") && editorSource.includes("setTurning(key.id);"), true);

  await newDay();
  part("M4: a move whose team cannot be saved puts the keys back on the old address");
  const finMove = await make(finLink, "Fin's move", fourth);
  hook = async (commands) => {
    if (!writes(commands, "SET", `nl:team:${fourth.sid}`)) return;
    hook = null;
    throw new Error("a stand-in for a failed save");
  };
  await moveMemberships(FIN, FIN2).catch(() => undefined);
  hook = null;
  is("the key still reads as Fin's", (await shownKeys(fourth, FIN, "admin")).find((k) => k.name === "Fin's move")?.maker, "you");
  is("and works", (await asApi(finMove.body.key ?? "")).status, 200);

  part("L6: rewriting who made a key never brings back one revoked meanwhile");
  hook = async (commands) => {
    if (!commands.some((c) => c[0] === "EVAL" && c[1] === RECORD_SWAP)) return;
    hook = null;
    await revokeKey(fourth.sid, finMove.body.made?.id ?? "");
  };
  await rewriteMakers(fourth.sid, (m) => (!m.owner && m.by === makerPrint(fourth.sid, FIN) ? { ...m, step: true } : null));
  hook = null;
  is("the revoked key's record stays gone", await realPipeline([["HGET", `nl:api:keys:${fourth.sid}`, finMove.body.made?.id ?? ""]]), [null]);


  // ------------------------------------------------------------------ the fourth review
  await putMember(fourth, IVY, "admin");
  const ivyLink = await openSession(IVY);
  const setRoleRaw = async (on: Store, who: string, role: string) => {
    const raw = JSON.parse(String((await realPipeline([["GET", `nl:team:${on.sid}`]]))[0])) as { members: { email: string; role: string }[] };
    await realPipeline([["SET", `nl:team:${on.sid}`, JSON.stringify({ ...raw, members: raw.members.map((m) => (m.email === who ? { ...m, role } : m)) })]]);
  };

  await newDay();
  part("N1: a key written as its maker is demoted, checked against the old role, is refused at the door by the new one");
  let keyWritten = false;
  afterHook = async (commands) => {
    if (commands.some((c) => c[0] === "HSET" && c[1] === `nl:api:keys:${fourth.sid}`)) keyWritten = true;
    else if (keyWritten && commands.some((c) => c[0] === "GET" && c[1] === `nl:team:${fourth.sid}`)) {
      // The route read the team (still an Admin); the demotion is saved right after, its pause having read the keys before.
      afterHook = null;
      await setRoleRaw(fourth, IVY, "editor");
    }
  };
  const ivyKey = await make(ivyLink, "Ivy's writer", fourth, true);
  afterHook = null;
  is("made and not paused by the route, which saw the old role", [ivyKey.body.ok, ivyKey.body.paused, await hold4(ivyKey.body.made?.id ?? "")], [true, false, null]);
  is("refused at the door: the role does not allow it", [(await asApi(ivyKey.body.key ?? "")).error, lastMessage], ["key_paused", KEY_PAUSED_WORDS.role]);
  await setRoleRaw(fourth, IVY, "admin");
  is("an Admin's key works again", (await asApi(ivyKey.body.key ?? "")).status, 200);
  await revokeKey(fourth.sid, ivyKey.body.made?.id ?? "");

  part("N3: a demotion that pauses keys nobody is recorded as making tells the owner, and says so plainly");
  const nobodys = await makeKey(fourth.sid, "Owner's older zap");
  if (!nobodys.ok) throw new Error("key not made");
  const beforeRole = sent.length;
  await setMemberRole(fourth, IVY, "support");
  const roleMail = sent.slice(beforeRole).filter((m) => m.to === OWNER4);
  is("one email to the owner, naming the key", [roleMail.length, roleMail[0]?.text.includes("- Owner's older zap"), roleMail[0]?.text.includes('press "Turn back on"')], [1, true, true]);
  is("its refusal says nobody is recorded as its maker, not whose role", [(await asApi(nobodys.key)).error, lastMessage, /role of the person/.test(lastMessage)], ["key_paused", KEY_PAUSED_WORDS.unrecorded, false]);
  await revokeKey(fourth.sid, nobodys.made.id);
  await setMemberRole(fourth, IVY, "admin");

  await newDay();
  part("N4: removing an address that was never on the team is not found, and touches nothing");
  const untouched = await makeKey(fourth.sid, "Untouched zap");
  if (!untouched.ok) throw new Error("key not made");
  const beforeTypo = sent.length;
  const typo = await team(owner4Passkey, { action: "remove", email: "never-here@example.com" }, fourth);
  is("404 not_found", [typo.status, typo.body.error], [404, "not_found"]);
  is("no key paused and nobody emailed", [await hold4(untouched.made.id), sent.length - beforeTypo], [null, 0]);
  await revokeKey(fourth.sid, untouched.made.id);

  await newDay();
  part("N2: a teammate leaving never reads the team in the middle of a move");
  const finThere = await make(finLink, "Fin's stay", fourth);
  let sweep: Promise<unknown> | null = null;
  afterHook = async (commands) => {
    if (!commands.some((c) => c[0] === "EVAL" && c[1] === RECORD_SWAP)) return;
    afterHook = null;
    // Fin's keys now carry the new address's print, the team still the old: an exit starting here must wait.
    sweep = leftTeam(fourth, GIA);
  };
  await moveMemberships(FIN, FIN3);
  await sweep;
  is("the move went through", (await readTeam(fourth.sid)).members.some((m) => m.email === FIN3), true);
  is("and Fin's key was never held", [await hold4(finThere.body.made?.id ?? ""), (await asApi(finThere.body.key ?? "")).status], [null, 200]);
  await revokeKey(fourth.sid, finThere.body.made?.id ?? "");

  await newDay();
  part("N5: a rewrite that cannot finish throws, so a move is undone");
  const finAgain = await make(await openSession(FIN3), "Fin's again", fourth);
  let changes = 0;
  hook = async (commands) => {
    const swap = commands.find((c) => c[0] === "EVAL" && c[1] === RECORD_SWAP);
    if (!swap) return;
    if ((changes += 1) > 3) {
      hook = null;
      return;
    }
    // The record changes under every try (as if used and rewritten elsewhere each time).
    const id = String(swap[4]);
    const raw = JSON.parse(String((await realPipeline([["HGET", `nl:api:keys:${fourth.sid}`, id]]))[0])) as Record<string, unknown>;
    await realPipeline([["HSET", `nl:api:keys:${fourth.sid}`, id, JSON.stringify({ ...raw, name: `${String(raw.name)}.` })]]);
  };
  await moveMemberships(FIN3, FIN2);
  hook = null;
  is("the membership stayed on the address before", [(await readTeam(fourth.sid)).members.some((m) => m.email === FIN3), (await readTeam(fourth.sid)).members.some((m) => m.email === FIN2)], [true, false]);
  is("and the key is still Fin's there, and works", [(await shownKeys(fourth, FIN3, "admin")).find((k) => k.id === finAgain.body.made?.id)?.maker, (await asApi(finAgain.body.key ?? "")).status], ["you", 200]);
  await revokeKey(fourth.sid, finAgain.body.made?.id ?? "");

  part("N6: the door reads the team as the studio does: a member it would not accept matches nobody");
  const odd = "odd-member@example.com";
  const oddKey = await makeKey(fourth.sid, "Odd's sync", Date.now(), false, "none", makerFor(fourth.sid, "admin", odd, false));
  if (!oddKey.ok) throw new Error("key not made");
  const teamNowRaw = JSON.parse(String((await realPipeline([["GET", `nl:team:${fourth.sid}`]]))[0])) as { members: unknown[] };
  await realPipeline([["SET", `nl:team:${fourth.sid}`, JSON.stringify({ ...teamNowRaw, members: [...teamNowRaw.members, { email: odd, role: "boss", joinedAt: "" }] })]]);
  is("a member with a role the studio does not know counts for nothing", [(await asApi(oddKey.key)).error, lastMessage], ["key_paused", KEY_PAUSED_WORDS.unmatched]);
  await realPipeline([["SET", `nl:team:${fourth.sid}`, JSON.stringify(teamNowRaw)]]);
  await revokeKey(fourth.sid, oddKey.made.id);

  part("The door still fits an API request's own commands");
  const door = await make(await openSession(FIN3), "Door check", fourth);
  let counted = 0;
  hook = async (commands) => {
    counted += commands.length;
  };
  await asApi(door.body.key ?? "");
  hook = null;
  is("at most 20 commands and the take", counted <= 20 + TAKE_COMMANDS, true);
  await revokeKey(fourth.sid, door.body.made?.id ?? "");


  // ------------------------------------------------------------------ the fifth review
  // Room: a store keeps five keys at most.
  for (const k of await keyRecords(fourth.sid)) await revokeKey(fourth.sid, k.id);
  await newDay();
  part("A1 (2): on a role change, a turned-on key whose maker matches nobody is held again, and the owner told");
  const strayKey = await makeKey(fourth.sid, "Stray sync", Date.now(), false, "none", makerFor(fourth.sid, "admin", "stray@example.com", false));
  if (!strayKey.ok) throw new Error("key not made");
  await swapHolds(fourth.sid, [strayKey.made.id], "vouched", [null]);
  const beforeStray = sent.length;
  await setMemberRole(fourth, IVY, "support");
  is("held as unmatched again", [await hold4(strayKey.made.id), (await asApi(strayKey.key)).error], ["unmatched", "key_paused"]);
  is("and the owner is told, with the likely cause", sent.slice(beforeStray).some((m) => m.to === OWNER4 && m.text.includes("- Stray sync") && m.text.includes("server's secret changed")), true);
  await setMemberRole(fourth, IVY, "admin");

  part("A2: the refusal and the panel name the likely cause and how to check");
  is("the API says the secret most likely changed, and to check whose it is", [lastMessage, /server's secret changed/.test(lastMessage), /check whose key it is/.test(lastMessage)], [KEY_PAUSED_WORDS.unmatched, true, true]);
  is("so does the panel", /server's secret changed/.test(pausedWords({ why: "unmatched", mayTurnOn: true })) && /check whose it is/.test(pausedWords({ why: "unmatched", mayTurnOn: true })), true);
  await revokeKey(fourth.sid, strayKey.made.id);

  await newDay();
  part("N5 note: when the first sweep of a removal cannot finish, it is undone and the person stays");
  // Gia was made an Editor earlier (L5): an Admin again, to hand out a key.
  await setMemberRole(fourth, GIA, "admin");
  const giaStay = await make(await openSession(GIA), "Gia's stay", fourth);
  let swaps = 0;
  hook = async (commands) => {
    const swap = commands.find((c) => c[0] === "EVAL" && c[1] === RECORD_SWAP);
    if (!swap) return;
    if ((swaps += 1) > 4) {
      hook = null;
      return;
    }
    const id = String(swap[4]);
    const raw = JSON.parse(String((await realPipeline([["HGET", `nl:api:keys:${fourth.sid}`, id]]))[0])) as Record<string, unknown>;
    await realPipeline([["HSET", `nl:api:keys:${fourth.sid}`, id, JSON.stringify({ ...raw, name: `${String(raw.name)}.` })]]);
  };
  const failedRemoval = await removeMember(fourth, GIA).then(() => "removed", () => "refused");
  hook = null;
  const giaRecord = (await keyRecords(fourth.sid)).find((k) => k.id === giaStay.body.made?.id)!;
  is("refused, and Gia stays on the team", [failedRemoval, (await readTeam(fourth.sid)).members.some((m) => m.email === GIA)], ["refused", true]);
  is("her key's hold and maker are back, and it works", [giaRecord.hold, giaRecord.maker?.left, giaRecord.maker?.by === makerPrint(fourth.sid, GIA), (await asApi(giaStay.body.key ?? "")).status], [null, undefined, true, 200]);
  await revokeKey(fourth.sid, giaStay.body.made?.id ?? "");


  // ------------------------------------------------------------------ owner order C3-121 (Codex G)
  for (const email of [JO, LEO]) await putMember(fifth, email, "admin");
  await makePasskey(OWNER5, "pk-owner5").keep();
  const owner5Passkey = await openSession(OWNER5, "passkey", "pk-owner5");
  await makePasskey(LEO, "pk-leo").keep();
  const leoPasskey = await openSession(LEO, "passkey", "pk-leo");
  const hold5 = async (id: string) => (await realPipeline([["HGET", `nl:api:hold:${fifth.sid}`, id]]))[0];

  await newDay();
  part("C3-121 GRAVE: with the rule on, a key without a second step is refused at the door even when no sweep held it");
  let ruleSaved = false;
  let joLate: Awaited<ReturnType<typeof makeKey>> | null = null;
  hook = async (commands) => {
    if (writes(commands, "SET", `nl:team:${fifth.sid}`) && !ruleSaved) {
      ruleSaved = true;
      // An Admin with no second step makes a key right before the rule is written.
      joLate = await makeKey(fifth.sid, "Jo's late writer", Date.now(), true, "none", makerFor(fifth.sid, "admin", JO, false));
      return;
    }
    if (ruleSaved && commands.some((c) => c[0] === "HGETALL" && c[1] === `nl:api:keys:${fifth.sid}`)) {
      hook = null;
      throw new Error("a stand-in for the second sweep failing");
    }
  };
  const ruleOn = await team(owner5Passkey, { action: "two-step", on: true, expect: (await pausePreview(fifth)).stamp }, fifth);
  hook = null;
  const joMade = joLate as Awaited<ReturnType<typeof makeKey>> | null;
  if (!joMade?.ok) throw new Error("Jo's key not made");
  is("the switch answers that it did not finish, the rule on", [ruleOn.status, ruleOn.body.error, ruleOn.body.on, (await readTeam(fifth.sid)).requireTwoStep], [502, "incomplete", true, true]);
  is("no sweep held Jo's key", await hold5(joMade.made.id), null);
  is("but the door refuses it, as the rule asks", [(await asApi(joMade.key)).error, lastMessage], ["key_paused", KEY_PAUSED_WORDS.rule]);
  const joEndpoint = await addEndpoint(fifth, "https://hooks.zapier.com/hooks/catch/9/jo", ["sale.completed"], Date.now(), joMade.made.id);
  is("and an endpoint it added hears nothing", [joEndpoint.ok, await sale(fifth)], [true, 0]);
  const leoKey = await make(leoPasskey, "Leo's sheet", fifth);
  is("a key made with a second step still works under the rule", (await asApi(leoKey.body.key ?? "")).status, 200);
  await revokeKey(fifth.sid, joMade.made.id);

  await newDay();
  part("C3-121 MÉDIO (a): a removal whose team cannot be written undoes its first sweep");
  hook = async (commands) => {
    if (!writes(commands, "SET", `nl:team:${fifth.sid}`)) return;
    hook = null;
    throw new Error("a stand-in for the team not being written");
  };
  const notRemoved = await removeMember(fifth, LEO).then(() => "removed", () => "refused");
  hook = null;
  const leoRecord = (await keyRecords(fifth.sid)).find((k) => k.id === leoKey.body.made?.id)!;
  is("refused, and Leo is still on the team", [notRemoved, (await readTeam(fifth.sid)).members.some((m) => m.email === LEO)], ["refused", true]);
  is("his key is not held for good, keeps its maker, and works", [leoRecord.hold, leoRecord.maker?.left, leoRecord.maker?.by === makerPrint(fifth.sid, LEO), (await asApi(leoKey.body.key ?? "")).status], [null, undefined, true, 200]);

  part("C3-121 MÉDIO (b): a hold written whose answer is lost is undone all the same");
  afterHook = async (commands) => {
    if (!commands.some((c) => c[0] === "EVAL" && c[1] === HOLD_SWAP && c[5] === "left")) return;
    afterHook = null;
    throw new Error("a stand-in for the answer lost on the way back");
  };
  const lost = await removeMember(fifth, LEO).then(() => "removed", () => "refused");
  afterHook = null;
  is("refused, and Leo is still on the team", [lost, (await readTeam(fifth.sid)).members.some((m) => m.email === LEO)], ["refused", true]);
  is("the hold that was written goes back, and the key works", [await hold5(leoKey.body.made?.id ?? ""), (await asApi(leoKey.body.key ?? "")).status], [null, 200]);
  await removeMember(fifth, LEO);
  is("a removal that goes through still holds it for good", [await hold5(leoKey.body.made?.id ?? ""), (await asApi(leoKey.body.key ?? "")).error], ["left", "key_paused"]);

  part("The developers page names the answer");
  const docs = readFileSync("app/developers/page.tsx", "utf8");
  is("403 key_paused is listed", docs.includes('403  {"error": "key_paused"') && docs.includes("A paused key is never deleted."), true);
  is("with what happens to the endpoints a key added", docs.includes("stop for good when it is revoked"), true);

  done();
}

void main();
