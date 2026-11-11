/**
 * The help answer about refunds of the Marktmorgen plan says what the refund
 * policy says and where the button is (305 [SY1], complement
 * C1-20261105-1919-C4-1).
 *
 * #1499 put the owner's guarantee of 31 October 2026, 15h41 (every plan
 * payment within REFUND_DAYS of the first one, once per person, never more
 * than was paid) into app/refunds, app/terms and app/mission. The help center
 * still said only the first payment came back and that "a renewal is not
 * refunded", which a renewal inside those days now is, and it never named
 * the studio's "Refund my payment". These checks hold the help answer to the
 * policy page's own words and to the button the studio draws.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { helpAnswer } from "@/lib/help-content";
import { REFUND_DAYS } from "@/lib/plan";
import { done, is, part } from "./check";

const root = process.cwd();
const policy = readFileSync(join(root, "app/refunds/page.tsx"), "utf8").replace(/\s+/g, " ");
const studio = readFileSync(join(root, "app/studio/page.tsx"), "utf8");
const answer = helpAnswer("What about refunds on the Marktmorgen subscription itself?");

part("The guarantee, in the policy's words");
is("no longer only the first payment", answer.includes("Your first payment to us is refunded in full"), false);
is("no longer says a renewal is never refunded", /a renewal is not refunded/.test(answer), false);
is(`within ${REFUND_DAYS} days of the first payment, it and every plan payment since for the same store`, answer.includes(`Within ${REFUND_DAYS} days of your first payment, it and every plan payment since for the same store are refunded in full`), true);
is("and the policy page says the same", policy.includes(`Within \${REFUND_DAYS} days of your first payment, it and every plan payment since for the same store refunded in full`), true);
is("once per person, as the policy says", [answer.includes("once per person"), policy.includes("given once per person")], [true, true]);
is("never more than was paid", answer.includes("never more than you paid"), true);
is("later charges after those days, as section 5 says", answer.includes(`After those ${REFUND_DAYS} days, a monthly renewal, a charge for switching plans and any other later charge are not refunded, except where applicable consumer law requires it`), true);
is("and section 5 says it", policy.includes("a monthly renewal, a charge made when you switch plans and any other later charge are not refunded, except where applicable consumer law requires it"), true);
is("a yearly plan's months not yet started, less Stripe's card fee", answer.includes("A yearly plan is refunded at any time for the months you have not started"), true);

part("Where to ask");
is("the studio, under What you pay us, Refund my payment", answer.includes(`In your studio, under "What you pay us", choose "Refund my payment"`), true);
is("the studio draws that link", studio.includes("Refund my payment"), true);
is("the policy names the same place", policy.includes("Under &ldquo;What you pay us,&rdquo; choose &ldquo;Refund my payment.&rdquo;"), true);
is("a review page before anything changes", answer.includes("before anything changes"), true);
is("email stays for whoever cannot use the button", answer.includes("support@marktmorgen.com"), true);
is("and the policy page is linked by name", answer.includes("refund policy page"), true);

part("Plain words");
const sentences = answer.split(/(?<=[.!?])\s+/);
is("no sentence over 40 words", sentences.filter((s) => s.split(/\s+/).length > 40), []);

done();
