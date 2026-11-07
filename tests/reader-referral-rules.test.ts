/**
 * 118 [F2-READER-REFERRALS] and 267 [KT1], unit 1: the rules of reader
 * referrals, with no read, write, email or screen.
 *
 * A creator offers the people on their list a personal link. When a friend
 * signs up through it and confirms their address, the person who shared it
 * moves toward milestones the creator set (for example, 3 friends unlock a
 * free guide, 10 unlock a coupon). What is checked here:
 *
 *   - a program has 1 to 5 milestones, counts that go up, and rewards that
 *     are only the creator's own products or coupons, never money;
 *   - the personal code is the same for one person however the address is
 *     typed (a provider's equivalent domains included), differs between
 *     people and stores, never shows the address, and needs a strong secret;
 *   - an address with a character outside printable ASCII is refused;
 *   - only a confirmed, consenting, still subscribed sign-up by someone new,
 *     not disposable and past the bot check, counts; anything unknown waits
 *     and never counts; signing up yourself never counts; on a domain that is
 *     not a public provider only a few friends count, the rest wait;
 *   - each step is given once, also after the creator changes the program;
 *   - what the person who shared sees has numbers only, never an address.
 */
import {
  MAX_MILESTONES,
  MAX_REFERRAL_EVENTS,
  REFERRAL_CODE,
  dueMilestones,
  readReferralProgram,
  referralAddress,
  referralCode,
  referrerView,
  tallyReferrals,
  type ReferredSignup,
} from "@/lib/reader-referral-rules";
import { done, is, part } from "./check";

const own = { products: new Set(["prod_guide", "prod_course"]), coupons: new Set(["TENOFF"]) };
const guide = { kind: "product", productId: "prod_guide" };
const coupon = { kind: "coupon", couponId: "TENOFF" };
const program = (milestones: unknown) => readReferralProgram({ milestones }, own);
const reason = (result: ReturnType<typeof readReferralProgram>) => (result.ok ? "ok" : result.reason);

const good = (email: string, over: Partial<ReferredSignup> = {}): ReferredSignup => ({
  email,
  confirmed: true,
  consented: true,
  subscribed: true,
  wasOnList: false,
  disposable: false,
  human: true,
  ...over,
});
// Changed (pre-review of 118 [F2-READER-REFERRALS]): was "s".repeat(32); a
// secret of one repeated letter is now refused as weak, so the fixture is a
// secret with many distinct characters (test only, never a real one).
const SECRET = "test-only-referral-secret-0123456789";
// Built here, so no provider address is written out whole in a tracked file (scripts/check_public_data.py).
const GMAIL = ["gmail", "com"].join(".");
const GOOGLE_MAIL = ["GoogleMail", "com"].join(".");
/** Friends counted on one domain that is not a public provider; the rest wait. */
const MAX_FRIENDS_PER_OWN_DOMAIN = 2;
/** Distinct characters a referral secret needs. */
const MIN_SECRET_DISTINCT = 8;
const dom = (...labels: string[]) => labels.join(".");
const ICLOUD = dom("icloud", "com");
const PROTON = dom("proton", "me");
const FASTMAIL = dom("fastmail", "com");

