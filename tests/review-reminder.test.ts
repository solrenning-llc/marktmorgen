/**
 * 636 [GL4](a): one optional reminder of the email that asks for a review
 * (lib/review-ask.ts, lib/review-requests.ts). The setting is 3 to 14 days or
 * none, and survives storage; an order is due for the first email, then for
 * the one reminder only when the creator chose it, and never a third; after
 * the first goes out the order waits on the list for its reminder's day, or
 * leaves it; the first email says the reminder will come and the reminder
 * says it is the last, in every language; the studio and the route offer
 * and hold the same bounds. The rest of the job (refund, stop, list, already
 * reviewed, allowance) is the same code as the first email's.
 */
import { readFileSync } from "node:fs";
import { MAX_AGAIN_DAYS, MIN_AGAIN_DAYS, againDueAt, dueAt, parseReviewAsk, readAgain } from "@/lib/review-ask";
import { afterSent, askStage, requestText } from "@/lib/review-requests";
import { GIVING_WORDS } from "@/lib/buyer-words/giving";
import { claimHandle, setReviewAsk, storeForEmail, type Store } from "@/lib/store";
import { store as redis } from "./redis-stub";
import { done, is, part } from "./check";

const DAY = 86_400;

async function main(): Promise<void> {
  redis.clear();
  part("The setting");
  is("3 to 14 days", [MIN_AGAIN_DAYS, MAX_AGAIN_DAYS], [3, 14]);
  is("in range: kept", [readAgain(3), readAgain(14)], [3, 14]);
  is("out of range or not whole: none", [readAgain(2), readAgain(15), readAgain(4.5), readAgain("7"), readAgain(null)], [0, 0, 0, 0, 0]);
  is("read with the rest", parseReviewAsk({ days: 7, again: 5 }), { days: 7, again: 5 });
  is("a store saved before it existed has none", parseReviewAsk({ days: 7 }), { days: 7 });
  const owner = "reminder@example.com";
  await claimHandle(owner, "remindshop", "Remind Shop", "");
  await setReviewAsk(owner, { days: 7, again: 5 });
  is("kept by the store", (await storeForEmail(owner))?.reviewAsk, { days: 7, again: 5 });

  part("Which email an order is due for");
  is("never asked: the first", askStage(null, 5), "first");
  is("asked, with a reminder chosen: the reminder", askStage("sent", 5), "again");
  is("asked, no reminder: nothing", askStage("sent", 0), null);
  is("reminded already: nothing, ever", askStage("again", 5), null);
  is("being sent this moment: nothing", askStage("sending", 5), null);
  is("the reminder's day: the first's day plus its days", againDueAt(1_800_000_000, 7, 5), dueAt(1_800_000_000, 7) + 5 * DAY);

  part("What is written once a batch went out");
  const first = { reference: "cs_test_aaaaaaaaaaaa", member: "m1", paidAt: 1_800_000_000, stage: "first" as const };
  const again = { reference: "cs_test_bbbbbbbbbbbb", member: "m2", paidAt: 1_800_000_000, stage: "again" as const };
  const withReminder = afterSent([first, again], { days: 7, again: 5 });
  is("the first is marked sent; the reminder, again", withReminder.filter((c) => c[0] === "SET").map((c) => c[2]), ["sent", "again"]);
  is("the first waits on the list for its reminder's day", withReminder.find((c) => c[0] === "ZADD"), ["ZADD", "nl:rev:ask:due", "XX", againDueAt(first.paidAt, 7, 5), "m1"]);
  is("nothing leaves the list then", withReminder.some((c) => c[0] === "ZREM"), false);
  const without = afterSent([first], { days: 7 });
  is("no reminder: the first leaves the list", without.find((c) => c[0] === "ZREM"), ["ZREM", "nl:rev:ask:due", "m1"]);
  is("…and nothing is put back", without.some((c) => c[0] === "ZADD"), false);
  is("only reminders: nothing to take off (already taken when claimed)", afterSent([again], { days: 7, again: 5 }).some((c) => c[0] === "ZREM" || c[0] === "ZADD"), false);

  part("The words");
  const store = (await storeForEmail(owner)) as Store;
  const link = "https://marktmorgen.com/@remindshop/review?ask=x";
  const firstText = requestText(store, ["Sourdough course"], 1_800_000_000, link);
  is("the first says the reminder will come", firstText.body.includes("you get one reminder, and that is the last email about it"), true);
  is("…and not that it is the only one", firstText.body.includes("This is the only email"), false);
  const reminderText = requestText(store, ["Sourdough course"], 1_800_000_000, link, "again");
  is("the reminder's subject says it is one", reminderText.subject, "A reminder: how is Sourdough course?");
  is("the reminder says it is the last", reminderText.body.endsWith("This is the last email about reviewing this order."), true);
  is("the reminder carries the same review link", reminderText.body.includes(link), true);
  is("no reminder chosen: the first says it is the only one", requestText({ ...store, reviewAsk: { days: 7 } }, ["Sourdough course"], 1_800_000_000, link).body.includes("This is the only email about reviewing this order."), true);
  for (const [lang, w] of Object.entries(GIVING_WORDS)) {
    is(`${lang}: the reminder's words are its own`, [w.againSubject("X"), w.againLead("X", "S", "D"), w.againOnly, w.askOneMore(5)].every((line) => line.length > 10 && !line.includes("undefined")), true);
    if (lang !== "en") is(`${lang}: translated`, w.againOnly !== GIVING_WORDS.en.againOnly, true);
  }
  for (const word of ["now", "hurry", "last chance", "reward", "discount", "free"]) {
    is(`no pressure or incentive word "${word}" in the English reminder`, reminderText.body.toLowerCase().includes(` ${word} `), false);
  }

  part("Studio and route");
  const studio = readFileSync("components/review-studio.tsx", "utf8");
  const route = readFileSync("app/api/store/reviews/route.ts", "utf8");
  is("the studio offers no reminder or 3 to 14 days, labeled, with its note", studio.includes('htmlFor="ask-again"') && studio.includes("No reminder") && studio.includes('aria-describedby="ask-again-note"'), true);
  is("the route refuses anything else", route.includes('readAgain(asked) === 0) return Response.json({ ok: false, error: "again" }'), true);
  done();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
