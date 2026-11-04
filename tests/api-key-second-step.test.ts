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
import { keyRecords, makeKey, makerPrint, resolveKey, revokeKey } from "@/lib/api-keys";
import { makerFor, pauseIfRuleOn, pausePreview, pausesUnderRule, shownKeys } from "@/lib/api-key-pause";
import { MAKER_FORMER, MAKER_UNRECORDED } from "@/lib/api-key-rules";
import { apiStore } from "@/lib/api-guard";
import { moveMemberships, putMember, readTeam, removeMember } from "@/lib/team";
import { type Store, claimHandle, ensureListId, ensureStatsId, ensureStoreId, setSubscription, storeForEmail } from "@/lib/store";
import { addEndpoint, emitEvent, setSendHooksForTests, webhooksView } from "@/lib/webhooks";
import { TeamTwoStepReview } from "@/components/team-two-step-switch";
import { makePasskey } from "./passkey-world";
import { paidPeriod } from "./billing-period-fixture";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

process.env.NIMBUS_DATA_KEY ??= "tests-only-not-a-real-deployment-secret";
process.env.RESEND_API_KEY = "re_test_api_key_second_step_only";
const sent: { to: string; subject: string; text: string }[] = [];
// The paused-keys emails; the creator's own notices (a webhook added) are not this test's.
const mails = { get length() { return sent.filter((m) => m.subject.includes("API key")).length; }, list: () => sent.filter((m) => m.subject.includes("API key")) };
let resendDown = false;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  if (String(input).includes("resend")) {
    if (resendDown) return new Response("{}", { status: 500 });
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
redis.pipeline = async (commands: Commands) => {
  if (hook) await hook(commands);
  return realPipeline(commands);
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
  const team = async (session: string, body: unknown) => (await call(teamRoute, "/api/store/team", store, session, body)) as { status: number; body: TeamAnswer };
  const make = (session: string, name: string, on = store, write = false) => keys(session, { action: "make", name, write }, on);
  const asApi = async (key: string) => {
    const found = await apiStore(new Request(`${ORIGIN}/api/v1/store`, { headers: { authorization: `Bearer ${key}` } }));
    if (found instanceof Response) return { status: found.status, error: ((await found.json()) as { error?: string }).error };
    return { status: 200, error: "" };
  };
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
    redis.pipeline([store, other].map((s) => ["DEL", `nl:rl:studio-essential:${createHash("sha256").update(`nimbus-studio-essential:${s.sid}`).digest("hex").slice(0, 32)}`]));
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
  is("an owner's key never is", await pauseIfRuleOn(store, ownerMade.body.made?.id ?? "", makerFor(store.sid, "owner", OWNER, false)), false);

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

  part("The developers page names the answer");
  const docs = readFileSync("app/developers/page.tsx", "utf8");
  is("403 key_paused is listed", docs.includes('403  {"error": "key_paused"') && docs.includes("A paused key is never deleted."), true);
  is("with what happens to the endpoints a key added", docs.includes("stop for good when it is revoked"), true);

  done();
}

void main();
