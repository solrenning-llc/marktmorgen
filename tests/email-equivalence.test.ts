import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { WEEKLY_SENDS_IN_LONGEST_MONTH, emailEquivalence, weeklyReach, weeklyReachShort } from "@/lib/email-equivalence";
import { PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS, TIERS, TRIAL_MONTHLY_EMAILS, monthlyEmails } from "@/lib/plan";

test("a weekly email reaches the allowance divided by the longest month's five sends, never more", () => {
  // Every month from 2026 to 2035: the most times one weekday comes round is five.
  let most = 0;
  for (let year = 2026; year < 2036; year += 1) {
    for (let month = 0; month < 12; month += 1) {
      const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
      for (let weekday = 0; weekday < 7; weekday += 1) {
        let count = 0;
        for (let day = 1; day <= days; day += 1) if (new Date(Date.UTC(year, month, day)).getUTCDay() === weekday) count += 1;
        most = Math.max(most, count);
      }
    }
  }
  assert.equal(most, WEEKLY_SENDS_IN_LONGEST_MONTH);
  for (const allowance of [TRIAL_MONTHLY_EMAILS, PRO_MONTHLY_EMAILS, SCALE_MONTHLY_EMAILS, ...TIERS.map(monthlyEmails), 1, 4, 5, 6, 9_999]) {
    const people = weeklyReach(allowance);
    assert.ok(people * WEEKLY_SENDS_IN_LONGEST_MONTH <= allowance, `${allowance}`);
    assert.ok((people + 1) * WEEKLY_SENDS_IN_LONGEST_MONTH > allowance, `${allowance}`);
  }
  for (const none of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(emailEquivalence(none), "");
});

test("each plan's sentence follows its own limit, so a changed limit changes the sentence", () => {
  assert.equal(emailEquivalence(PRO_MONTHLY_EMAILS), `That is one email a week to as many as ${Math.floor(PRO_MONTHLY_EMAILS / 5).toLocaleString("en-US")} people, in any month.`);
  assert.equal(emailEquivalence(7_000), "That is one email a week to as many as 1,400 people, in any month.");
  assert.equal(emailEquivalence(10_000), "That is one email a week to as many as 2,000 people, in any month.");
  assert.equal(emailEquivalence(300), "That is one email a week to as many as 60 people, in any month.");
  assert.equal(emailEquivalence(5), "That is one email a week to as many as 1 person, in any month.");
  assert.equal(emailEquivalence(4), "");
  for (const tier of TIERS) {
    const sentence = emailEquivalence(monthlyEmails(tier));
    if (monthlyEmails(tier) === 0) assert.equal(sentence, "");
    else assert.ok(sentence.includes(Math.floor(monthlyEmails(tier) / 5).toLocaleString("en-US")));
  }
});

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(path).isDirectory() ? files(path) : /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

test("the studio shows the sentence from the code, and nobody types one by hand", () => {
  const studio = readFileSync("components/email-studio.tsx", "utf8");
  assert.match(studio, /!props\.trial && emailEquivalence\(props\.allowance\)/);
  assert.doesNotMatch(studio, /starts again on the first of the month/);
  assert.match(studio, /emailEquivalence\(props\.moveUp\.emails\)/);
  assert.match(readFileSync("app/studio/email/page.tsx", "utf8"), /emailEquivalence\(PRO_MONTHLY_EMAILS\)/);
  // 459 [EL3] unit 2: the pricing cards carry the short form beside each plan's number.
  assert.match(readFileSync("components/home-parts.tsx", "utf8"), /list emails a month: \$\{weeklyReachShort\(emails\)\}/);
  assert.equal(weeklyReachShort(7_000), "one a week to as many as 1,400 people");
  assert.equal(weeklyReachShort(0), "");
  const typed = ["app", "components", "lib"].flatMap(files).filter((path) => path !== join("lib", "email-equivalence.ts") && /a week to as many as|Enough to email/.test(readFileSync(path, "utf8")));
  assert.deepEqual(typed, []);
});
