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
 *     typed, differs between people and stores, and never shows the address;
 *   - only a confirmed, consenting, still subscribed sign-up by someone new,
 *     not disposable and past the bot check, counts; anything unknown waits
 *     and never counts; signing up yourself never counts;
 *   - each milestone is given once;
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
const SECRET = "s".repeat(32);

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
  is("case, spaces, a +tag and Gmail dots are the same person", referralAddress("  Ana.B+news@GoogleMail.com "), "anab@gmail.com");
  is("a +tag elsewhere is the same person", referralAddress("ana+x@example.com"), "ana@example.com");
  is("dots outside Gmail are kept", referralAddress("a.b@example.com"), "a.b@example.com");
  for (const bad of ["no-at", "a@b@c.com", "@example.com", "+tag@example.com", "a@", "a b@example.com", "a@exa mple.com", `${"a".repeat(250)}@example.com`, "a@example"]) {
    is(`"${bad.slice(0, 24)}" is not an address`, referralAddress(bad), null);
  }

  part("The personal code");
  const ana = referralCode(SECRET, "store_1", "ana@example.com");
  is("the code has the code shape", typeof ana === "string" && REFERRAL_CODE.test(ana), true);
  is("the same person typed differently gets the same code", referralCode(SECRET, "store_1", " ANA+promo@Example.com"), ana);
  is("another person gets another code", referralCode(SECRET, "store_1", "bo@example.com") === ana, false);
  is("the same person at another store gets another code", referralCode(SECRET, "store_2", "ana@example.com") === ana, false);
  is("another secret gives another code", referralCode("t".repeat(32), "store_1", "ana@example.com") === ana, false);
  is("the code never shows the address", typeof ana === "string" && !ana.toLowerCase().includes("ana") && !ana.includes("@"), true);
  is("a short secret gives no code", referralCode("short", "store_1", "ana@example.com"), null);
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
  is("a milestone the creator has since removed is ignored", due(10, [5]), [3, 10]);
  for (const bad of [-1, Number.NaN, 2.5, Number.POSITIVE_INFINITY]) is(`a count of ${bad} reaches nothing`, due(bad, []), []);

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