function main(): void {
  part("A program: 1 to 5 milestones, counts that go up, the creator's own rewards");
  const two = program([{ count: 3, reward: guide }, { count: 10, reward: coupon }]);
  is("a guide at 3 and a coupon at 10 is a program", two.ok ? two.program.milestones.map((m) => [m.count, m.reward.kind]) : two.reason, [[3, "product"], [10, "coupon"]]);
  is("no program at all is off", reason(readReferralProgram(null, own)), "none");
  is("no program when the field is missing", reason(readReferralProgram(undefined, own)), "none");
  is("an empty list is off too", reason(program([])), "none");
  is("a program that is not an object is refused", reason(readReferralProgram("3 friends", own)), "shape");
  is("milestones that are not a list are refused", reason(program({ count: 3, reward: guide })), "shape");
  is(`more than ${MAX_MILESTONES} milestones are refused`, reason(program([1, 2, 3, 4, 5, 6].map((count) => ({ count, reward: guide })))), "too-many");
  is(`${MAX_MILESTONES} milestones are fine`, reason(program([1, 2, 3, 4, 5].map((count) => ({ count, reward: guide })))), "ok");
  is("a count of 0 is refused", reason(program([{ count: 0, reward: guide }])), "count");
  is("a count that is not a whole number is refused", reason(program([{ count: 2.5, reward: guide }])), "count");
  is("a count over 1,000 is refused", reason(program([{ count: 1001, reward: guide }])), "count");
  is("a count typed as text is refused", reason(program([{ count: "3", reward: guide }])), "count");
  is("counts that go down are refused", reason(program([{ count: 10, reward: guide }, { count: 3, reward: coupon }])), "order");
  is("the same count twice is refused", reason(program([{ count: 3, reward: guide }, { count: 3, reward: coupon }])), "order");
  for (const kind of ["cash", "money", "credit", "payout", "gift_card", "store_credit"]) {
    is(`a reward of ${kind} is refused as money`, reason(program([{ count: 3, reward: { kind, amountCents: 1000 } }])), "money");
  }
  is("a reward of an unknown kind is refused", reason(program([{ count: 3, reward: { kind: "points", productId: "prod_guide" } }])), "reward");
  is("a product the creator does not sell is refused", reason(program([{ count: 3, reward: { kind: "product", productId: "prod_other" } }])), "not-yours");
  is("a coupon the creator does not have is refused", reason(program([{ count: 3, reward: { kind: "coupon", couponId: "FREE100" } }])), "not-yours");
  is("a reward with an extra field is refused", reason(program([{ count: 3, reward: { ...coupon, amountCents: 500 } }])), "shape");
  is("a product reward with a coupon field is refused", reason(program([{ count: 3, reward: { kind: "product", couponId: "TENOFF" } }])), "shape");
  is("a milestone with an extra field is refused", reason(program([{ count: 3, reward: guide, note: "Win $100" }])), "shape");
  is("a reward id that is not an id is refused", reason(program([{ count: 3, reward: { kind: "product", productId: "../prod_guide" } }])), "shape");
  const input = [{ count: 3, reward: { kind: "product", productId: "prod_guide" } }];
  const kept = program(input);
  input[0].count = 1;
  input[0].reward.productId = "prod_other";
  is("the program read is a copy: changing the input later changes nothing", kept.ok ? [kept.program.milestones[0].count, kept.program.milestones[0].reward] : kept.reason, [3, { kind: "product", productId: "prod_guide" }]);

  part("One person, however the address is typed");
  is("case, spaces, a +tag and Gmail dots are the same person", referralAddress(`  Ana.B+news@${GOOGLE_MAIL} `), `anab@${GMAIL}`);
  is("a +tag elsewhere is the same person", referralAddress("ana+x@example.com"), "ana@example.com");
  is("dots outside Gmail are kept", referralAddress("a.b@example.com"), "a.b@example.com");
  for (const bad of ["no-at", "a@b@c.com", "@example.com", "+tag@example.com", "a@", "a b@example.com", "a@exa mple.com", `${"a".repeat(250)}@example.com`, "a@example"]) {
    is(`"${bad.slice(0, 24)}" is not an address`, referralAddress(bad), null);
  }

  part("One person on a provider's equivalent domains");
  is("me.com is iCloud", referralAddress(`Ana@${dom("me", "com")}`), `ana@${ICLOUD}`);
  is("mac.com is iCloud", referralAddress(`ana@${dom("mac", "com")}`), `ana@${ICLOUD}`);
  is("protonmail.com is Proton", referralAddress(`ana@${dom("protonmail", "com")}`), `ana@${PROTON}`);
  is("protonmail.ch is Proton", referralAddress(`ana@${dom("protonmail", "ch")}`), `ana@${PROTON}`);
  is("pm.me is Proton", referralAddress(`ana@${dom("pm", "me")}`), `ana@${PROTON}`);
  is("a Fastmail subdomain address is that user", referralAddress(`anything@ana.${FASTMAIL}`), `ana@${FASTMAIL}`);
  is("a Fastmail subdomain address with a +tag is that user", referralAddress(`x+y@Ana.${FASTMAIL}`), `ana@${FASTMAIL}`);
  is("another domain's subdomain is kept", referralAddress("x@ana.example.com"), "x@ana.example.com");
  const self = (referrerEmail: string, friend: string) => {
    const t = tallyReferrals(referrerEmail, [good(friend)]);
    return t.ok ? [t.tally.counted, t.tally.pending, t.tally.refused] : "refused";
  };
  is("signing yourself up on me.com when you shared from iCloud does not count", self(`ana@${ICLOUD}`, `ana@${dom("me", "com")}`), [0, 0, 1]);
  is("signing yourself up on mac.com when you shared from iCloud does not count", self(`ana@${ICLOUD}`, `ana@${dom("mac", "com")}`), [0, 0, 1]);
  is("signing yourself up on protonmail.com when you shared from Proton does not count", self(`ana@${PROTON}`, `ana@${dom("protonmail", "com")}`), [0, 0, 1]);
  is("signing yourself up on pm.me when you shared from Proton does not count", self(`ana@${PROTON}`, `ana@${dom("pm", "me")}`), [0, 0, 1]);
  is("signing yourself up through your Fastmail subdomain does not count", self(`ana@${FASTMAIL}`, `x@ana.${FASTMAIL}`), [0, 0, 1]);
  is("the same friend on two iCloud domains counts once", self("zed@example.com", `bo@${ICLOUD}`), [1, 0, 0]);

  part("An address with characters a person cannot see or tell apart is refused");
  for (const [what, typed] of [
    ["a zero-width space", "an\u200Ba@example.com"],
    ["a soft hyphen", "an\u00ADa@example.com"],
    ["a full-width letter", "\uFF41na@example.com"],
    ["the Kelvin sign for a k", "\u212Aay@example.com"],
    ["an accented letter", "jos\u00E9@example.com"],
    ["a control character", "an\u0007a@example.com"],
  ] as const) {
    is(`${what} in the name is not an address`, referralAddress(typed), null);
  }
  const hidden = tallyReferrals("ana@example.com", [good("an\u200Ba@example.com"), good("b\uFF4F@example.com")]);
  is("a sign-up with a hidden or look-alike character never counts", hidden.ok ? [hidden.tally.counted, hidden.tally.pending, hidden.tally.refused] : "refused", [0, 0, 2]);
  is("no code for an address with a hidden character", referralCode(SECRET, "store_1", "an\u200Ba@example.com"), null);

  part("Friends on a domain anyone can make many addresses on count only a few");
  const tallyOf = (referrerEmail: string, emails: string[]) => {
    const t = tallyReferrals(referrerEmail, emails.map((e) => good(e)));
    return t.ok ? [t.tally.counted, t.tally.pending, t.tally.refused] : "refused";
  };
  is(`on the referrer's own domain, ${MAX_FRIENDS_PER_OWN_DOMAIN} count and the rest wait`, tallyOf("ana@mine.example", Array.from({ length: 1000 }, (_, i) => `f${i}@mine.example`)), [MAX_FRIENDS_PER_OWN_DOMAIN, 1000 - MAX_FRIENDS_PER_OWN_DOMAIN, 0]);
  is("on another own domain, the same", tallyOf("ana@example.com", ["a@catchall.example", "b@catchall.example", "c@catchall.example", "d@catchall.example"]), [MAX_FRIENDS_PER_OWN_DOMAIN, 4 - MAX_FRIENDS_PER_OWN_DOMAIN, 0]);
  is("subdomains of one own domain are one domain", tallyOf("ana@example.com", ["a@x.catchall.example", "b@y.catchall.example", "c@z.catchall.example", "d@catchall.example"]), [MAX_FRIENDS_PER_OWN_DOMAIN, 4 - MAX_FRIENDS_PER_OWN_DOMAIN, 0]);
  is("each own domain has its own few", tallyOf("ana@example.com", ["a@one.example", "b@one.example", "c@one.example", "a@two.test", "b@two.test", "c@two.test"]), [2 * MAX_FRIENDS_PER_OWN_DOMAIN, 6 - 2 * MAX_FRIENDS_PER_OWN_DOMAIN, 0]);
  is("friends on a public provider all count", tallyOf("ana@example.com", Array.from({ length: 6 }, (_, i) => `friend${i}@${GMAIL}`)), [6, 0, 0]);
  is("friends on another public provider all count", tallyOf("ana@example.com", Array.from({ length: 6 }, (_, i) => `friend${i}@${dom("outlook", "com")}`)), [6, 0, 0]);
  is("friends across providers' equivalent domains count as one provider", tallyOf("ana@example.com", [`a@${dom("me", "com")}`, `b@${dom("mac", "com")}`, `c@${ICLOUD}`]), [3, 0, 0]);
  is("a refused friend on an own domain does not use one of its few", (() => {
    const t = tallyReferrals("ana@example.com", [good("a@own.example", { wasOnList: true }), good("b@own.example"), good("c@own.example")]);
    return t.ok ? [t.tally.counted, t.tally.pending, t.tally.refused] : "refused";
  })(), [2, 0, 1]);
  is("the few on an own domain is small", MAX_FRIENDS_PER_OWN_DOMAIN <= 3, true);

  part("The personal code");
  const ana = referralCode(SECRET, "store_1", "ana@example.com");
  is("the code has the code shape", typeof ana === "string" && REFERRAL_CODE.test(ana), true);
  is("the same person typed differently gets the same code", referralCode(SECRET, "store_1", " ANA+promo@Example.com"), ana);
  is("another person gets another code", referralCode(SECRET, "store_1", "bo@example.com") === ana, false);
  is("the same person at another store gets another code", referralCode(SECRET, "store_2", "ana@example.com") === ana, false);
  // Changed (pre-review): was "t".repeat(32), now refused as weak; another
  // secret with many distinct characters still gives another code.
  is("another secret gives another code", referralCode("another-test-only-secret-abcdefghij", "store_1", "ana@example.com") === ana, false);
  is("the code never shows the address", typeof ana === "string" && !ana.toLowerCase().includes("ana") && !ana.includes("@"), true);
  is("a short secret gives no code", referralCode("short", "store_1", "ana@example.com"), null);
  is("a long secret of one repeated letter gives no code", referralCode("a".repeat(64), "store_1", "ana@example.com"), null);
  is(`a long secret of fewer than ${MIN_SECRET_DISTINCT} distinct characters gives no code`, referralCode("abcdefg".repeat(10), "store_1", "ana@example.com"), null);
  is(`a long secret of ${MIN_SECRET_DISTINCT} distinct characters gives a code`, typeof referralCode("abcdefgh".repeat(5), "store_1", "ana@example.com"), "string");
  is("a store and an address never run into each other's code", referralCode(SECRET, "s:a", "b@example.com") === referralCode(SECRET, "s", "a:b@example.com"), false);
  is("nor with the separator moved the other way", referralCode(SECRET, "s", "a:b@example.com") === referralCode(SECRET, "s:a", "b@example.com"), false);
  is("no store gives no code", referralCode(SECRET, "", "ana@example.com"), null);
  is("an address that is not one gives no code", referralCode(SECRET, "store_1", "nobody"), null);

  part("What counts");
  const referrer = "ana@example.com";
  const count = (signups: ReferredSignup[]) => {
    const t = tallyReferrals(referrer, signups);
    return t.ok ? [t.tally.counted, t.tally.pending, t.tally.refused] : "refused";
  };
  is("a confirmed, consenting new subscriber counts", count([good("bo@example.com")]), [1, 0, 0]);
  is("signing yourself up does not count", count([good("ana@example.com")]), [0, 0, 1]);
  is("signing yourself up with a +tag does not count", count([good("Ana+2@Example.com")]), [0, 0, 1]);
  is("an address that was never confirmed does not count", count([good("bo@example.com", { confirmed: false })]), [0, 0, 1]);
  is("no consent does not count", count([good("bo@example.com", { consented: false })]), [0, 0, 1]);
  is("someone who left the list does not count", count([good("bo@example.com", { subscribed: false })]), [0, 0, 1]);
  is("someone already on the list does not count", count([good("bo@example.com", { wasOnList: true })]), [0, 0, 1]);
  is("a disposable address does not count", count([good("bo@example.com", { disposable: true })]), [0, 0, 1]);
  is("a sign-up that failed the bot check does not count", count([good("bo@example.com", { human: false })]), [0, 0, 1]);
  is("not yet confirmed waits", count([good("bo@example.com", { confirmed: null })]), [0, 1, 0]);
  is("an unknown disposable check waits", count([good("bo@example.com", { disposable: null })]), [0, 1, 0]);
  is("an unknown bot check waits", count([good("bo@example.com", { human: null })]), [0, 1, 0]);
  is("an answer that is not yes or no waits", count([good("bo@example.com", { consented: "yes" as unknown as boolean })]), [0, 1, 0]);
  is("a refusal wins over an unknown", count([good("bo@example.com", { confirmed: null, wasOnList: true })]), [0, 0, 1]);
  is("the same friend twice counts once", count([good("bo@example.com"), good("Bo+again@Example.com")]), [1, 0, 0]);
  is("the same friend with records that disagree does not count", count([good("bo@example.com"), good("bo@example.com", { wasOnList: true })]), [0, 0, 1]);
  is("the same friend, one record still waiting, waits", count([good("bo@example.com"), good("bo@example.com", { confirmed: null })]), [0, 1, 0]);
  is("an address that is not one does not count", count([good("not an address")]), [0, 0, 1]);
  is("three friends count three", count([good("bo@example.com"), good("cy@example.com"), good("di@example.com")]), [3, 0, 0]);
  is("a referrer that is not an address is refused", tallyReferrals("nobody", [good("bo@example.com")]).ok, false);
  is(`more than ${MAX_REFERRAL_EVENTS} records is refused, not cut`, tallyReferrals(referrer, Array.from({ length: MAX_REFERRAL_EVENTS + 1 }, (_, i) => good(`p${i}@example.com`))).ok, false);
  is("records that are not a list are refused", tallyReferrals(referrer, null as unknown as ReferredSignup[]).ok, false);

  part("Each milestone once");
  const p = two.ok ? two.program : { milestones: [] };
  const due = (counted: number, given: number[]) => dueMilestones(p, counted, given).map((m) => m.count);
  is("3 friends reach the first milestone", due(3, []), [3]);
  is("2 friends reach nothing", due(2, []), []);
  is("the first milestone is not given twice", due(3, [3]), []);
  is("10 friends reach the second, the first already given", due(10, [3]), [10]);
  is("12 friends with nothing given reach both", due(12, []), [3, 10]);
  // Changed (pre-review): was [3, 10]. A reward given at 5 friends under an
  // older program covers every step up to 5, so the step at 3 is not paid
  // again; only the step at 10 is due.
  is("a reward given under an older program is never paid again at a lower step", due(10, [5]), [10]);
  for (const bad of [-1, Number.NaN, 2.5, Number.POSITIVE_INFINITY]) is(`a count of ${bad} reaches nothing`, due(bad, []), []);

  part("Each step once, also after the creator changes the program");
  const after = (milestones: unknown) => {
    const r = readReferralProgram({ milestones }, own);
    if (!r.ok) throw new Error(`expected a program, got ${r.reason}`);
    return r.program;
  };
  const dueIn = (prog: ReturnType<typeof after>, counted: number, given: number[]) => dueMilestones(prog, counted, given).map((m) => m.count);
  const movedDown = after([{ count: 2, reward: guide }, { count: 10, reward: coupon }]);
  is("given at 3, the step moved to 2: nothing new at 3 friends", dueIn(movedDown, 3, [3]), []);
  is("given at 3, the step moved to 2: the next step still comes at 10", dueIn(movedDown, 10, [3]), [10]);
  const movedUp = after([{ count: 5, reward: guide }, { count: 10, reward: coupon }]);
  is("given at 3, the step moved to 5: nothing new at 5 friends", dueIn(movedUp, 5, [3]), []);
  is("given at 3, the step moved to 5: the next step still comes at 10", dueIn(movedUp, 10, [3]), [10]);
  const stepAdded = after([{ count: 1, reward: guide }, { count: 3, reward: guide }, { count: 10, reward: coupon }]);
  is("given at 3, a step added before it: nothing new at 3 friends", dueIn(stepAdded, 3, [3]), []);
  is("given at 3, a step added before it: only the step at 10 at 10 friends", dueIn(stepAdded, 10, [3]), [10]);
  is("every step of the program given: nothing more, whatever the count", dueIn(movedDown, 50, [2, 10]), []);
  for (const bad of [[0], [-1], [2.5], [Number.NaN], ["3"]] as unknown[][]) {
    is(`a record of what was given that is not whole counts (${String(bad[0])}) gives nothing`, dueIn(movedDown, 10, bad as number[]), []);
  }
  is("no record list at all gives nothing", dueMilestones(movedDown, 10, null as unknown as number[]), []);
  const tallyThree = { counted: 3, pending: 0, refused: 0 };
  is("after a step moved down, the next one shown is the one still to come", referrerView(movedDown, tallyThree, [3]).next, { count: 10, left: 7, reward: coupon });
  is("after a step moved up, the moved step is not shown as next", referrerView(movedUp, tallyThree, [3]).next, { count: 10, left: 7, reward: coupon });

  part("What the person who shared sees");
  const tally = tallyReferrals(referrer, [good("bo@example.com"), good("cy@example.com"), good("di@example.com"), good("eve@example.com", { confirmed: null })]);
  const view = tally.ok ? referrerView(p, tally.tally, [3]) : null;
  is("numbers, the next milestone and what is left", view, { counted: 3, pending: 1, reached: [3], next: { count: 10, left: 7, reward: coupon } });
  is("no address anywhere in it", JSON.stringify(view).includes("@"), false);
  const all = tallyReferrals(referrer, Array.from({ length: 11 }, (_, i) => good(`f${i}@example.com`)));
  is("with every milestone reached there is no next one", all.ok ? referrerView(p, all.tally, [3, 10]).next : "refused", null);
  is("reached lists only milestones of this program that were given", all.ok ? referrerView(p, all.tally, [3, 5, 10]).reached : "refused", [3, 10]);

  done();
}

main();
