/**
 * What a closing store's notices say of its members (lib/plan-closing.ts,
 * closingNews and closingLetter), when what was written down can be read and
 * when it cannot.
 *
 * Audit SG2, finding 15: a read that failed was turned into "0 members not
 * paused" and "no member paid past the day", so the notice told the creator
 * nothing was left to do about a figure nobody had. What fails here:
 *
 *   - an unknown count written as zero, or left out as if it were zero;
 *   - a notice that does not say, in plain words, that it could not check,
 *     and what the creator should do meanwhile;
 *   - an answer in a shape we do not expect taken as a count;
 *   - a known count, none or some, no longer said as it was.
 *
 * Against the Redis stand-in only; nothing real is reached.
 */
import { holdCounts, paidKey, savePaidPeriod, workKey } from "@/lib/closing-holds";
import * as planClosing from "@/lib/plan-closing";
import { type ClosingNews, closingLetter, closingNews, closingOf, removalDay } from "@/lib/plan-closing";
import { claimHandle, storeFolder, storeForEmail, storeRef } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 24 * 60 * 60 * 1000;
const S = (ms: number) => Math.floor(ms / 1000);

type Commands = (string | number)[][];
const realPipeline = redis.pipeline.bind(redis);
/** Makes every Redis call that matches `refuse` throw, as an unreachable database does. */
function failing(refuse: (commands: Commands) => boolean): void {
  redis.pipeline = (async (commands: Commands) => {
    if (refuse(commands)) throw new Error("Redis request failed with status 503");
    return realPipeline(commands);
  }) as typeof redis.pipeline;
}
const working = () => {
  redis.pipeline = realPipeline as typeof redis.pipeline;
};

/** Runs `work` with console.error kept quiet, counting what it said. */
async function quietly<T>(work: () => Promise<T>): Promise<{ answer: T; complaints: number }> {
  const real = console.error;
  let complaints = 0;
  console.error = () => {
    complaints += 1;
  };
  try {
    return { answer: await work(), complaints };
  } finally {
    console.error = real;
  }
}

const UNKNOWN_HOLDS = "We could not check just now whether every membership's payments are paused.";
const UNKNOWN_MEMBERS = "We could not check just now which members paid for time after";
/**
 * What the closing day does with the time members paid for past it
 * (giveBackUnused, lib/closing-refunds.ts): it tries a refund only for the
 * members whose last payment was written down when their payments were
 * paused, from the creator's balance, within the closing's limit. These are
 * the sentences that say so, and no more.
 */
/** Every reason a refund may not go through on the day (balance, limit, a disputed payment, one Stripe names no payment for), without a list that leaves one out. */
const NOT_MADE = "Some refunds may not go through (for example, when your Stripe balance is too low): after that day, please check your Stripe account and refund what is left yourself.";
/** Right for one member and for many. */
const TRY_KNOWN = "we try to refund the unused part of each member's last payment, from your own Stripe account.";
const TRY_UNKNOWN = "we try to refund, from your own Stripe account, the unused part of the last payment of each member whose payments we paused.";
const SOONER = "You can refund it sooner, after checking each amount, from your studio. Marktmorgen never pays it and never takes it.";
const NOT_PAUSED_REFUND = "may not be refunded for you: after that day, please check each of them in Stripe and refund that time yourself.";
const NOT_PAUSED_ONE = "What this member paid for after";
const NOT_PAUSED_ONE_END = "may not be refunded for you: after that day, please check their membership in Stripe and refund that time yourself.";
const UNKNOWN_PAUSED_REFUND = "For a member whose payments were not paused, what they paid for after";
const UNKNOWN_PAUSED_REFUND_END = "may not be refunded for you: after that day, please check your members in Stripe and refund that time yourself.";
/** The promise the code does not keep: every member given back, whatever the balance, the limit or the hold. */
const OVERPROMISE = /is given back the unused part/;

