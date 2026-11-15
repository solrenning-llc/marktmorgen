/**
 * A partnership offered to somebody who already has a store here.
 *
 * The first version of this was going to recognise the invited partner as a
 * creator of ours and write them straight into the programme — no email, no
 * link, done. That was wrong, and worth recording why: a share of every sale
 * is a commercial agreement, and creating it because we happen to know who
 * they are would be removing their consent to remove our friction. Knowing
 * somebody is a customer is a reason to ask them somewhere better. It is never
 * a reason to stop asking.
 *
 * So the agreement moves rather than disappearing: instead of a link in an
 * inbox, where things are lost, the offer waits in the studio they open on
 * purpose, with the share and the product names on the card they press. That
 * is a better record of agreement than an opened email, not a worse one.
 *
 * The reason this is worth building at all is quieter than the convenience.
 * Every partnership between two creators here ties both of them to the same
 * place through a relationship neither wants to break, and a hundred of those
 * is denser than a hundred separate stores. It is the one network effect
 * available without operating a public marketplace.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AFFILIATES_WORDS } from "@/lib/buyer-words/affiliates";
import {
  MAX_WAITING,
  answerInvite,
  offerPartnership,
  offerWords,
  waitingFor,
  waitingOne,
} from "@/lib/partner-invites";

const ANA = "ana@example.com";
const BRUNO = "bruno@example.com";
const OFFER = {
  sid: "st_harbor",
  storeName: "Harbor Kitchen",
  handle: "harbor",
  share: { percent: 30, products: ["prodaaaaaa"] },
  titles: ["The Sourdough Course"],
};

// ---- the offer waits, and only for the person it is for -----------------

test("an offer waits for the creator it was left for", async () => {
  const made = await offerPartnership(ANA, OFFER);
  assert.equal(made.ok, true);
  const waiting = await waitingFor(ANA);
  assert.equal(waiting.length, 1);
  assert.equal(waiting[0].share.percent, 30);
  assert.equal(waiting[0].storeName, "Harbor Kitchen");
});

test("nobody else can see it", async () => {
  assert.deepEqual(await waitingFor(BRUNO), [], "an offer is addressed, not broadcast");
  assert.deepEqual(await waitingFor(""), []);
});

test("the address is matched however it is typed", async () => {
  const waiting = await waitingFor("  ANA@Example.com ");
  assert.equal(waiting.length, 1, "the same person is the same person");
});

test("an offer can be read back by its id, and only with the right address", async () => {
  const [one] = await waitingFor(ANA);
  assert.ok(await waitingOne(ANA, one.id));
  assert.equal(await waitingOne(BRUNO, one.id), null, "knowing an id is not being the person it was left for");
  assert.equal(await waitingOne(ANA, "nonsense"), null);
});

test("changing your mind leaves one current offer, not a pile to choose from", async () => {
  await offerPartnership(ANA, { ...OFFER, share: { percent: 45, products: ["prodaaaaaa"] } });
  const waiting = await waitingFor(ANA);
  assert.equal(waiting.length, 1, "the same store's earlier offer is replaced");
  assert.equal(waiting[0].share.percent, 45, "and the one left is the current one");
});

test("two different stores can both be waiting", async () => {
  await offerPartnership(ANA, { ...OFFER, sid: "st_other", storeName: "Other Shop", handle: "other" });
  const waiting = await waitingFor(ANA);
  assert.equal(waiting.length, 2);
  assert.deepEqual(waiting.map((w) => w.storeName).sort(), ["Harbor Kitchen", "Other Shop"]);
});

test("answering takes it out, whichever way it was answered", async () => {
  const waiting = await waitingFor(ANA);
  for (const offer of waiting) assert.equal(await answerInvite(ANA, offer.id), true);
  assert.deepEqual(await waitingFor(ANA), []);
  assert.equal(await answerInvite(ANA, waiting[0].id), false, "answering twice is not an error, just nothing to do");
});

test("a studio cannot be flooded with offers", async () => {
  for (let i = 0; i < MAX_WAITING + 5; i += 1) {
    await offerPartnership(BRUNO, { ...OFFER, sid: `st_${i}`, storeName: `Store ${i}` });
  }
  const waiting = await waitingFor(BRUNO);
  assert.ok(waiting.length <= MAX_WAITING, `${waiting.length} offers waiting, over the cap of ${MAX_WAITING}`);
  for (const offer of waiting) await answerInvite(BRUNO, offer.id);
});

// ---- what the person reads before deciding ------------------------------

test("the sentence names the share, the products, and the part that is easy to miss", () => {
  const words = offerWords({ ...OFFER, id: "a1b2c3d4e5f6", at: Date.now() });
  assert.match(words, /Harbor Kitchen/, "who is offering");
  assert.match(words, /30%/, "how much");
  assert.match(words, /The Sourdough Course/, "of what");
  assert.match(
    words,
    /on every sale, not only the ones you send them/,
    "the difference between a partnership and an affiliate commission is the whole point, and it is the part somebody skims past",
  );
});

test("the terms are on the card they press, not in a message somewhere else", () => {
  const studio = readFileSync(join(process.cwd(), "components/affiliate-studio.tsx"), "utf8");
  const at = studio.indexOf("export function PartnerOffers");
  assert.ok(at > 0, "the card has to exist");
  const body = studio.slice(at);
  assert.match(body, /\{offer\.words\}/, "the share and the products are on the card");
  assert.match(body, /a refunded sale earns nothing/, "and what it does not pay");
  assert.match(body, /never holds it/, "and who actually pays them");
  assert.match(body, /Accept \$\{offer\.percent\}%/, "and the button says the number, so nobody accepts a blank");
});

// ---- consent, which is the whole reason this exists ---------------------

test("nothing is written into the programme until the person answers", () => {
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("if (input.alreadyHere)");
  assert.ok(at > 0, "the recognising branch should exist");
  const branch = aff.slice(at, at + 1_600);
  // Rule 23: the record writers are now makeAffiliate and changeAffiliate; none of them may be here either.
  assert.doesNotMatch(branch, /writeAffiliate|writeNewAffiliate|makeAffiliate|changeAffiliate|acceptPartnership/, "recognising somebody is not agreeing for them");
  assert.match(branch, /offerPartnership\(/, "it leaves an offer");
  // The reason belongs in the comment over the branch, which is above `at`.
  assert.match(
    aff.slice(Math.max(0, at - 500), at),
    /moves the agreement, it does not skip it/,
    "and says so, because the shortcut is the tempting mistake",
  );
});

test("only the address the offer was left for can accept it", () => {
  // guarded.ref is a store; guarded.email is the person signed in. Reading the
  // offer with the wrong one of those was a real mistake in this code, and it
  // failed closed rather than open — but it is worth a test either way.
  const route = readFileSync(join(process.cwd(), "app/api/store/affiliates/route.ts"), "utf8");
  const at = route.indexOf('if (action === "answer")');
  assert.ok(at > 0, "the answer action should exist");
  // Without the comments: the explanation names `guarded.ref` on purpose, to
  // say which one NOT to use, and an assertion about absence has to look at
  // the code rather than at the prose about the code.
  const body = route
    .slice(at, route.indexOf('if (action === "invite")'))
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.doesNotMatch(body, /guarded\.ref/, "an offer is addressed to a person, not to a store");
  assert.match(body, /waitingOne\(guarded\.email/, "so it is read for the person signed in");
  assert.match(body, /acceptPartnership\(from, guarded\.email/, "and written for them too");
});

test("accepting goes through the same record every other partner is made from", () => {
  // Not a second way of making a partner, which would be a second way of
  // getting it wrong: it mints the grant the email would have carried.
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("export async function acceptPartnership");
  const body = aff.slice(at, at + 1_200);
  // Altered 2026-11-07 (rule 23): the path now also carries who pays for reading the program (`charge`).
  assert.match(body, /openAffiliateLink\(store, token, charge\)/, "the same path an opened invitation takes, paid by whoever answers");
  assert.match(body, /k: 1, p: share/, "carrying the same approval and the same share");
});

test("a creator is never offered a partnership on their own store", () => {
  const route = readFileSync(join(process.cwd(), "app/api/store/affiliates/route.ts"), "utf8");
  assert.match(
    route,
    /theirs && theirs\.sid !== store\.sid/,
    "inviting yourself would make you your own partner and pay you a share of your own sales",
  );
});

test("the offer is still emailed, because a studio nobody opens is a letter nobody sent", () => {
  const aff = readFileSync(join(process.cwd(), "lib/affiliates.ts"), "utf8");
  const at = aff.indexOf("if (input.alreadyHere)");
  const branch = aff.slice(at, at + 1_600);
  assert.match(branch, /sendEmail\(/, "they are told it is there");
  // The words are in the store's language (lib/buyer-words/affiliates.ts).
  assert.match(branch, /a\.partnerInStudio/, "and where to find it");
  assert.match(branch, /a\.partnerAnswer/, "and that it is theirs to decide");
  assert.match(AFFILIATES_WORDS.en.partnerInStudio, /waiting in your own studio/, "said in English as it always was");
  assert.match(AFFILIATES_WORDS.en.partnerAnswer, /Nothing happens until you answer it/);
});