async function main(): Promise<void> {
  redis.clear();
  const now = Date.now();
  const endedAt = now - 2 * DAY;
  const day = removalDay(endedAt);
  await claimHandle("nora@example.com", "nora", "Nora Shop", "");
  const nora = await storeForEmail("nora@example.com");
  if (!nora) throw new Error("the test store was not made");
  const folder = await storeFolder(storeRef(nora));
  const letterOf = (news: ClosingNews) => closingLetter("ended", nora.name, endedAt, day, now, news).text;

  part("Known counts are said as they were");
  {
    const news = await closingNews(nora, endedAt, day, 0);
    is("nothing written down reads as none, known", [news.members, news.unused, news.notHeld, news.overLimit], [0, "", 0, 0]);
    const text = letterOf(news);
    is(
      "a known none says neither the counts nor that it could not check",
      [text.includes("paid for time after"), text.includes("not paused"), text.includes("could not check")],
      [false, false, false],
    );

    await savePaidPeriod(nora, "sub_member0001", { inv: "in_member0001", amt: 3000, cur: "usd", ps: S(day - 15 * DAY), pe: S(day + 15 * DAY), e: "member@buyers.example.com" });
    await redis.pipeline([["HSET", workKey(folder), "f:sub_member0002", "1"]]);
    const some = await closingNews(nora, endedAt, day, 0);
    is("a member past the day and one not paused, known", [some.members, some.unused, some.notHeld, some.overLimit], [1, "$15", 1, 0]);
    const said = letterOf(some);
    is(
      "the notice says both, as before, and not that it could not check",
      [said.includes("1 member has paid for time after"), said.includes(": $15 in all."), said.includes("1 membership's payments are not paused yet: we try again every day."), said.includes("could not check")],
      [true, true, true, false],
    );
    is(
      "it says only the refund the closing day tries, when it is not made, and what the creator does",
      [said.includes(TRY_KNOWN), said.includes(NOT_MADE), said.includes(SOONER), said.includes(NOT_PAUSED_ONE) && said.includes(NOT_PAUSED_ONE_END), OVERPROMISE.test(said)],
      [true, true, true, true, false],
    );
    // One past the closing's limit too: still told to refund that time from Stripe.
    const over = letterOf({ ...some, notHeld: 0, overLimit: 2 });
    is("members past the closing's limit: refunded by the creator, not promised", [over.includes("2 memberships' payments are not paused: past this closing's limit."), over.includes("What these members paid for after") && over.includes(NOT_PAUSED_REFUND)], [true, true]);
  }

  part("A hold that cannot be read is said to be unchecked, never as none");
  {
    failing((commands) => commands.some((c) => c[0] === "HKEYS" && c[1] === workKey(folder)));
    const { answer: news, complaints } = await quietly(() => closingNews(nora, endedAt, day, 0));
    working();
    is("the hold's counts are unknown, not 0", [news.notHeld, news.overLimit], [null, null]);
    is("the members past the day are still read", [news.members, news.unused], [1, "$15"]);
    is("the failure is logged", complaints > 0, true);
    const text = letterOf(news);
    is(
      "the notice says it could not check, and what to do",
      [text.includes(UNKNOWN_HOLDS), text.includes(`If a member is charged before then, please refund them from Stripe.`), /\b0 membership/.test(text), text.includes("not paused yet")],
      [true, true, false, false],
    );
    is("and that the time a member not paused paid for past the day is theirs to refund", [text.includes(UNKNOWN_PAUSED_REFUND), text.includes(UNKNOWN_PAUSED_REFUND_END)], [true, true]);
  }

  part("Members past the day that cannot be read are said to be unchecked, never as none");
  {
    failing((commands) => commands.some((c) => c[0] === "HGETALL" && c[1] === paidKey(folder)));
    const { answer: news, complaints } = await quietly(() => closingNews(nora, endedAt, day, 0));
    working();
    is("the members past the day are unknown, not 0", [news.members, news.unused], [null, ""]);
    is("the hold is still read", [news.notHeld, news.overLimit], [1, 0]);
    is("the failure is logged", complaints > 0, true);
    const text = letterOf(news);
    is(
      "the notice says it could not check, and what happens on the day",
      [
        text.includes(UNKNOWN_MEMBERS),
        text.includes(TRY_UNKNOWN),
        text.includes(NOT_MADE),
        text.includes("Marktmorgen never pays it and never takes it."),
        /\b0 members?\b/.test(text),
        text.includes("member has paid for time after"),
        OVERPROMISE.test(text),
        // The studio's refund page shows no row when this read fails, so the creator is sent to Stripe, not there.
        text.includes(SOONER),
      ],
      [true, true, true, true, false, false, false, false],
    );
  }

  part("Nothing can be read at all: the notice still goes, saying both are unchecked");
  {
    failing(() => true);
    const { answer: news } = await quietly(() => closingNews(nora, endedAt, day, 3, true));
    working();
    is("both are unknown, the rest as given", [news.members, news.notHeld, news.overLimit, news.untold, news.capped], [null, null, null, 3, true]);
    const text = letterOf(news);
    is("the notice says both could not be checked", [text.includes(UNKNOWN_HOLDS), text.includes(UNKNOWN_MEMBERS)], [true, true]);
  }

  part("An answer in a shape we do not expect is never a count");
  {
    const readHoldCounts = (planClosing as Record<string, unknown>).readHoldCounts as ((value: unknown) => unknown) | undefined;
    const readUnusedSummary = (planClosing as Record<string, unknown>).readUnusedSummary as ((value: unknown) => unknown) | undefined;
    is("both readers are there", [typeof readHoldCounts, typeof readUnusedSummary], ["function", "function"]);
    if (readHoldCounts && readUnusedSummary) {
      is(
        "the hold: only two whole counts at or above zero",
        [null, undefined, "2", {}, { failed: 1 }, { failed: "1", over: 0 }, { failed: -1, over: 0 }, { failed: 1.5, over: 0 }, { failed: Number.NaN, over: 0 }, { failed: 2, over: 1 }].map(readHoldCounts),
        [null, null, null, null, null, null, null, null, null, { failed: 2, over: 1 }],
      );
      is(
        "members past the day: a count with one money total per currency",
        [
          null,
          { members: 0 },
          { members: 2, totals: [] },
          { members: 0, totals: [{ cur: "usd", amount: 500 }] },
          { members: 1, totals: [{ cur: "usd", amount: Number.NaN }] },
          { members: 1, totals: [{ cur: "usd", amount: -5 }] },
          { members: 1, totals: [{ cur: "", amount: 500 }] },
          { members: -1, totals: [] },
          { members: 2, totals: [{ cur: "usd", amount: 1500 }, { cur: "usd", amount: 1000 }] },
          { members: 2, totals: [{ cur: "usd", amount: 1500 }, { cur: "USD", amount: 1000 }] },
          { members: 1, totals: [{ cur: "usd", amount: 1500 }, { cur: "eur", amount: 1000 }] },
          { members: 0, totals: [] },
          { members: 2, totals: [{ cur: "usd", amount: 1500 }, { cur: "eur", amount: 4000 }] },
        ].map(readUnusedSummary),
        [null, null, null, null, null, null, null, null, null, null, null, { members: 0, unused: "" }, { members: 2, unused: "$15 and €40" }],
      );
    }
    // What the real readers answer today is a shape these take.
    is("the hold as holdCounts answers it is read", readHoldCounts?.(await holdCounts(folder)), { failed: 1, over: 0 });
  }

  part("A break that cannot be read is not 'not closing' (closingOf)");
  {
    redis.clear();
    const ended = { ...nora, planEndedAt: new Date(endedAt).toISOString() };
    const known = await closingOf(ended, now);
    is("with no break written down, the store is closing on its day", known?.endedAt, endedAt);
    // The break is read by one Redis script (lib/plan-pause.ts, PAUSE_OBSERVATION).
    failing((commands) => commands.some((c) => c[0] === "EVAL"));
    const failed = await closingOf(ended, now).then(() => "answered", (error: unknown) => (error instanceof Error ? "threw" : "threw something"));
    working();
    is("a break that could not be read throws, never answers 'not closing'", failed, "threw");
    redis.pipeline = (async (commands: Commands) => (commands.some((c) => c[0] === "EVAL") ? [[-1]] : realPipeline(commands))) as typeof redis.pipeline;
    const odd = await closingOf(ended, now).then(() => "answered", () => "threw");
    working();
    is("a break answered in a shape we do not expect throws too", odd, "threw");
  }

  part("The whole letter in each state of the hold: 'nobody is charged again' only when every one is known to be paused");
  {
    // Codex G's review of #2554: holdCharges finishes (done) with members it
    // could not pause or did not reach, who stay chargeable; the same letter
    // must not then say none is charged again.
    const at = Date.UTC(2026, 10, 1, 12);
    const closes = removalDay(at);
    const on = new Date(closes).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
    const lines = (hold: Pick<ClosingNews, "notHeld" | "overLimit">) => closingLetter("ended", "Rita Shop", at, closes, at, { buyersBy: null, untold: 0, members: 0, unused: "", ...hold }).text.split("\n");
    const PROMISE = "Since your plan ended, none of your members is charged again, and they keep their access.";
    const ACCESS = "Your members keep their access until your store closes.";
    const paused = lines({ notHeld: 0, overLimit: 0 });
    is("every one paused: the fourth line says none is charged again, once", [paused[3], paused.filter((l) => l === PROMISE).length], [PROMISE, 1]);
    is("every one paused: no line about memberships not paused or unchecked", paused.some((l) => /not paused|could not check|refund them from Stripe/.test(l)), false);
    // Every other state is that same letter, word for word, but for the fourth line and the hold's own lines before "We keep no copy".
    const sales = paused.indexOf("We keep no copy of your sales: every sale, refund and payout is on your own Stripe");
    is("the letter has its sales paragraph", sales > 4, true);
    const expected = (hold: string[]) => [...paused.slice(0, 3), ACCESS, ...paused.slice(4, sales), ...hold, "", ...paused.slice(sales)];
    is(
      "some not paused (one could not be paused, one past the limit): the whole letter",
      lines({ notHeld: 1, overLimit: 1 }),
      expected([
        "2 memberships' payments are not paused yet: we try again every day, and some are past this closing's limit.",
        `Every one of them ends on ${on}. If a member is charged before then, please refund them from Stripe.`,
        `What these members paid for after ${on} may not be refunded for you: after that day, please check each of them in Stripe and refund that time yourself.`,
      ]),
    );
    is(
      "one not paused: the whole letter",
      lines({ notHeld: 1, overLimit: 0 }),
      expected([
        "1 membership's payments are not paused yet: we try again every day.",
        `Every one of them ends on ${on}. If a member is charged before then, please refund them from Stripe.`,
        `What this member paid for after ${on} may not be refunded for you: after that day, please check their membership in Stripe and refund that time yourself.`,
      ]),
    );
    const unchecked = [
      "We could not check just now whether every membership's payments are paused.",
      `Every membership ends on ${on}. If a member is charged before then, please refund them from Stripe.`,
      `For a member whose payments were not paused, what they paid for after ${on} may not be refunded for you: after that day, please check your members in Stripe and refund that time yourself.`,
    ];
    is("the hold could not be read: the whole letter", lines({ notHeld: null, overLimit: null }), expected(unchecked));
    is("one count read and the other not: the same as unread", lines({ notHeld: 0, overLimit: null }), expected(unchecked));
    is("no news about the hold at all: no promise either", closingLetter("ended", "Rita Shop", at, closes, at).text.includes(PROMISE), false);
  }

  part("The letter on its own: an unknown is never printed as a number");
  {
    const text = letterOf({ buyersBy: null, untold: 0, members: null, unused: "", notHeld: null, overLimit: null });
    is("both unknown lines, no count", [text.includes(UNKNOWN_HOLDS), text.includes(UNKNOWN_MEMBERS), /\bnull\b|\bundefined\b|\bNaN\b/.test(text)], [true, true, false]);
  }

  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
